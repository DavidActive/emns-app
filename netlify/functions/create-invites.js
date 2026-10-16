// Creates one-time enrollment links for people who have not consented yet. Returns the links ONCE (only hashes are stored).
// POST { person_ids?: [uuid], group_id?: uuid }  + Authorization: Bearer <session token>   (admin / sender / platform admin)
// With no person_ids, every active person who is not yet consented (optionally only those in group_id) gets a link.
// Response: { ok:true, created, skipped, invites:[{ person_id, full_name, email, mobile_phone, link }] }
const crypto = require('crypto');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { requireOperator, json } = require('../../src/server/auth/requireOperator.cjs');
const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] });

const ROLES = ['admin', 'sender'];
const MAX = 5000;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const PAGE = 1000;

async function fetchPeople(orgId, ids, groupId) {
  const out = [];
  let allowed = null;
  if (groupId) {
    const { data: gm } = await supabase.from('group_members').select('person_id').eq('group_id', groupId).limit(100000);
    allowed = new Set((gm || []).map((r) => r.person_id));
  }
  for (let from = 0; from < 100000; from += PAGE) {
    let q = supabase.from('people').select('id, full_name, email, mobile_phone, consent_status, is_active').eq('organization_id', orgId).eq('is_active', true);
    if (ids) q = q.in('id', ids);
    const { data, error } = await q.order('full_name').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE || ids) break;
  }
  return out.filter((p) => p.consent_status !== 'consented' && (!allowed || allowed.has(p.id)));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireOperator(event, supabase, ROLES);
  if (auth.error) return auth.error;
  const operator = auth.operator;

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const ids = Array.isArray(payload.person_ids) ? [...new Set(payload.person_ids)] : null;
  if (ids && (ids.length === 0 || ids.length > MAX || !ids.every((i) => typeof i === 'string' && UUID_RE.test(i)))) {
    return json(400, { error: `Provide 1 to ${MAX} valid person ids.` });
  }
  if (payload.group_id && !UUID_RE.test(String(payload.group_id))) return json(400, { error: 'Invalid group id.' });

  let people;
  try { people = await fetchPeople(operator.organization_id, ids, payload.group_id || null); }
  catch (e) { console.error('create-invites: roster read failed', e); return json(500, { error: 'Could not read the roster.' }); }
  if (people.length > MAX) return json(400, { error: `That is more than ${MAX} people. Filter by group and try again.` });
  if (people.length === 0) return json(200, { ok: true, created: 0, skipped: ids ? ids.length : 0, invites: [] });

  const tokens = new Map(); // person_id -> token (plaintext exists only in this response)
  const rows = people.map((p) => {
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(p.id, token);
    return { person_id: p.id, token_hash: crypto.createHash('sha256').update(token).digest('hex') };
  });
  const { data: created, error } = await supabase.rpc('create_enrollment_invites', {
    p_org: operator.organization_id, p_invites: rows, p_created_by: operator.id, p_ttl_days: 30,
  });
  if (error) { console.error('create-invites: rpc failed', error); return json(500, { error: 'Could not create the links.' }); }

  const base = (process.env.URL || `https://${(event.headers || {}).host}`).replace(/\/$/, '');
  const made = new Set(created || []);
  const invites = people.filter((p) => made.has(p.id)).map((p) => ({
    person_id: p.id, full_name: p.full_name, email: p.email, mobile_phone: p.mobile_phone, link: `${base}/enroll/${tokens.get(p.id)}`,
  }));
  return json(200, { ok: true, created: invites.length, skipped: (ids ? ids.length : people.length) - invites.length, invites });
};
