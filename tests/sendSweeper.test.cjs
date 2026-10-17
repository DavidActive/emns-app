const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

test('the sweeper runs timed escalation every minute, even when the queue looks empty', async () => {
  process.env.EMNS_WORKER_SECRET = 's';
  const db = createFakeDb({ tables: {}, rpc: { escalate_unacknowledged: () => ({ data: 2, error: null }) } });
  setDbForTests(db);
  const fn = loadFunction('send-sweeper');
  const r = await fn.handler();
  assert.equal(r.statusCode, 200);
  assert.ok(db.calls.some((c) => c.rpc === 'escalate_unacknowledged'));
  delete process.env.EMNS_WORKER_SECRET;
});
