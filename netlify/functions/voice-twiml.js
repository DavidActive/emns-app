// Twilio asks this function what to say when an outbound emergency call connects.
// URL form: /.netlify/functions/voice-twiml/<delivery id>  (the id is part of the path so Twilio's signature covers it).
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN. Signature checking is ON unless TWILIO_ENFORCE_SIGNATURE=false.
// A person hears the message and the keypad choices; an answering machine hears the message twice and no prompt.

const { checkTwilioSignature, baseUrl } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { answerTwiml } = require('../../src/server/broadcast/voiceFormat.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const xmlOut = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/xml' }, body });
const sorry = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be completed.</Say><Hangup/></Response>';

exports.handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : (event.body || '');
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const id = String(event.path || '').split('/').filter(Boolean).pop();
  if (!UUID_RE.test(id || '')) return { statusCode: 404, body: 'Not found' };

  const sig = checkTwilioSignature(event, params, `voice-twiml/${id}`);
  if (sig.reject) return { statusCode: 403, body: 'Invalid signature' };

  const { data: d } = await supabase.from('notification_deliveries').select('id, event_id, channel').eq('id', id).maybeSingle();
  if (!d || d.channel !== 'voice') return xmlOut(200, sorry);
  const { data: ev } = await supabase.from('notification_events').select('requires_ack, body, voice_text').eq('id', d.event_id).maybeSingle();
  if (!ev) return xmlOut(200, sorry);

  const text = ev.voice_text || ev.body || '';
  const gatherUrl = `${baseUrl(event)}/.netlify/functions/voice-gather/${id}`;
  return xmlOut(200, answerTwiml({ text, requiresAck: ev.requires_ack !== false, answeredBy: params.AnsweredBy, gatherUrl }));
};
