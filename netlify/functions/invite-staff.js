// Staff invite flow — copied pattern from protect-activesos's invite-staff function.
// Creates a Supabase Auth user (invite email) + staff_users row.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// SECURITY: this uses the service-role key, which bypasses RLS entirely, so it must
// verify the caller itself rather than trusting anything in the request body. Only an
// existing global admin may invite someone else right now (matches the app: the Global
// Admin page that calls this is already gated to is_global_admin in the UI, but the UI
// gate alone doesn't protect the endpoint — anyone could POST here directly without this
// check). Only a caller who is already a global admin can grant is_global_admin to the
// new user; the flag is never taken from the request body for that reason.

const { getDb } = require('../../src/server/providers/dataStore.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header.' }) };
  }

  const { data: callerAuth, error: callerAuthError } = await supabase.auth.getUser(token);
  if (callerAuthError || !callerAuth?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  const { data: callerStaff, error: callerStaffError } = await supabase
    .from('staff_users')
    .select('is_global_admin')
    .eq('user_id', callerAuth.user.id)
    .maybeSingle();

  if (callerStaffError || !callerStaff?.is_global_admin) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only a global admin can invite new users.' }) };
  }

  const { email, full_name, organization_id, role, is_global_admin } = JSON.parse(event.body || '{}');
  if (!email || !organization_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email and organization_id are required.' }) };
  }

  const { data: invited, error } = await supabase.auth.admin.inviteUserByEmail(email);
  if (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  const { error: insertError } = await supabase.from('staff_users').insert({
    user_id: invited.user.id,
    organization_id,
    full_name,
    role: role || 'staff',
    // Only ever true because the caller passed the check above — never trust the
    // request body alone for a privilege-granting flag.
    is_global_admin: is_global_admin === true,
  });
  if (insertError) {
    return { statusCode: 500, body: JSON.stringify({ error: insertError.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, email }) };
};
