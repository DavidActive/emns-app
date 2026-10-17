// Database-backed rate limiting for write endpoints (fixed window, shared by every function instance).
// Fails OPEN: if the limiter itself is unavailable, the request goes through. An emergency send must never be blocked by a limiter outage.
const json = (statusCode, obj, headers = {}) => ({ statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });

async function rateLimit(db, key, limit, windowSeconds) {
  try {
    const { data, error } = await db.rpc('check_rate_limit', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) { console.error('rate limiter unavailable', error.message); return { ok: true }; }
    if (data && data.ok === false) return { ok: false, retryAfter: data.retry_after || windowSeconds };
  } catch (e) { console.error('rate limiter failed', e && e.message); }
  return { ok: true };
}
const tooMany = (r) => json(429, { error: 'Too many requests. Please wait a moment and try again.' }, { 'Retry-After': String(r.retryAfter) });
function clientIp(event) {
  const h = event.headers || {};
  return (h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}
module.exports = { rateLimit, tooMany, clientIp };
