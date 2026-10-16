// Twilio via REST + fetch (no twilio SDK; it crashed in the Netlify bundle in VetProtect).
const { ProviderError } = require('./types.cjs');

function createTwilioMessageProvider(env = process.env, fetchImpl = globalThis.fetch) {
  return {
    name: 'twilio',
    async send(req) {
      const acct = env.TWILIO_ACCOUNT_SID;
      if (!acct || !env.TWILIO_AUTH_TOKEN) throw new ProviderError('Twilio credentials are not configured.', 'not_configured');
      const form = { To: req.to, Body: req.body };
      if (req.statusCallback) form.StatusCallback = req.statusCallback;
      if (req.messagingServiceSid) form.MessagingServiceSid = req.messagingServiceSid; else form.From = req.from;
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Messages.json`, {
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
module.exports = { createTwilioMessageProvider };
