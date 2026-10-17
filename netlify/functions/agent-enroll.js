// Desktop agent enrollment. The agent sends the pairing code the employee typed in; on success it receives a long-lived device token.
//   POST { code, device_name, platform?, version? } -> { ok:true, device_token, person_name, organization }
// No sign-in: the one-time code IS the credential (single use, expires in 10 minutes, rate limited per address). The token is
// generated here and only its hash is stored, so a database leak cannot be replayed against the agent endpoints.
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { rateLimit, tooMany, clientIp } = require('../../src/server/rateLimit.cjs');
const { hashCode, newDeviceToken, hashToken } = require('../../src/server/agentToken.cjs');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const PLATFORMS = ['windows', 'mac', 'linux'];
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const db = getDb();
  const rl = await rateLimit(db, `agent-enroll:${clientIp(event)}`, 10, 60);
  if (!rl.ok) return tooMany(rl);

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
  const codeHash = hashCode(payload.code);
  if (!codeHash) return json(400, { error: 'That code is not valid or has expired. Get a new one from your My contact details page.' });

  const token = newDeviceToken();
  const { data, error } = await db.rpc('enroll_agent_device', {
    p_code_hash: codeHash, p_token_hash: hashToken(token),
    p_device_name: clean(payload.device_name, 100) || 'Computer',
    p_platform: PLATFORMS.includes(payload.platform) ? payload.platform : 'windows',
    p_version: clean(payload.version, 40) || null,
  });
  if (error) return json(500, { error: 'Could not pair this computer. Try again.' });
  if (!data || data.ok === false) {
    if (data && data.reason === 'too_many_devices') return json(409, { error: 'This person already has 5 computers paired. Remove one on the My contact details page first.' });
    return json(400, { error: 'That code is not valid or has expired. Get a new one from your My contact details page.' });
  }
  return json(200, { ok: true, device_token: token, person_name: data.person_name, organization: data.organization });
};
