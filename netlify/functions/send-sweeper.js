// Scheduled every minute (see netlify.toml). Safety net: if there is queued work that is due, or a claim that
// expired because a worker died, wake the background worker. Does nothing when the queue is empty.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMNS_WORKER_SECRET.

const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { internalBaseUrl, functionUrl } = require('../../src/server/runtime.cjs');

const LEASE_SECONDS = 120;

exports.handler = async () => {
  const env = process.env;
  if (!env.EMNS_WORKER_SECRET) return { statusCode: 200, body: 'EMNS_WORKER_SECRET not set; sweeper idle' };
  const db = getDb();
  // Timed fallback: release the next channel for people who have not acknowledged in time.
  const esc = await db.rpc('escalate_unacknowledged');
  if (esc.error) console.error('escalate_unacknowledged failed', esc.error.message);
  const escalated = esc.data || 0;
  // Desktop alerts are collected by the desktop agent, not sent by the worker. One nobody picked up in time becomes "undelivered"
  // so the person's next channel can go out (a computer that reconnects later still receives it).
  const exp = await db.rpc('expire_desktop_deliveries', { p_ttl_seconds: Math.max(10, Number(env.EMNS_DESKTOP_WAIT_SECONDS) || 120) });
  if (exp.error) console.error('expire_desktop_deliveries failed', exp.error.message);
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - LEASE_SECONDS * 1000).toISOString();
  const { count, error } = await db
    .from('notification_deliveries')
    .select('id', { count: 'exact', head: true })
    .neq('channel', 'desktop')
    .or(`and(status.eq.queued,next_attempt_at.lte.${nowIso}),and(status.eq.sending,locked_at.lt.${staleIso})`);
  if (error) { console.error('send-sweeper query failed', error.message); return { statusCode: 500, body: error.message }; }
  if (!count && !escalated) return { statusCode: 200, body: 'idle' };
  const base = internalBaseUrl({}, env);
  if (!base) return { statusCode: 200, body: 'URL not set' };
  await fetch(functionUrl(base, 'send-worker-background'), { method: 'POST', headers: { 'x-emns-worker-secret': env.EMNS_WORKER_SECRET } });
  return { statusCode: 200, body: `woke worker for ${count} pending deliveries` };
};
