// Admin: let an employee sign in to see and edit their own contact details.
// POST { person_id }                      -> invites the person by email (Supabase Auth) and links the new account to them
// POST { person_id, idp_subject }         -> links an existing OIDC identity ("<issuer>|<sub>") instead
// POST { person_id, unlink: true }        -> removes the link
// Only org admins. The person must belong to the caller's organization.
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { requireOperator, json } = require('../../src/server/auth/requireOperator.cjs');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const db = getDb();
  const { operator, error } = await requireOperator(event, db, ['admin']);
  if (error) return error;
  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
  if (typeof p.person_id !== 'string' || !UUID_RE.test(p.person_id)) return json(400, { error: 'Invalid person id.' });
  const { data: person } = await db.from('people').select('id, email, full_name')
    .eq('id', p.person_id).eq('organization_id', operator.organization_id).maybeSingle();
  if (!person) return json(404, { error: 'Person not found.' });

  let userId = null, subject = null;
  if (p.unlink === true) { /* both stay null */ }
  else if (typeof p.idp_subject === 'string' && p.idp_subject.trim()) subject = p.idp_subject.trim().slice(0, 500);
  else {
    if (!person.email) return json(400, { error: 'This person has no email address to send the invitation to.' });
    const { data: invited, error: invErr } = await db.auth.admin.inviteUserByEmail(person.email);
    if (invErr || !invited || !invited.user) return json(409, { error: 'Could not invite that email address. It may already have an account.' });
    userId = invited.user.id;
  }
  const { data: ok, error: linkErr } = await db.rpc('link_person_identity', {
    p_org: operator.organization_id, p_person: person.id, p_actor: operator.id, p_user_id: userId, p_idp_subject: subject,
  });
  if (linkErr || !ok) return json(500, { error: 'Could not link the account.' });
  return json(200, { ok: true, invited: !!userId, linked: !p.unlink });
};
