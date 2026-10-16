// Background worker (Netlify background function: returns 202 immediately, runs up to 15 minutes).
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMNS_WORKER_SECRET. Twilio vars when the Twilio provider is on.
// Tuning (all optional): EMNS_SEND_RATE_PER_SEC (default 5 for Twilio, unlimited for mock), EMNS_SEND_BATCH (50), EMNS_SEND_CONCURRENCY (10).
//
// Safe to run many copies at once and to kill at any time (see src/server/broadcast/worker.cjs).
// Before the 15-minute limit it stops claiming new work and starts a fresh copy of itself.

const crypto = require('crypto');
const { getDb } = require('../../src/server/providers/dataStore.cjs');
const { getMessageProvider } = require('../../src/server/providers/index.cjs');
const { runWorker } = require('../../src/server/broadcast/worker.cjs');
const { baseUrl } = require('../../src/server/providers/twilioSignature.cjs');

const RUN_BUDGET_MS = 13 * 60 * 1000;

function secretOk(event, env = process.env) {
  const expected = env.EMNS_WORKER_SECRET || '';
  const given = (event.headers || {})['x-emns-worker-secret'] || '';
  if (!expected || !given) return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  const env = process.env;
  if (!secretOk(event, env)) return { statusCode: 401, body: 'Unauthorized' };

  const provider = getMessageProvider(env);
  const isMock = provider.name === 'mock';
  const stats = await runWorker({
    db: getDb(),
    provider,
    workerId: `bg-${crypto.randomUUID()}`,
    batchSize: Number(env.EMNS_SEND_BATCH) || 50,
    concurrency: Number(env.EMNS_SEND_CONCURRENCY) || 10,
    ratePerSec: Number(env.EMNS_SEND_RATE_PER_SEC) || (isMock ? 0 : 5),
    maxRuntimeMs: RUN_BUDGET_MS,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || undefined,
    statusCallback: `${baseUrl(event, env)}/.netlify/functions/sms-status`,
  });
  console.log('send-worker', JSON.stringify(stats));

  if (stats.timedOut) { // more work remains: continue in a fresh invocation
    try {
      const base = (env.URL || baseUrl(event, env)).replace(/\/$/, '');
      await fetch(`${base}/.netlify/functions/send-worker-background`, { method: 'POST', headers: { 'x-emns-worker-secret': env.EMNS_WORKER_SECRET } });
    } catch (e) { console.error('send-worker: could not chain next run', e); }
  }
  return { statusCode: 200, body: JSON.stringify(stats) };
};
exports.secretOk = secretOk;
