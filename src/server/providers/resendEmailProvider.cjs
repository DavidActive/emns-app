// Email through Resend's REST API (fetch only, no SDK). Adapter only: the queue, retries and fall-through live elsewhere.
// Requires RESEND_API_KEY and EMNS_EMAIL_FROM (a sender on a domain verified in Resend). EMNS_EMAIL_REPLY_TO is optional.
const { ProviderError } = require('./types.cjs');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Plain text becomes simple, safe HTML (line breaks kept, links not auto-created).
function htmlFromText(text) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;white-space:pre-wrap">${esc(text)}</div>`;
}

// Permanent codes end retries and trigger the next channel; 429 and 5xx are retried.
function errorCode(status, data) {
  const name = String((data && data.name) || '').toLowerCase();
  if (name === 'validation_error' || name === 'invalid_to_address' || status === 422) return 'invalid_email';
  if (status === 401 || status === 403) return 'email_auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return String(status);
  return 'email_rejected';
}

function createResendEmailProvider(env = process.env, fetchImpl = globalThis.fetch) {
  return {
    name: 'resend',
    async send(req) {
      const key = env.RESEND_API_KEY;
      const from = env.EMNS_EMAIL_FROM;
      if (!key || !from) throw new ProviderError('Email is not configured (RESEND_API_KEY and EMNS_EMAIL_FROM).', 'email_not_configured');
      const payload = { from, to: [req.to], subject: req.subject, text: req.body, html: htmlFromText(req.body) };
      if (env.EMNS_EMAIL_REPLY_TO) payload.reply_to = env.EMNS_EMAIL_REPLY_TO;
      const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
      if (req.idempotencyKey) headers['Idempotency-Key'] = String(req.idempotencyKey).slice(0, 256);
      let res;
      try { res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(payload) }); }
      catch (e) { throw new ProviderError(`Resend request failed: ${e && e.message}`, 'network'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError((data && data.message) || `Resend HTTP ${res.status}`, errorCode(res.status, data));
      return { sid: data.id, status: 'queued' };
    },
  };
}
module.exports = { createResendEmailProvider, htmlFromText, errorCode };
