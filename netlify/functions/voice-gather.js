// Receives the key a person pressed during an emergency call. 1 = safe, 2 = needs help, 9 = stop voice calls.
// URL form: /.netlify/functions/voice-gather/<delivery id>. Same signature rules as voice-twiml.
// The database records it (acknowledgement, critical inbox item for 2, opt-out for 9) and ignores a repeated press.

const { checkTwilioSignature, baseUrl } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { digitTwiml } = require('../../src/server/broadcast/voiceFormat.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const xmlOut = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/xml' }, body });

exports.handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : (event.body || '');
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const id = String(event.path || '').split('/').filter(Boolean).pop();
  if (!UUID_RE.test(id || '')) return { statusCode: 404, body: 'Not found' };

  const sig = checkTwilioSignature(event, params, `voice-gather/${id}`);
  if (sig.reject) return { statusCode: 403, body: 'Invalid signature' };

  const digit = String(params.Digits || '').slice(0, 1);
  const { data: result, error } = await supabase.rpc('record_keypad_ack', { p_delivery: id, p_digit: digit, p_call_sid: params.CallSid || null });
  if (error) {
    console.error('voice-gather: record_keypad_ack failed', error.message);
    // Never leave a person in trouble with silence: tell them to use another way and hang up.
    return xmlOut(200, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we could not record that. If you need help, contact your organization or call emergency services. Goodbye.</Say><Hangup/></Response>');
  }
  const { data: d } = await supabase.from('notification_deliveries').select('event_id').eq('id', id).maybeSingle();
  let requiresAck = true;
  if (d) {
    const { data: ev } = await supabase.from('notification_events').select('requires_ack').eq('id', d.event_id).maybeSingle();
    if (ev) requiresAck = ev.requires_ack !== false;
  }
  return xmlOut(200, digitTwiml({ result, requiresAck, gatherUrl: `${baseUrl(event)}/.netlify/functions/voice-gather/${id}` }));
};
