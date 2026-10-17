// Desktop agent report. The agent says what happened to an alert it was handed.
//   POST { delivery_id, action: 'shown'|'dismiss'|'ack', response?: 'SAFE'|'SOS' } + Authorization: Bearer <device token>
//   shown   = the alert is on the screen (the delivery becomes "delivered")
//   dismiss = the person closed an alert that needs no answer
//   ack     = the person clicked "I'm safe" (SAFE) or "I need help" (SOS); counted in the roll-call like a text reply, and SOS opens a critical inbox item
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');
const { hashToken, bearer } = require('../../src/server/agentToken.cjs');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const UUID_RE = /^[0-9a-f-]{36}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const hash = hashToken(bearer(event));
  if (!hash) return json(401, { error: 'revoked' });
  const db = getDb();
  const rl = await rateLimit(db, `agent-report:${hash.slice(0, 16)}`, 120, 60);
  if (!rl.ok) return tooMany(rl);

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
  if (typeof payload.delivery_id !== 'string' || !UUID_RE.test(payload.delivery_id)) return json(400, { error: 'Invalid alert.' });
  if (!['shown', 'dismiss', 'ack'].includes(payload.action)) return json(400, { error: 'Unknown action.' });
  if (payload.action === 'ack' && !['SAFE', 'SOS'].includes(payload.response)) return json(400, { error: 'response must be SAFE or SOS.' });

  const { data, error } = await db.rpc('agent_report', { p_token_hash: hash, p_delivery: payload.delivery_id, p_action: payload.action, p_response: payload.response || null });
  if (error) return json(500, { error: 'Could not record that.' });
  if (!data || data.ok === false) {
    if (data && data.reason === 'revoked') return json(401, { error: 'revoked' });
    if (data && data.reason === 'not_found') return json(404, { error: 'Alert not found.' });
    return json(400, { error: 'Could not record that.' });
  }
  return json(200, { ok: true, duplicate: !!data.duplicate });
};
