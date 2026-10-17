const test = require('node:test');
const assert = require('node:assert');
const { runScenario } = require('../scripts/loadTestCore.cjs');

test('load simulation: every delivery ends once, nobody is left queued, fallback only releases on failure', async () => {
  const together = await runScenario({ people: 300, speed: 100, seed: 7 });
  assert.equal(together.exactlyOnce, true);
  assert.equal(together.stuck, 0);
  assert.equal(together.perChannel.sms.rows, 300);
  assert.ok(together.reached.p50 <= together.reached.p95 && together.reached.p95 <= together.reached.p99);
  const fb = await runScenario({ people: 300, speed: 100, seed: 7, mode: 'fallback' });
  assert.equal(fb.exactlyOnce, true);
  assert.equal(fb.stuck, 0);
  assert.equal(fb.fallbackReleased, fb.perChannel.sms.failed, 'email released exactly where text failed');
});
