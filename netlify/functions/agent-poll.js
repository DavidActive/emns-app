// Desktop agent poll (long poll). The agent keeps ONE outbound HTTPS request open to this address; nothing is ever pushed to the workstation.
//   POST { version? } + Authorization: Bearer <device token>
//   -> 200 { ok:true, alerts:[{ delivery_id, event_id, kind, body, requires_ack, created_at, organization }], dismiss:[delivery_id], poll_seconds }
//   -> 401 { error:'revoked' }  the computer was removed: the agent must forget its token and ask to be paired again.
// Waits up to EMNS_AGENT_POLL_SECONDS (default 8, max 25) for something to show, checking every 2 seconds. Netlify cuts synchronous
// functions off at 10 seconds by default; the container server has no such limit, so raise the value there for fewer requests.
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { hashToken, bearer } = require('../../src/server/agentToken.cjs');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const hash = hashToken(bearer(event));
  if (!hash) return json(401, { error: 'revoked' });
  const db = getDb();
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch { /* an empty or odd body just means no version */ }
  const version = typeof payload.version === 'string' ? payload.version.slice(0, 40) : null;

  const configured = process.env.EMNS_AGENT_POLL_SECONDS;
  const waitSeconds = Math.min(25, Math.max(0, configured !== undefined && configured !== '' && Number.isFinite(Number(configured)) ? Number(configured) : 8)); // 0 is a valid setting: answer at once
  const stepMs = Number(process.env.EMNS_AGENT_POLL_STEP_MS) || 2000;
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const { data, error } = await db.rpc('agent_claim', { p_token_hash: hash, p_version: version });
    if (error) { console.error('agent_claim failed', error.message); return json(503, { error: 'unavailable', retry_seconds: 15 }); }
    if (!data || data.ok === false) return json(401, { error: 'revoked' });
    if ((data.alerts && data.alerts.length) || (data.dismiss && data.dismiss.length) || Date.now() + stepMs > deadline) {
      return json(200, { ok: true, alerts: data.alerts || [], dismiss: data.dismiss || [], poll_seconds: waitSeconds });
    }
    await sleep(stepMs);
  }
};
