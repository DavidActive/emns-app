// Creates one-time enrollment links for people who have not consented yet. Returns the links ONCE (only hashes are stored).
// POST { person_ids?: [uuid], group_id?: uuid }  + Authorization: Bearer <session token>   (admin / sender / platform admin)
// With no person_ids, every active person who is not yet consented (optionally only those in group_id) gets a link.
// Add send_email:true to email each person their own link (never texted: texting before consent is not allowed).
// Response: { ok:true, created, skipped, invites:[{ person_id, full_name, email, mobile_phone, link }], emailed, no_email, email_failed }
// With send_email, links that were emailed are NOT returned (the person holds the only copy); the rest are returned for hand delivery.
const crypto = require('crypto');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { requireOperator, json } = require('../../src/server/auth/requireOperator.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');
const { publicBaseUrl } = require('../../src/server/runtime.cjs');
const { getEmailProvider } = require('../../src/server/providers/index.cjs');
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
    let q = supabase.from('people').select('id, full_name, email, mobile_phone, consent_status, is_active, email_opted_out, email_bounced_at').eq('organization_id', orgId).eq('is_active', true);
    if (ids) q = q.in('id', ids);
    const { data, error } = await q.order('full_name').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE || ids) break;
  }
  return out.filter((p) => p.consent_status !== 'consented' && (!allowed || allowed.has(p.id)));
}

function inviteEmail(orgName, person, link) {
  const first = String(person.full_name || '').split(' ')[0] || 'there';
  return {
    subject: `${orgName}: please sign up for emergency text alerts`,
    body: `Hello ${first},\n\n${orgName} uses Active SOS eMNS to send emergency alerts, drills and safety check-ins by text message. `
      + `You will not receive any texts until you agree.\n\nTo review the details and agree, open your personal link (it works once and expires in 30 days):\n${link}\n\n`
      + `If you did not expect this, ignore this email or contact ${orgName}. Please do not forward this link.\n\nActive SOS eMNS\nsupport@activesos.com`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireOperator(event, supabase, ROLES);
  if (auth.error) return auth.error;
  const operator = auth.operator;
  const rl = await rateLimit(supabase, `create-invites:${operator.id}`, 30, 60);
  if (!rl.ok) return tooMany(rl);

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

  const base = publicBaseUrl(event);
  const made = new Set(created || []);
  const invites = people.filter((p) => made.has(p.id)).map((p) => ({
    person_id: p.id, full_name: p.full_name, email: p.email, mobile_phone: p.mobile_phone, link: `${base}/enroll/${tokens.get(p.id)}`,
  }));
  const skipped = (ids ? ids.length : people.length) - invites.length;
  if (payload.send_email !== true) return json(200, { ok: true, created: invites.length, skipped, invites });

  const { data: org } = await supabase.from('organizations').select('name').eq('id', operator.organization_id).maybeSingle();
  const orgName = (org && org.name) || 'Your organization';
  const byId = new Map(people.map((p) => [p.id, p]));
  let provider;
  try { provider = getEmailProvider(); } catch (e) { console.error('create-invites: email provider', e); return json(500, { error: 'Email is not available. Links were created; copy them instead.', invites }); }
  let emailed = 0, noEmail = 0, failed = 0;
  const remaining = [];
  for (const inv of invites) {
    const p = byId.get(inv.person_id);
    if (!p.email || p.email_opted_out || p.email_bounced_at) { noEmail++; remaining.push(inv); continue; }
    const m = inviteEmail(orgName, p, inv.link);
    try {
      await provider.send({ channel: 'email', to: p.email, subject: m.subject, body: m.body, idempotencyKey: `invite:${inv.link.split('/enroll/')[1].slice(0, 16)}` });
      emailed++;
    } catch (e) { failed++; remaining.push(inv); }
  }
  return json(200, { ok: true, created: invites.length, skipped, emailed, no_email: noEmail, email_failed: failed, invites: remaining });
};
