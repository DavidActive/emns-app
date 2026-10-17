// Employee self-service: an employee reads and edits ONLY their own mobile number and email.
// POST { action: 'get' }  or  { action: 'update', mobile_phone?, email? }
// The record is found from the verified sign-in identity (AuthProvider); the request never names a person, so there is nothing to tamper with.
// Changing the mobile number moves a consented person back to "pending" (they agreed to texts at the old number). Every change is written to audit_log.
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { getAuthProvider } = require('../../src/server/auth/authProvider.cjs');
const { normalizePhone } = require('../../src/server/phone.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const db = getDb();
  const h = event.headers || {};
  const token = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  const auth = await getAuthProvider(db).verify(token);
  if (!auth.ok) return json(401, { error: 'Invalid or expired session.' });

  const rl = await rateLimit(db, `my-contact:${auth.identity.key}`, 30, 600);
  if (!rl.ok) return tooMany(rl);
  const column = auth.identity.provider === 'oidc' ? 'idp_subject' : 'user_id';
  const { data: person } = await db.from('people')
    .select('id, organization_id, full_name, mobile_phone, email, consent_status, is_active')
    .eq(column, auth.identity.key).eq('is_active', true).maybeSingle();
  if (!person) return json(403, { error: 'This account is not linked to an employee record. Ask your administrator.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

  const view = (p) => ({ full_name: p.full_name, mobile_phone: p.mobile_phone, email: p.email, consent_status: p.consent_status });
  if (payload.action === 'get' || payload.action === undefined) {
    const { data: org } = await db.from('organizations').select('name').eq('id', person.organization_id).maybeSingle();
    return json(200, { ok: true, organization: (org && org.name) || null, person: view(person) });
  }
  if (payload.action !== 'update') return json(400, { error: 'Unknown action.' });

  let mobile = null;
  if (payload.mobile_phone !== undefined && payload.mobile_phone !== null && String(payload.mobile_phone).trim() !== '') {
    mobile = normalizePhone(payload.mobile_phone);
    if (!mobile) return json(400, { error: 'Enter a valid mobile number, for example (555) 123-4567.' });
  }
  let email = null;
  if (payload.email !== undefined && payload.email !== null) {
    email = String(payload.email).trim();
    if (email !== '' && (!EMAIL_RE.test(email) || email.length > 254)) return json(400, { error: 'Enter a valid email address.' });
  }
  if (mobile === null && email === null) return json(400, { error: 'Nothing to change.' });

  const { data, error } = await db.rpc('self_update_contact', {
    p_person: person.id, p_mobile: mobile, p_email: email, p_actor: `${auth.identity.provider}:${auth.identity.key}`,
  });
  if (error) {
    if (/could not be used/i.test(error.message)) return json(409, { error: 'That number could not be used. Contact your administrator.' });
    return json(500, { error: 'Could not save your changes.' });
  }
  const { data: fresh } = await db.from('people').select('full_name, mobile_phone, email, consent_status').eq('id', person.id).maybeSingle();
  return json(200, { ok: true, changed: data.changed, consent_reset: data.consent_reset, person: fresh ? view(fresh) : null });
};
