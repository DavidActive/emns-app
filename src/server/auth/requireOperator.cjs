// Verifies the caller's Supabase session and loads their staff profile. Shared by functions that use the service role,
// so the caller is always checked here and never trusted from the request body.
// Returns { operator } on success or { error: { statusCode, body } } to return as-is.
const { getStaffAuthProvider } = require('./authProvider.cjs');
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function requireOperator(event, db, allowedRoles) {
  const h = event.headers || {};
  const token = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: json(401, { error: 'Missing Authorization header.' }) };
  const auth = await getStaffAuthProvider(db).verify(token);
  if (!auth.ok) return { error: json(401, { error: 'Invalid or expired session.' }) };
  const { data: operator } = await db.from('operators')
    .select('id, organization_id, role, is_platform_admin').eq('user_id', auth.identity.key).maybeSingle();
  if (!operator) return { error: json(403, { error: 'No staff profile for this account.' }) };
  if (!operator.organization_id) return { error: json(403, { error: 'Your account is not attached to an organization.' }) };
  if (!operator.is_platform_admin && !allowedRoles.includes(operator.role)) {
    return { error: json(403, { error: 'Your role does not allow this action.' }) };
  }
  return { operator };
}
module.exports = { requireOperator, json };
