// Inbound Twilio SMS webhook — copied pattern from protect-activesos's sms-webhook.
// Twilio Messaging Service should point its inbound webhook URL at this function.
//
// Flow: classify tier -> upsert people -> insert alerts + inbox_messages.
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const { checkTwilioSignature, baseUrl } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { classifyReply } = require('../../src/server/replies/classifyReply.cjs');
const { matchKeywordTier, DEFAULT_TIER_RULES } = require('../../src/server/replies/triage.cjs');


const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

// Fallback keyword rules, used only if an organization has zero rows in priority_rules (e.g. a
// brand-new org that hasn't configured its own crisis/safe keywords yet). Organizations
// normally define and edit their own list from Org Settings -> Crisis Keywords, which is
// backed by the priority_rules table.
// Default rules and the matcher live in one shared, tested module (whole words only, negated reassurance is critical).
async function getTierRules(organizationId) {
  const { data, error } = await supabase
    .from('priority_rules')
    .select('keyword, tier')
    .eq('organization_id', organizationId);
  if (error) {
    console.error('sms-webhook: priority_rules lookup failed, using defaults', error);
    return DEFAULT_TIER_RULES;
  }
  return data && data.length > 0 ? data : DEFAULT_TIER_RULES;
}

// Structured alerts sent by the Active SOS mobile app look like:
//
//   You are receiving this alert from David Zink (+14052039919) via Active SOS App
//   SOS Alert
//   ACTIVE SHOOTER
//   Click here for my location: https://www.google.com/maps?q=35.4576%2C-97.5953
//
// (pattern carried over from Protect).
// Any inbound text that doesn't match this shape is a plain free-text message from a
// veteran/supporter texting in directly, which VetProtect also needs to accept and triage.
// Note: the alert-type word is NOT always all-caps in the wild — live traffic has shown
// both "SOS Alert" and "Safe Alert" (only first letter capitalized), so this must match
// case-insensitively rather than assuming [A-Z]+.
const APP_ALERT_REGEX =
  /^You are receiving this alert from (.+?) \(([^)]+)\) via Active SOS App\n([A-Za-z]+) Alert\n(.*?)\nClick here for my location: (https?:\/\/\S*[?&]q=(-?[\d.]+)%2C(-?[\d.]+)\S*)/is;

const APP_ALERT_TYPE_TIER = { SOS: 3, SAFE: 1 };

function parseAppAlert(body) {
  const match = APP_ALERT_REGEX.exec(body || '');
  if (!match) return null;
  const [, senderName, senderPhone, alertWord, reason, gpsUrl, lat, lng] = match;
  const alertType = alertWord.toUpperCase() === 'SOS' ? 'SOS' : alertWord.toUpperCase() === 'SAFE' ? 'SAFE' : 'UNKNOWN';
  return {
    tier: APP_ALERT_TYPE_TIER[alertType] ?? 2,
    item_type: alertType,
    reason: reason.trim(),
    senderName,
    senderPhone,
    gps_url: gpsUrl,
    lat: Number(lat),
    lng: Number(lng),
  };
}

function classifyFreeform(body, rules) {
  const match = matchKeywordTier(body, rules);
  if (match) return { tier: match.tier, item_type: match.tier === 3 ? 'SOS' : 'FREEFORM' };
  // No keyword matched (org-defined or default) -> baseline "needs a look" tier, same as before.
  return { tier: 2, item_type: 'FREEFORM' };
}

// Accepts either wire format: a structured Active SOS App alert, or a plain free-text message.
// `rules` is this organization's priority_rules (or DEFAULT_TIER_RULES as fallback) — see
// getTierRules() above.
function classify(body, rules) {
  const appAlert = parseAppAlert(body);
  if (appAlert) {
    const baselineTier = appAlert.tier;
    // Run the SAME keyword logic used for freeform text against the structured alert's
    // reason field, so e.g. "Relapse Alert" is Tier 3 whether it arrives as a plain text
    // or as a Safe/SOS Active SOS App alert whose reason happens to say "relapse". This
    // only ever escalates — a keyword match can raise the tier but can never downgrade an
    // SOS button press below Tier 3.
    const kwMatch = matchKeywordTier(appAlert.reason, rules);
    const tier = kwMatch && kwMatch.tier > baselineTier ? kwMatch.tier : baselineTier;
    const alertType = tier === 3 ? 'SOS' : appAlert.item_type;
    return {
      tier,
      item_type: alertType,
      gps_url: appAlert.gps_url,
      lat: appAlert.lat,
      lng: appAlert.lng,
      // Store the human-readable reason ("ACTIVE SHOOTER") as the message body shown
      // in the triage inbox, rather than the full multi-line raw SMS text.
      message_body: appAlert.reason,
      senderName: appAlert.senderName,
      senderPhone: appAlert.senderPhone,
    };
  }
  const freeform = classifyFreeform(body, rules);
  // Words like "not safe", "trapped" or "need help" are critical even when the organization's own rules do not list them.
  if (freeform.tier < 3 && classifyReply(body).response === 'SOS') { freeform.tier = 3; freeform.item_type = 'SOS'; }
  return { ...freeform, gps_url: null, lat: null, lng: null, message_body: body, senderName: null, senderPhone: null };
}

// ---- Two-way conversation support -------------------------------------------------------
//
// THREADING: a plain-text reply from someone who already has an open/acknowledged alert is
// appended to THAT alert's thread instead of creating a new alert, so staff see one
// conversation. A new Active SOS App button press (structured alert) always starts a new alert,
// and so does any text once the previous alert is resolved or has been quiet longer than the
// window. If the reply is more urgent than the alert (e.g. a crisis keyword in a reply to a Tier 1
// check-in) the alert's tier is RAISED — never lowered.
// Window: EMNS_THREAD_WINDOW_HOURS (default 72). Set to 0 to disable threading entirely.
const THREAD_WINDOW_HOURS = Number(process.env.EMNS_THREAD_WINDOW_HOURS ?? 72);

// STOP/START handling (TCPA / 10DLC). Twilio also enforces opt-out at the carrier level; this keeps
// our own roster flag and consent_events in sync so the portal can lock the reply box. Exact-match only,
// so a sentence containing "stop" is still triaged normally. END/QUIT are deliberately NOT treated as
// opt-out here: a bare "end" from someone in distress should reach a human, not vanish silently.
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel']);
const OPT_IN_WORDS = new Set(['start', 'unstop']);
const normalizeKeyword = (t) => (t || '').trim().toLowerCase().replace(/[.!\s]+$/g, '').replace(/\s+/g, ''); // 'STOP ALL' -> 'stopall'

const EMPTY_TWIML = { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: '<Response></Response>' };

// Most recent open/acknowledged alert for this person that still has recent activity, or null.
async function findThreadAlert(orgId, personId) {
  if (!(THREAD_WINDOW_HOURS > 0)) return null;
  const { data: alert } = await supabase
    .from('inbox_items')
    .select('id, tier, item_type, status, created_at')
    .eq('organization_id', orgId)
    .eq('person_id', personId)
    .in('status', ['open', 'acknowledged'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!alert) return null;

  const { data: lastMsg } = await supabase
    .from('inbox_messages')
    .select('created_at')
    .eq('item_id', alert.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastActivity = new Date(lastMsg?.created_at ?? alert.created_at).getTime();
  return Date.now() - lastActivity <= THREAD_WINDOW_HOURS * 3600 * 1000 ? alert : null;
}

exports.handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  const params = new URLSearchParams(rawBody);

  const sig = checkTwilioSignature(event, Object.fromEntries(params), 'sms-webhook');
  if (sig.reject) return { statusCode: 403, body: 'Invalid signature' };

  const from = params.get('From');
  const to = params.get('To'); // organization's Twilio number
  const body = params.get('Body');

  console.log('sms-webhook received', { from, to, body, isBase64Encoded: event.isBase64Encoded });

  if (!to) {
    console.error('sms-webhook: could not parse To/From/Body from request body', { rawBody });
    return EMPTY_TWIML;
  }

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id')
    .eq('twilio_number', to)
    .maybeSingle();

  if (orgError) {
    console.error('sms-webhook: organizations lookup failed', orgError);
  }

  if (!org) {
    console.warn(`sms-webhook: no organization found for twilio_number = "${to}"`);
    return EMPTY_TWIML;
  }

  const rules = await getTierRules(org.id);
  const classified = classify(body, rules);
  console.log('sms-webhook classified', classified);

  // IMPORTANT: the Active SOS App relays structured alerts through its own shared sending
  // number, so Twilio's "From" field is the app's number, not the individual veteran's —
  // using it to key people would merge every app user into one contact record.
  // The real per-person phone is embedded in the message body itself for structured alerts;
  // only fall back to the raw Twilio "From" for plain free-text messages, where "From" IS
  // the actual sender's own phone. (This is also why replies go to people.mobile_phone,
  // never to the Twilio "From" of a structured alert — see send-sms.js.)
  const identityPhone = classified.senderPhone ?? from;
  const isStructured = Boolean(classified.senderPhone);

  // Structured Active SOS App alerts embed the sender's real name — use it to name the
  // person in the Veterans/Supporters roster instead of leaving them as "Unknown".
  let { data: person } = await supabase
    .from('people')
    .select('id, full_name')
    .eq('organization_id', org.id)
    .eq('mobile_phone', identityPhone)
    .maybeSingle();

  if (!person) {
    const { data: newPerson } = await supabase
      .from('people')
      .insert({ organization_id: org.id, full_name: classified.senderName ?? 'Unknown', mobile_phone: identityPhone })
      .select('id, full_name')
      .single();
    person = newPerson;
  } else if (classified.senderName && (!person.full_name || person.full_name === 'Unknown')) {
    await supabase.from('people').update({ full_name: classified.senderName }).eq('id', person.id);
    person.full_name = classified.senderName;
  }

  // --- STOP / START keywords (plain-text only; never from a structured app alert) ---
  if (!isStructured) {
    const kw = normalizeKeyword(body);
    if (OPT_OUT_WORDS.has(kw)) {
      await supabase.from('people').update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString(), consent_status: 'withdrawn' }).eq('id', person.id);
      await supabase.from('consent_events').insert({ person_id: person.id, event: 'opt_out', method: 'sms_keyword_stop' });
      return EMPTY_TWIML; // Twilio sends the standard STOP confirmation itself
    }
    if (OPT_IN_WORDS.has(kw)) {
      await supabase.from('people').update({ sms_opted_out: false, sms_opted_out_at: null, consent_status: 'consented', consented_at: new Date().toISOString(), consent_method: 'sms_keyword_start' }).eq('id', person.id);
      await supabase.from('consent_events').insert({ person_id: person.id, event: 'opt_in', method: 'sms_keyword_start', consent_text: 'Person texted START to the eMNS number.', text_version: 'sms_keyword_start' });
      return EMPTY_TWIML;
    }
  }

  // --- P7: match a plain reply to the person's most recent notification that asked for an acknowledgement ---
  // SAFE: recorded and done (no triage item, so a 5,000-person drill does not flood the inbox).
  // SOS: recorded AND forced to a critical triage item. Anything else: recorded, then triaged as usual.
  // If nothing matches (no open event for this person), the existing behavior below is unchanged.
  if (!isStructured) {
    const reply = classifyReply(body);
    const { data: ack, error: ackError } = await supabase.rpc('record_acknowledgement', {
      p_org: org.id, p_person: person.id, p_response: (reply.response === 'TEXT' && classified.tier === 3) ? 'SOS' : reply.response, p_text: body, p_message_sid: params.get('MessageSid') || null,
    });
    if (ackError) console.error('sms-webhook: record_acknowledgement failed', ackError);
    else if (ack && ack.matched) {
      if (ack.duplicate) return EMPTY_TWIML;
      if (reply.response === 'SAFE') return EMPTY_TWIML;
      if (reply.response === 'SOS' || classified.tier === 3) { classified.tier = 3; classified.item_type = 'SOS'; }
    }
  }

  // --- P17: an Active SOS app alert answers the person's open notification (with its GPS), so it counts in the roll-call ---
  // SOS (or a Safe alert whose reason escalated to SOS) is recorded as SOS; a Safe alert as SAFE. The inbox item below is still
  // created exactly as before. If nothing is open for this person, nothing changes. A failure here never loses the alert.
  if (isStructured && (classified.item_type === 'SOS' || classified.item_type === 'SAFE')) {
    const { data: appAck, error: appAckError } = await supabase.rpc('record_app_alert_ack', {
      p_org: org.id, p_person: person.id, p_response: classified.item_type, p_text: classified.message_body,
      p_message_sid: params.get('MessageSid') || null, p_lat: classified.lat, p_lng: classified.lng, p_gps_url: classified.gps_url,
    });
    if (appAckError) console.error('sms-webhook: record_app_alert_ack failed', appAckError);
    else if (appAck && appAck.duplicate) return EMPTY_TWIML; // the carrier delivered the same message twice
  }

  // --- Thread onto an existing conversation when this is a plain reply ---
  const threadAlert = isStructured ? null : await findThreadAlert(org.id, person.id);
  if (threadAlert) {
    const { error: msgError } = await supabase
      .from('inbox_messages')
      .insert({ item_id: threadAlert.id, direction: 'inbound', body });
    if (msgError) {
      console.error('sms-webhook: failed to append reply to thread', msgError);
      return EMPTY_TWIML;
    }
    const update = { unread_reply: true, last_inbound_at: new Date().toISOString() };
    if (classified.tier > threadAlert.tier) {
      update.tier = classified.tier; // raise only, never lower
      if (classified.tier === 3 && threadAlert.item_type !== 'SOS') update.item_type = 'SOS';
      console.log('sms-webhook: reply raised alert tier', { item_id: threadAlert.id, from: threadAlert.tier, to: classified.tier });
    }
    await supabase.from('inbox_items').update(update).eq('id', threadAlert.id);
    return EMPTY_TWIML;
  }

  const { data: alert, error: alertInsertError } = await supabase
    .from('inbox_items')
    .insert({
      organization_id: org.id,
      person_id: person.id,
      tier: classified.tier,
      item_type: classified.item_type,
      message_body: classified.message_body,
      gps_url: classified.gps_url,
      lat: classified.lat,
      lng: classified.lng,
      status: 'open',
      last_inbound_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (alertInsertError) {
    console.error('sms-webhook: failed to insert alert', alertInsertError);
    return EMPTY_TWIML;
  }

  // Always store the full raw SMS text in inbox_messages, even for structured app alerts
  // where alerts.message_body holds just the short human-readable reason — the raw text
  // (sender name/phone, full maps link) stays available in the thread for case review.
  await supabase.from('inbox_messages').insert({
    item_id: alert.id,
    direction: 'inbound',
    body,
  });

  return EMPTY_TWIML;
};
