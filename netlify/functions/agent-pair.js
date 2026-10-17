// Desktop agent pairing, for employees. The employee signs in (same identity as "My contact details") and:
//   POST { action: 'create_code' }                  -> { code: 'ABCD-2345', expires_in_seconds }   (type this into the agent, once)
//   POST { action: 'list' }                         -> { devices: [{ id, device_name, platform, enrolled_at, last_seen_at }] }
//   POST { action: 'revoke', device_id }            -> { ok: true }                                  (that computer stops receiving alerts)
// The person is found from the verified sign-in identity, never from the request, so nobody can pair a computer to someone else.
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { getAuthProvider } = require('../../src/server/auth/authProvider.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');
const { newPairingCode, hashCode } = require('../../src/server/agentToken.cjs');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const UUID_RE = /^[0-9a-f-]{36}$/i;
const CODE_TTL_SECONDS = 600;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const db = getDb();
  const h = event.headers || {};
  const token = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  const auth = await getAuthProvider(db).verify(token);
  if (!auth.ok) return json(401, { error: 'Invalid or expired session.' });

  const rl = await rateLimit(db, `agent-pair:${auth.identity.key}`, 20, 600);
  if (!rl.ok) return tooMany(rl);
  const column = auth.identity.provider === 'oidc' ? 'idp_subject' : 'user_id';
  const { data: person } = await db.from('people').select('id, organization_id, is_active')
    .eq(column, auth.identity.key).eq('is_active', true).maybeSingle();
  if (!person) return json(403, { error: 'This account is not linked to an employee record. Ask your administrator.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

  if (payload.action === 'create_code') {
    const code = newPairingCode();
    const { data, error } = await db.rpc('create_agent_pairing', { p_person: person.id, p_code_hash: hashCode(code), p_ttl_seconds: CODE_TTL_SECONDS });
    if (error || !data || data.ok === false) return json(500, { error: 'Could not create a code. Try again.' });
    return json(200, { ok: true, code, expires_in_seconds: CODE_TTL_SECONDS });
  }
  if (payload.action === 'list' || payload.action === undefined) {
    const { data } = await db.from('agent_devices').select('id, device_name, platform, enrolled_at, last_seen_at')
      .eq('person_id', person.id).is('revoked_at', null).order('enrolled_at', { ascending: false });
    return json(200, { ok: true, devices: data || [] });
  }
  if (payload.action === 'revoke') {
    if (typeof payload.device_id !== 'string' || !UUID_RE.test(payload.device_id)) return json(400, { error: 'Invalid device.' });
    const { data, error } = await db.rpc('revoke_agent_device_for_person', { p_person: person.id, p_device: payload.device_id });
    if (error) return json(500, { error: 'Could not remove that computer.' });
    return data ? json(200, { ok: true }) : json(404, { error: 'That computer was not found.' });
  }
  return json(400, { error: 'Unknown action.' });
};
