// Verifies Resend webhooks (they are signed with Svix). Signed content is "<svix-id>.<svix-timestamp>.<raw body>",
// HMAC-SHA256 with the base64 part of the signing secret ("whsec_..."). The header may hold several "v1,<sig>" values.
const crypto = require('crypto');

function verifySvix({ id, timestamp, signatureHeader, rawBody, secret, toleranceSeconds = 300, nowMs = Date.now() }) {
  if (!id || !timestamp || !signatureHeader || !secret || typeof rawBody !== 'string') return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of String(signatureHeader).split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

// Test helper: produces the headers Svix would send.
function signSvix({ id, timestamp, rawBody, secret }) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}
module.exports = { verifySvix, signSvix };
