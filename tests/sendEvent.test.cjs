const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const S1 = '33333333-3333-3333-3333-333333333333';
const operator = (role, extra = {}) => ({ id: 'op1', organization_id: 'org1', role, is_platform_admin: false, ...extra });
const req = (body, token = 'good') => ({ httpMethod: 'POST', headers: { authorization: `Bearer ${token}`, host: 'x.netlify.app' }, body: JSON.stringify(body) });
const RPC_OK = { data: { event_id: 'e1', deduplicated: false, queued: 3, skipped: 1, skipped_no_consent: 1, skipped_opted_out: 0 }, error: null };

function setup(op, { rpcResult = RPC_OK, org = { name: 'Acme Hospital', settings: {} }, scenario = null } = {}) {
  const db = createFakeDb({
    tables: { operators: op, organizations: org, notification_scenarios: scenario },
    user: { id: 'u1' }, rpc: { create_notification_event: () => rpcResult },
  });
  setDbForTests(db);
  return db;
}
const rpcArgs = (db) => db.calls.find((c) => c.rpc === 'create_notification_event').args;

test('rejects missing or bad tokens', async () => {
  const fn = loadFunction('send-event');
  setDbForTests(createFakeDb({ tables: { operators: operator('admin') }, user: null }));
  assert.equal((await fn.handler(req({}, ''))).statusCode, 401);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }, 'bad'))).statusCode, 401);
});

test('roles: viewers cannot send; operators can drill and test but NOT send a real alert; senders and admins can', async () => {
  const fn = loadFunction('send-event');
  setup(operator('viewer'));
  for (const kind of ['alert', 'drill', 'test']) assert.equal((await fn.handler(req({ kind, body: 'x', group_ids: [G1] }))).statusCode, 403, `viewer ${kind}`);

  const opDb = setup(operator('operator'));
  const refused = await fn.handler(req({ kind: 'alert', body: 'Real emergency', group_ids: [G1] }));
  assert.equal(refused.statusCode, 403);
  assert.match(JSON.parse(refused.body).error, /real alerts/i);
  assert.equal(opDb.calls.some((c) => c.rpc === 'create_notification_event'), false, 'nothing queued for the refused alert');
  assert.equal((await fn.handler(req({ kind: 'drill', body: 'Fire drill', group_ids: [G1] }))).statusCode, 200);
  assert.equal((await fn.handler(req({ kind: 'test', body: '', group_ids: [G1] }))).statusCode, 200);

  for (const role of ['sender', 'admin']) {
    setup(operator(role));
    assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }))).statusCode, 200, role);
  }
});

test('validates input', async () => {
  const fn = loadFunction('send-event');
  setup(operator('admin'));
  assert.equal((await fn.handler(req({ kind: 'bogus', body: 'x', group_ids: [G1] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: '  ', group_ids: [G1] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: ['not-a-uuid'] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'y'.repeat(1601), group_ids: [G1] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1], scenario_id: 'nope' }))).statusCode, 400);
});

test('creates the event for the caller\'s own organization; recipients never come from the request', async () => {
  const fn = loadFunction('send-event');
  const db = setup(operator('admin'));
  const r = await fn.handler(req({ kind: 'alert', body: 'Shelter in place', group_ids: [G1, G2, G1], organization_id: 'evil-org', recipients: ['+15551112222'], idempotency_key: 'k1' }));
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.queued, 3);
  assert.equal(out.skipped_no_consent, 1);
  const a = rpcArgs(db);
  assert.equal(a.p_org, 'org1');
  assert.equal(a.p_created_by, 'op1');
  assert.deepEqual(a.p_group_ids, [G1, G2]);
  assert.equal(a.p_idempotency_key, 'k1');
  assert.equal(a.p_body, 'Active SOS eMNS: ALERT from Acme Hospital: Shelter in place. Reply SAFE when secure. Reply STOP to opt out.');
  assert.equal(JSON.stringify(a).includes('evil-org'), false);
  assert.equal(JSON.stringify(a).includes('5551112222'), false);
});

test('drills and tests always carry the tag, and the tag is configurable per organization', async () => {
  const fn = loadFunction('send-event');
  let db = setup(operator('operator'));
  await fn.handler(req({ kind: 'drill', body: 'Fire drill at 10', group_ids: [G1] }));
  assert.ok(rpcArgs(db).p_body.startsWith('Active SOS eMNS: [DRILL] This is a drill from Acme Hospital.'));
  assert.ok(rpcArgs(db).p_body.includes('Fire drill at 10.'));

  db = setup(operator('operator'), { org: { name: 'Acme', settings: { drill_tag: 'exercise', test_tag: 'check' } } });
  await fn.handler(req({ kind: 'drill', body: '', group_ids: [G1] }));
  await fn.handler(req({ kind: 'test', body: '', group_ids: [G1] }));
  const bodies = db.calls.filter((c) => c.rpc === 'create_notification_event').map((c) => c.args.p_body);
  assert.ok(bodies[0].includes('[EXERCISE]'));
  assert.ok(bodies[1].includes('[CHECK]'));

  db = setup(operator('operator'));
  await fn.handler(req({ kind: 'drill', body: 'ALERT: real emergency, evacuate', group_ids: [G1] }));
  assert.ok(rpcArgs(db).p_body.includes('[DRILL] This is a drill from Acme Hospital.'));
});

test('a scenario supplies the message and groups; the request can override them', async () => {
  const fn = loadFunction('send-event');
  const scenario = { id: S1, kind: 'alert', bodies: { sms: 'Hazard reported. Follow instructions.' }, default_group_ids: [G2], requires_ack: false };
  let db = setup(operator('sender'), { scenario });
  assert.equal((await fn.handler(req({ kind: 'alert', scenario_id: S1 }))).statusCode, 200);
  let a = rpcArgs(db);
  assert.deepEqual(a.p_group_ids, [G2]);
  assert.equal(a.p_scenario, S1);
  assert.equal(a.p_requires_ack, false);
  assert.equal(a.p_body, 'Active SOS eMNS: ALERT from Acme Hospital: Hazard reported. Follow instructions. Reply STOP to opt out.');

  db = setup(operator('sender'), { scenario });
  await fn.handler(req({ kind: 'alert', scenario_id: S1, body: 'Custom text', group_ids: [G1], requires_ack: true }));
  a = rpcArgs(db);
  assert.deepEqual(a.p_group_ids, [G1]);
  assert.ok(a.p_body.includes('Custom text.') && a.p_body.includes('Reply SAFE when secure.'));

  setup(operator('operator'), { scenario });
  assert.equal((await fn.handler(req({ kind: 'alert', scenario_id: S1 }))).statusCode, 403);
});

test('a scenario from another organization is not found', async () => {
  const fn = loadFunction('send-event');
  setup(operator('sender'), { scenario: null });
  const r = await fn.handler(req({ kind: 'drill', scenario_id: S1, group_ids: [G1] }));
  assert.equal(r.statusCode, 400);
  assert.match(JSON.parse(r.body).error, /scenario/i);
});

test('database errors about groups come back as 400', async () => {
  const fn = loadFunction('send-event');
  setup(operator('admin'), { rpcResult: { data: null, error: { message: 'one or more groups do not belong to this organization' } } });
  assert.equal((await fn.handler(req({ kind: 'alert', body: 'x', group_ids: [G1] }))).statusCode, 400);
});

test('worker secret check is constant-time and required', () => {
  const { secretOk } = loadFunction('send-worker-background');
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': 'abc' } }, { EMNS_WORKER_SECRET: 'abc' }), true);
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': 'abd' } }, { EMNS_WORKER_SECRET: 'abc' }), false);
  assert.equal(secretOk({ headers: {} }, { EMNS_WORKER_SECRET: 'abc' }), false);
  assert.equal(secretOk({ headers: { 'x-emns-worker-secret': '' } }, {}), false);
});

test('fallback_after_seconds is stored on the event only in fallback mode and is clamped', async () => {
  const fn = loadFunction('send-event');
  const upd = (db) => db.calls.find((c) => c.table === 'notification_events' && c.op === 'update');
  let db = setup(operator('admin'));
  await fn.handler(req({ kind: 'drill', body: 'x', group_ids: [G1], channels: ['sms', 'email'], mode: 'fallback', fallback_after_seconds: 300 }));
  assert.deepEqual(upd(db).payload, { fallback_after_seconds: 300 });
  assert.deepEqual(upd(db).filters, [['id', 'e1']]);
  db = setup(operator('admin'));
  await fn.handler(req({ kind: 'drill', body: 'x', group_ids: [G1], channels: ['sms', 'email'], mode: 'fallback', fallback_after_seconds: 999999 }));
  assert.equal(upd(db).payload.fallback_after_seconds, 86400);
  db = setup(operator('admin'));
  await fn.handler(req({ kind: 'drill', body: 'x', group_ids: [G1], channels: ['sms', 'email'], mode: 'together', fallback_after_seconds: 300 }));
  assert.equal(upd(db), undefined, 'ignored when channels go together');
  db = setup(operator('admin'));
  await fn.handler(req({ kind: 'drill', body: 'x', group_ids: [G1], channels: ['sms', 'email'], mode: 'fallback' }));
  assert.equal(upd(db), undefined, 'default 0 needs no update');
});
