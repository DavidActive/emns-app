// Public enrollment endpoint: the page a person opens from their one-time link to agree to receive text alerts.
// GET  ?token=...   -> what to show (organization, consent text) or why the link is not usable
// POST { token, text?, voice? } -> records consent with the exact text shown, burns the link, sends ONE confirmation text when texts were newly agreed.
//   text defaults to true (older clients send only the token); voice defaults to false. Calls need their own agreement (the second box).
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. The confirmation uses TWILIO_MESSAGING_SERVICE_SID via the provider
// (mock by default; real sends only when EMNS_MESSAGE_PROVIDER=twilio and EMNS_ALLOW_REAL_SEND=true).
//
// SECURITY: no login. The token is the credential: 256 random bits, stored only as a SHA-256 hash, single use, expires.
// Responses never include the person's phone number or full name.
const crypto = require('crypto');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { getMessageProvider } = require('../../src/server/providers/index.cjs');
const { TEXT_VERSION, VOICE_TEXT_VERSION, LINKS, consentText, voiceConsentText, confirmationMessage } = require('../../src/server/consent/consentText.cjs');
const { rateLimit, tooMany, clientIp } = require('../../src/server/rateLimit.cjs');
const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' });

  const rl = await rateLimit(supabase, `enroll:${clientIp(event)}`, method === 'POST' ? 10 : 60, 60);
  if (!rl.ok) return tooMany(rl);
  let token = '';
  let agreeText = true;
  let agreeVoice = false;
  if (method === 'GET') token = (event.queryStringParameters || {}).token || '';
  else {
    try {
      const b = JSON.parse(event.body || '{}');
      token = b.token || '';
      if (b.text === false) agreeText = false;
      if (b.voice === true) agreeVoice = true;
    } catch { return json(400, { error: 'Invalid JSON.' }); }
  }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return json(200, method === 'GET' ? { status: 'invalid' } : { ok: false, reason: 'invalid' });
  const tokenHash = hashToken(token);

  const { data: info, error: infoError } = await supabase.rpc('get_enrollment_invite', { p_token_hash: tokenHash });
  if (infoError) { console.error('enroll: lookup failed', infoError); return json(500, { error: 'Something went wrong. Please try again.' }); }
  if (!info || info.status !== 'valid') {
    const status = info?.status || 'invalid';
    return json(200, method === 'GET' ? { status } : { ok: false, reason: status });
  }

  if (method === 'GET') {
    return json(200, {
      status: 'valid', org_name: info.org_name, first_name: info.first_name, phone_last4: info.phone_last4,
      already_consented: info.already_consented, opted_out: info.opted_out,
      consent_text: consentText(info.org_name), text_version: TEXT_VERSION, links: LINKS,
      voice_consented: !!info.voice_consented, voice_opted_out: !!info.voice_opted_out,
      voice_consent_text: voiceConsentText(info.org_name), voice_text_version: VOICE_TEXT_VERSION,
    });
  }

  // POST: the person ticked the box and pressed the button. Record exactly the text we showed.
  if (!agreeText && !agreeVoice) return json(400, { error: 'Nothing was selected.' });
  const { data: rec, error: recError } = await supabase.rpc('record_web_consent', {
    p_token_hash: tokenHash,
    p_text: agreeText ? consentText(info.org_name) : null, p_text_version: agreeText ? TEXT_VERSION : null,
    p_voice_agreed: agreeVoice,
    p_voice_text: agreeVoice ? voiceConsentText(info.org_name) : null, p_voice_text_version: agreeVoice ? VOICE_TEXT_VERSION : null,
  });
  if (recError) { console.error('enroll: record failed', recError); return json(500, { error: 'Something went wrong. Please try again.' }); }
  if (!rec || !rec.ok) return json(200, { ok: false, reason: rec?.reason || 'invalid' });

  // One confirmation text, only for a newly consenting person who has not opted out (the carrier would block an opted-out number).
  let confirmation = 'not_needed';
  if (agreeText && !rec.already_consented && !rec.opted_out) {
    try {
      await getMessageProvider().send({
        channel: 'sms', to: rec.to, body: confirmationMessage(rec.org_name),
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      });
      confirmation = 'sent';
    } catch (e) {
      console.error('enroll: confirmation text not sent', e && e.message);
      confirmation = 'not_sent'; // consent is already recorded; the missing confirmation never undoes it
    }
  }
  return json(200, { ok: true, org_name: rec.org_name, opted_out: rec.opted_out, confirmation, voice: agreeVoice });
};
exports.hashToken = hashToken;
