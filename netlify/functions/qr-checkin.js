// PROPOSED (not deployed): public QR check-in endpoint for qremns.activesos.com.
// The qremns site proxies /api/qr-checkin here (same pattern as qr1.activesos.com -> Protect's qr-report).
//
// GET  ?code=...  -> { ok, name, org: { name, sms_number } }   what the page shows for this QR code
// POST { code, action, name, phone, device?, lang?, message? } -> records the check-in against the person's open roll-call
//   action: CHECKIN | RALLY (both = SAFE) | HELP | MEDICAL (both = SOS) | MESSAGE (free text, triaged)
//
// A QR code is "registered" by adding it to the organization's settings (no migration):
//   update organizations set settings = settings || jsonb_build_object('qr_sites',
//     coalesce(settings->'qr_sites','{}'::jsonb) || jsonb_build_object('29PALMS-RALLY', jsonb_build_object('name','Hospital Rally Point')))
//   where slug = '<org slug>';
//
// SECURITY: no login. The QR code is the credential for the site; the person is found by mobile number on the server-side roster
// (never created from this request). Anyone who knows a rostered number and the code could check in as that person: acceptable for a
// demo, not for production without a per-person link or a text-message verification step.
// Location: only what the person's phone sends with THIS check-in, and only if they allow it. Never stored apart from the check-in.
// Emergencies (SOS, or free text that reads as one) also open a critical inbox item. SAFE never opens one (a big roll-call must not flood the inbox).
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Uses the same database functions as the Active SOS app path (record_app_alert_ack, record_acknowledgement).
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { normalizePhone } = require('../../src/server/phone.cjs');
const { classifyReply } = require('../../src/server/replies/classifyReply.cjs');
const { matchKeywordTier, DEFAULT_TIER_RULES } = require('../../src/server/replies/triage.cjs');
const { rateLimit, tooMany, clientIp } = require('../../src/server/rateLimit.cjs');
const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/;
const ACTIONS = {
  CHECKIN: { response: 'SAFE', text: 'Check-in' },
  RALLY: { response: 'SAFE', text: 'At Rally Point' },
  HELP: { response: 'SOS', text: 'NEED HELP' },
  MEDICAL: { response: 'SOS', text: 'NEED MEDICAL HELP' },
  MESSAGE: { response: null, text: null },
};
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

async function findOrg(code) {
  const { data, error } = await supabase.from('organizations').select('id, name, twilio_number, settings')
    .contains('settings', { qr_sites: { [code]: {} } }).maybeSingle();
  if (error) console.error('qr-checkin: organization lookup failed', error);
  if (!data) return null;
  const site = data.settings && data.settings.qr_sites && data.settings.qr_sites[code];
  return { org: data, siteName: (site && site.name) || 'Check-in' };
}

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return json(405, { ok: false, error: 'method' });

  const rl = await rateLimit(supabase, `qrcheckin:${clientIp(event)}`, method === 'POST' ? 20 : 60, 60);
  if (!rl.ok) return tooMany(rl);

  let b = {};
  if (method === 'GET') b = event.queryStringParameters || {};
  else {
    if ((event.body || '').length > 4000) return json(413, { ok: false, error: 'too_large' });
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  }
  const code = typeof b.code === 'string' ? b.code : '';
  if (!CODE_RE.test(code)) return json(200, { ok: false, error: 'unknown_code' });
  const found = await findOrg(code);
  if (!found) return json(200, { ok: false, error: 'unknown_code' });
  const { org, siteName } = found;

  if (method === 'GET') return json(200, { ok: true, name: siteName, org: { name: org.name, sms_number: org.twilio_number || '' } });

  // ---- POST ----
  const action = ACTIONS[b.action];
  if (!action) return json(400, { ok: false, error: 'bad_action' });
  const phone = normalizePhone(b.phone);
  if (!phone) return json(400, { ok: false, error: 'invalid_phone' });
  const name = String(b.name || '').trim().slice(0, 80);
  const message = String(b.message || '').trim().slice(0, 500);
  if (b.action === 'MESSAGE' && !message) return json(400, { ok: false, error: 'empty_message' });

  const lat = Number(b.device && b.device.lat), lng = Number(b.device && b.device.lng);
  const located = !!(b.device && validCoord(lat, lng));
  const gpsUrl = located ? `https://www.google.com/maps?q=${lat}%2C${lng}` : null;

  // What the check-in means.
  let response = action.response, text = action.text;
  if (b.action === 'MESSAGE') {
    text = message;
    const { data: rules } = await supabase.from('priority_rules').select('keyword, tier').eq('organization_id', org.id);
    const kw = matchKeywordTier(message, rules && rules.length ? rules : DEFAULT_TIER_RULES);
    const cls = classifyReply(message).response;
    response = (cls === 'SOS' || (kw && kw.tier === 3)) ? 'SOS' : cls === 'SAFE' ? 'SAFE' : 'TEXT';
  }

  const { data: person } = await supabase.from('people').select('id, full_name').eq('organization_id', org.id).eq('mobile_phone', phone).eq('is_active', true).maybeSingle();

  let recorded = false;
  if (person) {
    const sid = `QR-${code}-${b.action}-${person.id}-${Math.floor(Date.now() / 60000)}`.slice(0, 120); // a double tap inside a minute counts once
    const rpcName = response === 'TEXT' ? 'record_acknowledgement' : 'record_app_alert_ack';
    const args = response === 'TEXT'
      ? { p_org: org.id, p_person: person.id, p_response: 'TEXT', p_text: text, p_message_sid: sid }
      : { p_org: org.id, p_person: person.id, p_response: response, p_text: text, p_message_sid: sid, p_lat: located ? lat : null, p_lng: located ? lng : null, p_gps_url: gpsUrl };
    const { data: ack, error } = await supabase.rpc(rpcName, args);
    if (error) console.error('qr-checkin: roll-call record failed', error); // never loses the alert: the inbox item below is still created
    else recorded = !!(ack && ack.matched);
    if (ack && ack.duplicate) return json(200, { ok: true, enrolled: true, recorded: true, located, duplicate: true });
  }

  // Critical inbox: emergencies, and free text that needs a human (also for people not on the roster, so a call for help is never dropped).
  if (response !== 'SAFE') {
    const body = person ? text : `Unregistered QR check-in from ${name || 'unknown'} (${phone}) at ${siteName}: ${text}`;
    const { error } = await supabase.from('inbox_items').insert({
      organization_id: org.id, person_id: person ? person.id : null, tier: response === 'SOS' ? 3 : 2, item_type: response === 'SOS' ? 'SOS' : 'FREEFORM',
      status: 'open', message_body: body, gps_url: gpsUrl, lat: located ? lat : null, lng: located ? lng : null, last_inbound_at: new Date().toISOString(),
    });
    if (error) { console.error('qr-checkin: inbox insert failed', error); if (response === 'SOS' && !recorded) return json(500, { ok: false, error: 'server' }); }
  }

  return json(200, { ok: true, enrolled: !!person, recorded, located, response });
};
