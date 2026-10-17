// Outbound SMS — staff reply to a person from the Inbox.
// Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// SECURITY: uses the service-role key, so the caller is verified here (same pattern as
// invite-staff.js). The recipient is NEVER taken from the request: it is resolved server-side
// from the alert's enrolled person, so a caller can't use this endpoint to text arbitrary numbers.
// Caller must be staff (role admin/staff/support) of the alert's organization, or a global admin.
//
// Request:  POST { item_id, body, template_id? }  + Authorization: Bearer <supabase session token>
// Response: 200 { ok:true, message_id, sid } | 4xx/5xx { error, code? }
//
// Sends from the org's own Twilio number (organizations.twilio_number); if
// TWILIO_MESSAGING_SERVICE_SID is set it is preferred. Delivery receipts come back to sms-status.js.

const { checkTwilioSignature, baseUrl } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');


const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const { getMessageProvider } = require('../../src/server/providers/index.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');
const { getStaffAuthProvider } = require('../../src/server/auth/authProvider.cjs');

const SENDER_ROLES = ['admin', 'sender', 'operator'];
const MAX_BODY = 1600; // Twilio's hard limit per message

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // --- who is calling? ---
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization header.' });
  const verified = await getStaffAuthProvider(supabase).verify(token);
  if (!verified.ok) return json(401, { error: 'Invalid or expired session.' });
  const callerAuth = { user: { id: verified.identity.key } };

  const { data: caller } = await supabase
    .from('operators')
    .select('id, organization_id, role, is_platform_admin')
    .eq('user_id', callerAuth.user.id)
    .maybeSingle();
  if (!caller) return json(403, { error: 'No staff profile for this account.' });
  const rl = await rateLimit(supabase, `send-sms:${caller.id}`, 60, 60);
  if (!rl.ok) return tooMany(rl);

  // --- input ---
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const { item_id, template_id } = payload;
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!item_id) return json(400, { error: 'item_id is required.' });
  if (!body) return json(400, { error: 'Message cannot be empty.' });
  if (body.length > MAX_BODY) return json(400, { error: `Message is too long (max ${MAX_BODY} characters).` });

  // --- resolve alert, org, and recipient server-side ---
  const { data: alert } = await supabase
    .from('inbox_items')
    .select('id, organization_id, status, person_id, organizations ( twilio_number ), people ( id, mobile_phone, sms_opted_out )')
    .eq('id', item_id)
    .maybeSingle();
  if (!alert) return json(404, { error: 'Alert not found.' });

  const sameOrg = caller.organization_id && caller.organization_id === alert.organization_id;
  if (!caller.is_platform_admin && !(sameOrg && SENDER_ROLES.includes(caller.role))) {
    return json(403, { error: 'You do not have permission to send messages for this alert.' });
  }

  // PostgREST returns a single object for many-to-one joins, but normalize in case it's an array.
  const one = (x) => (Array.isArray(x) ? x[0] : x);
  const org = one(alert.organizations);
  const person = one(alert.people);

  if (!org?.twilio_number) return json(400, { error: "This organization has no Twilio number configured." });
  if (!person?.mobile_phone) return json(400, { error: 'No phone number on file for this person.' });
  if (person.sms_opted_out) {
    return json(409, { error: 'This person has opted out of texts (replied STOP). Call them instead, or wait for them to text START.', code: 'opted_out' });
  }

  // --- send ---
  const statusCallback = `${baseUrl(event)}/.netlify/functions/sms-status`;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  let sid = null;
  let sendError = null;
  try {
    const msg = await getMessageProvider().send({
      channel: 'sms',
      to: person.mobile_phone,
      body,
      statusCallback,
      ...(messagingServiceSid ? { messagingServiceSid } : { from: org.twilio_number }),
    });
    sid = msg.sid;
  } catch (e) {
    sendError = e;
    console.error('send-sms: Twilio send failed', { code: e.code, message: e.message });
  }

  // Always record the attempt so staff can see failures in the thread rather than assume delivery.
  const { data: row } = await supabase
    .from('inbox_messages')
    .insert({
      item_id,
      direction: 'outbound',
      body,
      sent_by: caller.id,
      twilio_sid: sid,
      delivery_status: sendError ? 'failed' : 'queued',
      error_code: sendError ? String(sendError.code ?? 'send_failed') : null,
      template_id: template_id || null,
    })
    .select('id')
    .single();

  if (sendError) {
    // 21610 = recipient replied STOP at the carrier/Twilio level. Remember it so the UI locks the composer.
    if (sendError.code === 21610) {
      await supabase.from('people').update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString(), consent_status: 'withdrawn' }).eq('id', person.id);
      await supabase.from('consent_events').insert({ person_id: person.id, event: 'opt_out', method: 'twilio_21610' });
      return json(409, { error: 'This person has opted out of texts. Call them instead.', code: 'opted_out' });
    }
    const friendly =
      sendError.code === 21211 || sendError.code === 21614
        ? 'That phone number can\'t receive texts. Check the number on the person\'s profile.'
        : 'The text could not be sent. Try again, or call the person directly.';
    return json(502, { error: friendly, code: sendError.code ?? 'send_failed' });
  }

  // Replying means a human has picked this up. The portal shows one thread per person, so
  // acknowledge every still-open alert from this person (not just the one the reply attached to)
  // and clear their unread flags.
  const now = new Date().toISOString();
  if (alert.person_id) {
    await supabase
      .from('inbox_items')
      .update({ status: 'acknowledged', acknowledged_at: now, acknowledged_by: caller.id })
      .eq('person_id', alert.person_id)
      .eq('organization_id', alert.organization_id)
      .eq('status', 'open');
    await supabase.from('inbox_items').update({ unread_reply: false }).eq('person_id', alert.person_id).eq('organization_id', alert.organization_id);
  } else {
    const update = { unread_reply: false };
    if (alert.status === 'open') {
      update.status = 'acknowledged';
      update.acknowledged_at = now;
      update.acknowledged_by = caller.id;
    }
    await supabase.from('inbox_items').update(update).eq('id', item_id);
  }

  return json(200, { ok: true, message_id: row?.id ?? null, sid });
};
