// Load-test engine (P13). Drives the REAL worker (src/server/broadcast/worker.cjs) against an in-memory model of the queue
// (same claim / retry / fallback rules as the SQL functions) and simulated providers with realistic latency and failures.
//
// "speed" compresses time so large runs finish quickly: every simulated delay (provider latency, retry wait, call length,
// sweeper interval, carrier rate) is divided by speed, and the measured times are multiplied back. Our own code's overhead
// is therefore overstated by a factor of speed, which makes the report conservative.
const { runWorker } = require('../src/server/broadcast/worker.cjs');
const { ProviderError } = require('../src/server/providers/types.cjs');

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }
function percentile(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)); return sorted[i]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
  people: 1000, mode: 'together', channels: ['sms', 'email', 'voice'], speed: 10, seed: 42,
  workers: 1, concurrency: 20, batchSize: 100,
  latencyMs: { sms: 150, email: 300, voice: 500 },          // median provider response time
  permFail: { sms: 0.03, email: 0.02, voice: 0.08 },        // bad number / address: never succeeds, triggers fallback
  transientFail: { sms: 0.02, email: 0.02, voice: 0.03 },   // temporary error: retried
  retryBaseMs: 30000, maxAttempts: 3, sweeperMs: 60000, callMs: 25000,
  rate: { sms: 0, email: 0, voice: 0 },                     // sends per second the carrier/provider will accept (0 = unlimited)
  voiceMaxActive: 0,
};

function createLoadQueue(cfg, clockNow) {
  const rows = []; // one per person per channel
  const people = [];
  for (let i = 0; i < cfg.people; i++) {
    people.push({ id: i, reachedAt: null, doneAt: null });
    cfg.channels.forEach((ch, k) => rows.push({
      id: `d${i}-${ch}`, person: i, channel: ch, idx: k, attempt: 0, locked_by: null, sentAt: null, finalAt: null, nextAt: 0,
      status: cfg.mode === 'fallback' && k > 0 ? 'held' : 'queued', createdAt: clockNow(),
    }));
  }
  const byPerson = new Map();
  rows.forEach((r) => { if (!byPerson.has(r.person)) byPerson.set(r.person, []); byPerson.get(r.person).push(r); });
  const finalWrites = new Map();
  const releaseHeld = (r) => {
    const mine = byPerson.get(r.person);
    if (mine.some((x) => ['queued', 'sending', 'sent', 'delivered'].includes(x.status))) return;
    const next = mine.filter((x) => x.status === 'held').sort((a, b) => a.idx - b.idx)[0];
    if (next) { next.status = 'queued'; next.nextAt = clockNow(); next.releasedAt = clockNow(); }
  };
  const db = {
    rows, people, finalWrites,
    async rpc(name, a) {
      const t = clockNow();
      if (name === 'claim_deliveries') {
        // calls finish after callMs (stand-in for the carrier's status callback)
        rows.forEach((r) => { if (r.channel === 'voice' && r.status === 'sent' && t - r.sentAt >= cfg.callMs / cfg.speed) r.status = 'delivered'; });
        let slots = Infinity;
        if (a.p_voice_max_active > 0) slots = Math.max(0, a.p_voice_max_active - rows.filter((r) => r.channel === 'voice' && (r.status === 'sending' || r.status === 'sent')).length);
        const due = [];
        for (const r of rows) {
          if (due.length >= a.p_limit) break;
          if (r.status !== 'queued' || r.nextAt > t) continue;
          if (r.channel === 'voice') { if (slots <= 0) continue; slots--; }
          due.push(r);
        }
        due.forEach((r) => { r.status = 'sending'; r.locked_by = a.p_worker; r.attempt++; });
        return { data: due.map((r) => ({ delivery_id: r.id, event_id: 'e1', organization_id: 'o1', person_id: `p${r.person}`, channel: r.channel,
          to_number: r.channel === 'email' ? null : '+15550000000', to_email: r.channel === 'email' ? 'x@test.invalid' : null, subject: 's', body: 'b', attempt: r.attempt })), error: null };
      }
      if (name === 'record_delivery_result') {
        const r = rows.find((x) => x.id === a.p_delivery);
        if (!r || r.locked_by !== a.p_worker || r.status !== 'sending') return { data: false, error: null };
        r.locked_by = null;
        if (a.p_outcome === 'sent') { r.status = 'sent'; r.sentAt = t; r.finalAt = t; const p = people[r.person]; if (p.reachedAt === null) p.reachedAt = t; }
        else if (a.p_outcome === 'retry' && r.attempt < cfg.maxAttempts) { r.status = 'queued'; r.nextAt = t + (cfg.retryBaseMs * r.attempt) / cfg.speed; }
        else { r.status = 'failed'; r.finalAt = t; r.errorCode = a.p_error_code; releaseHeld(r); }
        if (r.finalAt) finalWrites.set(r.id, (finalWrites.get(r.id) || 0) + 1);
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
    from() { return { update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; } }; },
    pending() { return rows.filter((r) => r.status === 'queued' || r.status === 'sending').length; },
  };
  return db;
}

function createSimProvider(channel, cfg, rand) {
  const { latencyMs, permFail, transientFail, speed } = cfg;
  const permCode = { sms: '30003', email: 'invalid_email', voice: '21216' }[channel];
  const tempCode = { sms: '30008', email: 'email_unavailable', voice: '503' }[channel];
  let n = 0;
  return {
    name: 'sim',
    async send() {
      const ms = latencyMs[channel] * Math.exp(0.5 * normal(rand)); // lognormal: p99 about 3x the median
      await sleep(ms / speed);
      const x = rand();
      if (x < permFail[channel]) throw new ProviderError('simulated permanent failure', permCode);
      if (x < permFail[channel] + transientFail[channel]) throw new ProviderError('simulated temporary failure', tempCode);
      return { sid: `SIM${channel}${++n}`, status: 'queued' };
    },
  };
}

async function runScenario(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides, latencyMs: { ...DEFAULTS.latencyMs, ...(overrides.latencyMs || {}) }, permFail: { ...DEFAULTS.permFail, ...(overrides.permFail || {}) },
    transientFail: { ...DEFAULTS.transientFail, ...(overrides.transientFail || {}) }, rate: { ...DEFAULTS.rate, ...(overrides.rate || {}) } };
  const rand = rng(cfg.seed);
  const t0 = Date.now();
  const db = createLoadQueue(cfg, Date.now);
  const providers = Object.fromEntries(['sms', 'email', 'voice'].map((c) => [c, createSimProvider(c, cfg, rand)]));
  const ticks = cfg.sweeperMs / cfg.speed;
  const sweeperWait = () => { const el = Date.now() - t0; return Math.max(5, ticks - (el % ticks)); };

  async function workerLoop(w) {
    while (db.pending() > 0) {
      const s = await runWorker({
        db, provider: providers.sms, emailProvider: providers.email, voiceProvider: providers.voice, voiceBaseUrl: 'https://x/.netlify/functions',
        workerId: `w${w}-${Date.now()}-${Math.random()}`, batchSize: cfg.batchSize, concurrency: cfg.concurrency,
        ratePerSec: cfg.rate.sms * cfg.speed, emailRatePerSec: cfg.rate.email * cfg.speed, voiceRatePerSec: cfg.rate.voice * cfg.speed, voiceMaxActive: cfg.voiceMaxActive,
      });
      if (s.claimed === 0 && db.pending() > 0) await sleep(sweeperWait()); // nothing due: the next once-a-minute sweep wakes the worker
    }
  }
  await Promise.all(Array.from({ length: cfg.workers }, (_, w) => workerLoop(w)));
  const end = Date.now();
  const K = cfg.speed;
  db.people.forEach((p, i) => {
    const mine = db.rows.filter((r) => r.person === i);
    p.doneAt = Math.max(...mine.map((r) => r.finalAt || 0)) || end;
  });
  const secs = (ms) => (ms * K) / 1000;
  const dist = (vals) => { const s = vals.slice().sort((a, b) => a - b); return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] }; };
  const reached = db.people.filter((p) => p.reachedAt !== null).map((p) => secs(p.reachedAt - t0));
  const done = db.people.map((p) => secs(p.doneAt - t0));
  const perChannel = {};
  cfg.channels.forEach((c) => {
    const r = db.rows.filter((x) => x.channel === c);
    perChannel[c] = { rows: r.length, sent: r.filter((x) => x.status === 'sent' || x.status === 'delivered').length, failed: r.filter((x) => x.status === 'failed').length,
      held: r.filter((x) => x.status === 'held').length, finishedAfterSec: r.some((x) => x.finalAt) ? secs(Math.max(...r.map((x) => x.finalAt || 0)) - t0) : null };
  });
  const finishTimes = db.rows.filter((r) => r.finalAt).map((r) => secs(r.finalAt - t0)).sort((a, b) => a - b);
  const t95 = percentile(finishTimes, 95);
  const sendsPerSec = t95 ? (0.95 * finishTimes.length) / t95 : 0; // main phase only, so the retry tail does not hide the real rate
  const finals = [...db.finalWrites.values()];
  return {
    cfg, perChannel, sendsPerSec,
    totalSeconds: secs(end - t0), realSeconds: (end - t0) / 1000,
    reached: { count: reached.length, ...dist(reached) },
    done: dist(done),
    unreached: db.people.length - reached.length,
    exactlyOnce: finals.every((n) => n === 1),
    stuck: db.rows.filter((r) => r.status === 'queued' || r.status === 'sending').length,
    retried: db.rows.filter((r) => r.attempt > 1).length,
    fallbackReleased: db.rows.filter((r) => r.releasedAt).length,
  };
}
module.exports = { runScenario, DEFAULTS, percentile };
