const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const operator = (role, extra = {}) => ({ id: 'op1', organization_id: 'org1', role, is_platform_admin: false, ...extra });
const req = (body, token = 'good') => ({ httpMethod: 'POST', headers: { authorization: `Bearer ${token}`, host: 'x.netlify.app' }, body: JSON.stringify(body) });

function setup(op, rpcResult = { data: { event_id: 'e1', deduplicated: false, queued: 3, skipped: 1 }, error: null }) {
  const db = createFakeDb({ tables: { operators: op }, user: { id: 'u1' }, rpc: { create_notification_event: () => rpcResult } });
  setDbForTests(db);
  return db;
}

test('rejects missing or bad tokens', async () => {
  const fn = loadFunction('send-event');
  setDbForTests(createFakeDb({ tables: { operators: operator('admin') }, user: null }));
  assert.equal((await fn.handler(req({}, ''))).statusCode, 401);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }, 'bad'))).statusCode, 401);
});

test('only admin and sender roles may send; operators and viewers are refused', async () => {
  const fn = loadFunction('send-event');
  for (const role of ['operator', 'viewer']) {
    setup(operator(role));
    const r = await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }));
    assert.equal(r.statusCode, 403, role);
  }
  setup(operator('sender'));
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }))).statusCode, 200);
});

test('validates input', async () => {
  const fn = loadFunction('send-event');
  setup(operator('admin'));
  assert.equal((await fn.handler(req({ kind: 'bogus', body: 'x', group_ids: [G1] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: '  ', group_ids: [G1] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: ['not-a-uuid'] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'y'.repeat(1601), group_ids: [G1] }))).statusCode, 400);
});

test('creates the event for the caller\'s own organization; recipients never come from the request', async () => {
  const fn = loadFunction('send-event');
  const db = setup(operator('admin'));
  const r = await fn.handler(req({ kind: 'alert', body: 'Shelter in place', group_ids: [G1, G2, G1], organization_id: 'evil-org', recipients: ['+15551112222'], idempotency_key: 'k1' }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).queued, 3);
  const call = db.calls.find((c) => c.rpc === 'create_notification_event');
  assert.equal(call.args.p_org, 'org1');
  assert.equal(call.args.p_created_by, 'op1');
  assert.deepEqual(call.args.p_group_ids, [G1, G2]);
  assert.equal(call.args.p_idempotency_key, 'k1');
  assert.equal(call.args.p_body, 'Shelter in place');
  assert.equal(JSON.stringify(call.args).includes('evil-org'), false);
  assert.equal(JSON.stringify(call.args).includes('5551112222'), false);
});

test('drills and tests are always labelled', async () => {
  const fn = loadFunction('send-event');
  const db = setup(operator('admin'));
  await fn.handler(req({ kind: 'drill', body: 'Fire drill at 10', group_ids: [G1] }));
  await fn.handler(req({ kind: 'test', body: '[TEST] already labelled', group_ids: [G1] }));
  const bodies = db.calls.filter((c) => c.rpc).map((c) => c.args.p_body);
  assert.equal(bodies[0], '[DRILL] Fire drill at 10');
  assert.equal(bodies[1], '[TEST] already labelled');
});

test('database errors about groups come back as 400', async () => {
  const fn = loadFunction('send-event');
  setup(operator('admin'), { data: null, error: { message: 'one or more groups do not belong to this organization' } });
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }))).statusCode, 400);
});

test('worker secret check is constant-time and required', () => {
  const { secretOk } = loadFunction('send-worker-background');
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': 'abc' } }, { EMNS_WORKER_SECRET: 'abc' }), true);
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': 'abd' } }, { EMNS_WORKER_SECRET: 'abc' }), false);
  assert.equal(secretOk({ headers: {} }, { EMNS_WORKER_SECRET: 'abc' }), false);
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': '' } }, {}), false);
});
