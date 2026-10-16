const test = require('node:test');
const assert = require('node:assert');
const { runWorker, classify } = require('../src/server/broadcast/worker.cjs');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');
const { createFakeQueueDb } = require('./helpers/fakeQueueDb.cjs');

test('5,000 deliveries complete on the mock provider, each sent exactly once', async () => {
  const db = createFakeQueueDb({ count: 5000, optedOutEvery: 100 });
  const provider = createMockMessageProvider();
  const stats = await runWorker({ db, provider, workerId: 'w1', batchSize: 200, concurrency: 20 });
  assert.equal(stats.sent, 4950);
  assert.equal(db.count('sent'), 4950);
  assert.equal(db.count('skipped'), 50);
  assert.equal(db.count('queued') + db.count('sending'), 0);
  assert.equal(provider.sent.length, 4950);
  assert.equal(new Set(provider.sent.map((s) => s.to)).size, 4950, 'no recipient texted twice');
  assert.ok([...db.finalWrites.values()].every((n) => n === 1));
});

test('killing the worker mid-run and restarting sends the remainder; each delivery is recorded exactly once', async () => {
  const clock = { t: 1000 };
  const db = createFakeQueueDb({ count: 5000, clock });
  const provider = createMockMessageProvider();
  let sends = 0;
  const origSend = provider.send.bind(provider);
  provider.send = async (r) => { sends++; return origSend(r); };
  // worker 1 "dies" once 1,800 sends have started (mid-batch, with calls in flight)
  const w1 = await runWorker({ db, provider, workerId: 'w1', batchSize: 100, concurrency: 10, shouldCrash: () => sends >= 1800 });
  assert.equal(w1.crashed, true);
  const stuck = db.count('sending');
  assert.ok(stuck > 0 && stuck <= 100, `in-flight rows left behind: ${stuck}`);
  // before the lease expires a second worker leaves the stuck rows alone
  const early = await runWorker({ db, provider, workerId: 'w2', batchSize: 100, concurrency: 10 });
  assert.equal(db.count('sending'), stuck);
  assert.equal(early.claimed > 0, true);
  // lease expires; a restarted worker picks them up
  clock.t += 121000;
  const w3 = await runWorker({ db, provider, workerId: 'w3', batchSize: 100, concurrency: 10 });
  assert.ok(w3.claimed >= stuck);
  assert.equal(db.count('sent'), 5000);
  assert.equal(db.count('queued') + db.count('sending'), 0);
  assert.ok([...db.finalWrites.values()].every((n) => n === 1), 'one final record per delivery');
  const duplicates = provider.sent.length - new Set(provider.sent.map((s) => s.to)).size;
  assert.ok(duplicates <= 100, `duplicate texts are bounded by one batch: ${duplicates}`);
});

test('a stale worker cannot overwrite a reclaimed row', async () => {
  const clock = { t: 0 };
  const db = createFakeQueueDb({ count: 1, clock });
  const a = await db.rpc('claim_deliveries', { p_worker: 'A', p_limit: 10, p_lease_seconds: 120 });
  clock.t += 200000;
  await db.rpc('claim_deliveries', { p_worker: 'B', p_limit: 10, p_lease_seconds: 120 });
  const late = await db.rpc('record_delivery_result', { p_delivery: a.data[0].delivery_id, p_worker: 'A', p_outcome: 'sent', p_sid: 'LATE' });
  assert.equal(late.data, false);
});

test('transient failures retry with backoff and give up after three attempts; permanent ones fail at once', async () => {
  const clock = { t: 0 };
  const db = createFakeQueueDb({ count: 2, clock });
  const provider = createMockMessageProvider({ failNumbers: { '+15550000001': 30008, '+15550000002': 21211 } });
  await runWorker({ db, provider, workerId: 'w', clock });
  assert.equal(db.rows[0].status, 'queued');
  assert.equal(db.rows[1].status, 'failed');
  for (let k = 0; k < 2; k++) { clock.t += 10 * 60 * 1000; await runWorker({ db, provider, workerId: 'w' + k }); }
  assert.equal(db.rows[0].status, 'failed');
  assert.equal(db.rows[0].attempt, 3);
});

test('a STOP-type error (21610) marks the person opted out', async () => {
  const db = createFakeQueueDb({ count: 1 });
  const provider = createMockMessageProvider({ failNumbers: { '+15550000001': 21610 } });
  const stats = await runWorker({ db, provider, workerId: 'w' });
  assert.equal(stats.optedOut, 1);
  assert.equal(db.peopleUpdates[0].payload.sms_opted_out, true);
  assert.equal(db.peopleUpdates[0].val, 'p1');
});

test('rate limit spaces sends out (uses an injected clock, no real waiting)', async () => {
  const clock = { t: 0 };
  const slept = [];
  const db = createFakeQueueDb({ count: 20, clock });
  const provider = createMockMessageProvider();
  await runWorker({ db, provider, workerId: 'w', concurrency: 1, ratePerSec: 10, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; } });
  assert.equal(db.count('sent'), 20);
  assert.ok(clock.t >= 1800 && clock.t <= 2100, `20 sends at 10/sec take about 1.9s of simulated time, got ${clock.t}`);
});

test('maxRuntimeMs stops claiming new batches', async () => {
  const clock = { t: 0 };
  const db = createFakeQueueDb({ count: 1000, clock });
  const provider = createMockMessageProvider({ latencyMs: 0 });
  let calls = 0;
  const stats = await runWorker({ db, provider, workerId: 'w', batchSize: 100, maxRuntimeMs: 5, now: () => (calls++ > 3 ? 10 : 0) });
  assert.equal(stats.timedOut, true);
  assert.ok(db.count('queued') > 0);
});

test('classify treats unknown codes as retryable', () => {
  assert.equal(classify({ code: 30008 }).outcome, 'retry');
  assert.equal(classify({ code: 21211 }).outcome, 'failed');
  assert.equal(classify(new Error('boom')).outcome, 'retry');
});
