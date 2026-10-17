// Start a notification: creates the event, resolves recipients from the selected groups, queues one SMS
// delivery per consenting person, then wakes the background worker.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMNS_WORKER_SECRET.
//
// SECURITY: uses the service-role key, so the caller is verified here. Recipients are NEVER taken from the
// request: they come from the groups, server-side, inside the database function, and only people who consented
// and have not opted out are queued. Groups must belong to the caller's organization.
// ROLES (P6): viewers cannot send. Operators may send drills and tests only. Real alerts need sender or admin (or platform admin).
//
// Request:  POST { kind: 'alert'|'drill'|'test', body?, group_ids?: [uuid], scenario_id?: uuid, requires_ack?: boolean, idempotency_key?: string,
//                  channels?: ['sms'|'email'|'voice', ...] (default ['sms']; order matters in fallback mode),
//                  fallback_after_seconds?: 0-86400 (fallback mode only; 0 = move to the next channel only when one fails; N = also move on if the person has not acknowledged within N seconds),
//                  mode?: 'together'|'fallback' (default 'together'; fallback sends the first usable channel and the next one only if it fails),
//                  email_subject?: string,
//                  voice_text?: string (what is spoken on a call; defaults to the message),
//                  voice_max_attempts?: 1-5 (default 2), voice_retry_seconds?: 30-3600 (default 120) }
//           + Authorization: Bearer <supabase session token>
//           body and group_ids may come from the scenario. body is required for alerts and optional for drills and tests.
// The text recipients get is built here (brand, organization name, DRILL/TEST tag, opt-out wording), never taken verbatim.
// Response: 200 { ok:true, event_id, queued, skipped, skipped_no_consent, skipped_opted_out, deduplicated } | 4xx/5xx { error }

const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { requireOperator, json } = require('../../src/server/auth/requireOperator.cjs');
const { rateLimit, tooMany } = require('../../src/server/rateLimit.cjs');
const { internalBaseUrl, functionUrl } = require('../../src/server/runtime.cjs');
const { formatMessage } = require('../../src/server/broadcast/messageFormat.cjs');
const { formatEmail } = require('../../src/server/broadcast/emailFormat.cjs');
const { formatVoice } = require('../../src/server/broadcast/voiceFormat.cjs');
const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const ALERT_ROLES = ['admin', 'sender'];
const DRILL_ROLES = ['admin', 'sender', 'operator'];
const MAX_BODY = 1600;
const MAX_GROUPS = 50;
const KINDS = ['alert', 'drill', 'test'];
const UUID_RE = /^[0-9a-f-]{36}$/i;
const CHANNELS = ['sms', 'email', 'voice'];
const clampInt = (v, lo, hi, dflt) => { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return dflt; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
const MODES = ['together', 'fallback'];

async function kickWorker(event, env = process.env, fetchImpl = globalThis.fetch) {
  const secret = env.EMNS_WORKER_SECRET;
  if (!secret) return false; // the per-minute sweeper will still pick the work up
  const base = internalBaseUrl(event, env);
  try {
    await fetchImpl(functionUrl(base, 'send-worker-background'), { method: 'POST', headers: { 'x-emns-worker-secret': secret } });
    return true;
  } catch (e) {
    console.error('send-event: could not wake worker', e);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await requireOperator(event, supabase, DRILL_ROLES);
  if (auth.error) return auth.error;
  const caller = auth.operator;
  const rl = await rateLimit(supabase, `send-event:${caller.id}`, 20, 60);
  if (!rl.ok) return tooMany(rl);

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const kind = payload.kind;
  if (!KINDS.includes(kind)) return json(400, { error: 'kind must be alert, drill or test.' });
  if (kind === 'alert' && !caller.is_platform_admin && !ALERT_ROLES.includes(caller.role)) {
    return json(403, { error: 'Only senders and admins can send real alerts. You can run drills and tests.' });
  }

  // Optional scenario: supplies the message and groups unless the request gives its own.
  let scenario = null;
  if (payload.scenario_id) {
    if (typeof payload.scenario_id !== 'string' || !UUID_RE.test(payload.scenario_id)) return json(400, { error: 'Invalid scenario id.' });
    const { data } = await supabase.from('notification_scenarios')
      .select('id, kind, bodies, default_group_ids, requires_ack')
      .eq('id', payload.scenario_id).eq('organization_id', caller.organization_id).maybeSingle();
    if (!data) return json(400, { error: 'Scenario not found.' });
    scenario = data;
  }

  const ownBody = typeof payload.body === 'string' ? payload.body.trim() : '';
  const rawBody = ownBody || (scenario && scenario.bodies && typeof scenario.bodies.sms === 'string' ? scenario.bodies.sms.trim() : '');
  const ownGroups = Array.isArray(payload.group_ids) ? [...new Set(payload.group_ids)] : [];
  const groupIds = ownGroups.length ? ownGroups : [...new Set((scenario && scenario.default_group_ids) || [])];
  const requiresAck = payload.requires_ack !== undefined ? payload.requires_ack !== false : !(scenario && scenario.requires_ack === false);

  // Channels: validated here, and again inside the database function.
  const channels = payload.channels === undefined ? ['sms'] : payload.channels;
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every((c) => CHANNELS.includes(c)) || new Set(channels).size !== channels.length) {
    return json(400, { error: 'channels must be a list of sms, email and/or voice, each at most once.' });
  }
  const mode = payload.mode === undefined ? 'together' : payload.mode;
  if (!MODES.includes(mode)) return json(400, { error: 'mode must be together or fallback.' });
  const fallbackAfter = mode === 'fallback' ? clampInt(payload.fallback_after_seconds, 0, 86400, 0) : 0;
  const scenarioEmail = scenario && scenario.bodies && scenario.bodies.email && typeof scenario.bodies.email === 'object' ? scenario.bodies.email : {};
  const emailSubjectGiven = typeof payload.email_subject === 'string' && payload.email_subject.trim() ? payload.email_subject : (typeof scenarioEmail.subject === 'string' ? scenarioEmail.subject : '');

  if (kind === 'alert' && !rawBody) return json(400, { error: 'Message cannot be empty.' });
  if (groupIds.length === 0) return json(400, { error: 'Select at least one group.' });
  if (groupIds.length > MAX_GROUPS) return json(400, { error: `Select at most ${MAX_GROUPS} groups.` });
  if (!groupIds.every((g) => typeof g === 'string' && UUID_RE.test(g))) return json(400, { error: 'Invalid group id.' });

  const { data: org } = await supabase.from('organizations').select('name, settings').eq('id', caller.organization_id).maybeSingle();
  const settings = (org && org.settings) || {};
  // The recipient-facing text is built here: brand, organization, DRILL/TEST tag (configurable per organization), opt-out wording.
  const body = formatMessage({ kind, orgName: org && org.name, body: rawBody, requiresAck, drillTag: settings.drill_tag, testTag: settings.test_tag });
  if (body.length > MAX_BODY) return json(400, { error: `Message is too long (max ${MAX_BODY} characters including the standard wording).` });

  // The spoken call text is built here too (brand, organization, drill/test wording); the keypad prompt is added when the call connects.
  let voice = null;
  if (channels.includes('voice')) {
    const scenarioVoice = scenario && scenario.bodies && typeof scenario.bodies.voice === 'string' ? scenario.bodies.voice.trim() : '';
    const spokenRaw = (typeof payload.voice_text === 'string' && payload.voice_text.trim()) || ownBody || scenarioVoice || rawBody;
    voice = formatVoice({ kind, orgName: org && org.name, body: spokenRaw });
    if (voice.length > 1000) return json(400, { error: 'The spoken message is too long (max 1000 characters including the standard wording).' });
  }
  const voiceAttempts = clampInt(payload.voice_max_attempts, 1, 5, 2);
  const voiceRetrySeconds = clampInt(payload.voice_retry_seconds, 30, 3600, 120);

  // The email subject and text are built here too (brand, organization, DRILL/TEST tag, footer), never taken verbatim.
  let email = null;
  if (channels.includes('email')) {
    const emailBodyRaw = ownBody || (typeof scenarioEmail.body === 'string' ? scenarioEmail.body.trim() : '') || rawBody;
    email = formatEmail({ kind, orgName: org && org.name, subject: emailSubjectGiven, body: emailBodyRaw, requiresAck, drillTag: settings.drill_tag, testTag: settings.test_tag });
  }

  const { data, error } = await supabase.rpc('create_notification_event', {
    p_org: caller.organization_id,
    p_kind: kind,
    p_body: body,
    p_group_ids: groupIds,
    p_created_by: caller.id,
    p_requires_ack: requiresAck,
    p_scenario: scenario ? scenario.id : null,
    p_idempotency_key: typeof payload.idempotency_key === 'string' && payload.idempotency_key ? payload.idempotency_key.slice(0, 100) : null,
    p_channels: channels,
    p_mode: mode,
    p_email_subject: email ? email.subject : null,
    p_email_body: email ? email.text : null,
    p_voice_text: voice,
    p_voice_max_attempts: voiceAttempts,
    p_voice_retry_seconds: voiceRetrySeconds,
  });
  if (error) {
    const msg = error.message || 'Could not create the notification.';
    return json(/group|body|kind|channel|mode|subject|voice/i.test(msg) ? 400 : 500, { error: msg });
  }

  if (!data.deduplicated && fallbackAfter > 0) {
    const { error: fbErr } = await supabase.from('notification_events').update({ fallback_after_seconds: fallbackAfter }).eq('id', data.event_id);
    if (fbErr) console.error('could not set fallback delay', fbErr.message);
  }
  if (!data.deduplicated && data.queued > 0) await kickWorker(event);
  return json(200, { ok: true, ...data });
};
exports.kickWorker = kickWorker;
