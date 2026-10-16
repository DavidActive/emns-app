// Start a notification: creates the event, resolves recipients from the selected groups, queues one SMS
// delivery per person, then wakes the background worker.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMNS_WORKER_SECRET.
//
// SECURITY: uses the service-role key, so the caller is verified here. Recipients are NEVER taken from the
// request: they come from the groups, server-side, inside the database function. Groups must belong to the
// caller's organization (checked in the database function). Roles allowed: admin, sender (or platform admin).
//
// Request:  POST { kind: 'alert'|'drill'|'test', body, group_ids: [uuid], requires_ack?: boolean, idempotency_key?: string }
//           + Authorization: Bearer <supabase session token>
// Response: 200 { ok:true, event_id, queued, skipped, deduplicated } | 4xx/5xx { error }

const { getDb } = require('../../src/server/providers/dataStore.cjs');
const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const SENDER_ROLES = ['admin', 'sender'];
const MAX_BODY = 1600;
const MAX_GROUPS = 50;
const KINDS = ['alert', 'drill', 'test'];
const PREFIX = { drill: '[DRILL] ', test: '[TEST] ' };

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function kickWorker(event, env = process.env, fetchImpl = globalThis.fetch) {
  const secret = env.EMNS_WORKER_SECRET;
  if (!secret) return false; // the per-minute sweeper will still pick the work up
  const base = (env.URL || `https://${(event.headers || {}).host}`).replace(/\/$/, '');
  try {
    await fetchImpl(`${base}/.netlify/functions/send-worker-background`, { method: 'POST', headers: { 'x-emns-worker-secret': secret } });
    return true;
  } catch (e) {
    console.error('send-event: could not wake worker', e);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const authHeader = (event.headers || {}).authorization || (event.headers || {}).Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization header.' });
  const { data: callerAuth, error: callerAuthError } = await supabase.auth.getUser(token);
  if (callerAuthError || !callerAuth?.user) return json(401, { error: 'Invalid or expired session.' });

  const { data: caller } = await supabase
    .from('operators').select('id, organization_id, role, is_platform_admin')
    .eq('user_id', callerAuth.user.id).maybeSingle();
  if (!caller) return json(403, { error: 'No staff profile for this account.' });
  if (!caller.organization_id) return json(403, { error: 'Your account is not attached to an organization.' });
  if (!caller.is_platform_admin && !SENDER_ROLES.includes(caller.role)) {
    return json(403, { error: 'Your role does not allow sending notifications.' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const kind = payload.kind;
  let body = typeof payload.body === 'string' ? payload.body.trim() : '';
  const groupIds = Array.isArray(payload.group_ids) ? [...new Set(payload.group_ids)] : [];
  if (!KINDS.includes(kind)) return json(400, { error: 'kind must be alert, drill or test.' });
  if (!body) return json(400, { error: 'Message cannot be empty.' });
  if (groupIds.length === 0) return json(400, { error: 'Select at least one group.' });
  if (groupIds.length > MAX_GROUPS) return json(400, { error: `Select at most ${MAX_GROUPS} groups.` });
  if (!groupIds.every((g) => typeof g === 'string' && /^[0-9a-f-]{36}$/i.test(g))) return json(400, { error: 'Invalid group id.' });
  // Safety: drills and tests are always labelled so nobody mistakes them for a real emergency.
  if (PREFIX[kind] && !body.startsWith(PREFIX[kind])) body = PREFIX[kind] + body;
  if (body.length > MAX_BODY) return json(400, { error: `Message is too long (max ${MAX_BODY} characters).` });

  const { data, error } = await supabase.rpc('create_notification_event', {
    p_org: caller.organization_id,
    p_kind: kind,
    p_body: body,
    p_group_ids: groupIds,
    p_created_by: caller.id,
    p_requires_ack: payload.requires_ack !== false,
    p_scenario: null,
    p_idempotency_key: typeof payload.idempotency_key === 'string' && payload.idempotency_key ? payload.idempotency_key.slice(0, 100) : null,
  });
  if (error) {
    const msg = error.message || 'Could not create the notification.';
    return json(/group|body|kind/i.test(msg) ? 400 : 500, { error: msg });
  }

  if (!data.deduplicated && data.queued > 0) await kickWorker(event);
  return json(200, { ok: true, ...data });
};
exports.kickWorker = kickWorker;
