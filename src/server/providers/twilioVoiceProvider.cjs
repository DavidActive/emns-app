// Twilio voice calls via REST + fetch (no twilio SDK). Places an outbound call; Twilio then asks our "voice-twiml" function what to say,
// and reports the final result (answered, busy, no answer, failed) to our "voice-status" function.
const { ProviderError } = require('./types.cjs');

function createTwilioVoiceProvider(env = process.env, fetchImpl = globalThis.fetch) {
  return {
    name: 'twilio',
    async send(req) {
      const acct = env.TWILIO_ACCOUNT_SID;
      if (!acct || !env.TWILIO_AUTH_TOKEN) throw new ProviderError('Twilio credentials are not configured.', 'not_configured');
      const from = req.from || env.TWILIO_VOICE_FROM || env.TWILIO_PHONE_NUMBER;
      if (!from) throw new ProviderError('No caller number is configured (TWILIO_VOICE_FROM).', 'not_configured');
      if (!req.twimlUrl) throw new ProviderError('A call needs a TwiML URL.', 'bad_request');
      const form = {
        To: req.to, From: from, Url: req.twimlUrl, Method: 'POST',
        Timeout: String(req.ringTimeoutSeconds || Number(env.EMNS_VOICE_RING_SECONDS) || 25),
        MachineDetection: 'Enable',              // lets us tell a voicemail greeting from a person (AnsweredBy)
        StatusCallbackEvent: 'completed', StatusCallbackMethod: 'POST',
      };
      if (req.statusCallback) form.StatusCallback = req.statusCallback;
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${acct}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(data.message || `Twilio HTTP ${res.status}`, data.code);
      return { sid: data.sid, status: data.status || 'queued' };
    },
  };
}
module.exports = { createTwilioVoiceProvider };
