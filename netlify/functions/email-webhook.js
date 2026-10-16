// Resend webhook: delivery receipts, bounces and spam complaints for email deliveries.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_WEBHOOK_SECRET (the "whsec_..." signing secret from the Resend webhook).
// In Resend, point a webhook at https://<site>/.netlify/functions/email-webhook and tick email.delivered, email.bounced,
// email.complained, email.failed and email.suppressed.
//
// FAILS CLOSED: with no secret configured, or a bad signature, nothing is recorded.
// A hard bounce marks the address as bounced (never emailed again); a complaint opts the person out of email;
// a failure releases the person's next channel when the event was sent as "fallback" (all inside the database function).

const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { verifySvix } = require('../../src/server/providers/svixSignature.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore
const HANDLED = new Set(['email.delivered', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 503, body: 'Webhook is not configured' };
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : (event.body || '');
  const h = {};
  for (const [k, v] of Object.entries(event.headers || {})) h[k.toLowerCase()] = v;
  const valid = verifySvix({ id: h['svix-id'], timestamp: h['svix-timestamp'], signatureHeader: h['svix-signature'], rawBody, secret });
  if (!valid) return { statusCode: 401, body: 'Invalid signature' };

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const type = payload && payload.type;
  if (!HANDLED.has(type)) return { statusCode: 200, body: 'ignored' };
  const data = payload.data || {};
  const sid = data.email_id;
  if (!sid) return { statusCode: 200, body: 'no email id' };

  const { error } = await supabase.rpc('record_email_event', {
    p_sid: sid,
    p_type: type,
    p_bounce_type: (data.bounce && data.bounce.type) || null,
  });
  if (error) { console.error('email-webhook: record_email_event failed', error.message); return { statusCode: 500, body: 'Could not record' }; } // Resend retries on 5xx
  return { statusCode: 200, body: 'ok' };
};
