const test = require('node:test');
const assert = require('node:assert');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');

test('mock provider records sends and returns sequential sids', async () => {
  const p = createMockMessageProvider();
  const a = await p.send({ channel: 'sms', to: '+15550000001', body: 'hi' });
  const b = await p.send({ channel: 'sms', to: '+15550000002', body: 'hi' });
  assert.strictEqual(a.sid, 'MOCK00000001');
  assert.strictEqual(b.sid, 'MOCK00000002');
  assert.strictEqual(p.sent.length, 2);
});

test('forced-number failure rejects with the configured code', async () => {
  const p = createMockMessageProvider({ failNumbers: { '+15550000009': 21610 } });
  await assert.rejects(() => p.send({ channel: 'sms', to: '+15550000009', body: 'x' }), (e) => e.code === 21610);
  assert.strictEqual(p.failed.length, 1);
});

test('failRate is deterministic for a given seed and roughly honored', async () => {
  const run = async () => {
    const p = createMockMessageProvider({ failRate: 0.2, seed: 42 });
    let fails = 0;
    for (let i = 0; i < 1000; i++) { try { await p.send({ channel: 'sms', to: '+1555' + i, body: 'x' }); } catch { fails++; } }
    return fails;
  };
  const a = await run(); const b = await run();
  assert.strictEqual(a, b);
  assert.ok(a > 140 && a < 260, `expected ~200 failures, got ${a}`);
});
