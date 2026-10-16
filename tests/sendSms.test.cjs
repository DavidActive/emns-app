const test = require('node:test');
const assert = require('node:assert');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { setMessageProviderForTests } = require('../src/server/providers/index.cjs');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { handler } = loadFunction('send-sms');

const ORG = 'org-1';
const staff = { id: 'staff-1', organization_id: ORG, role: 'support', is_global_admin: false };
const alertRow = (phone = '+15550001111', opted = false) => ({
  id: 'alert-1', organization_id: ORG, status: 'open', enrolled_person_id: 'p1',
  organizations: { twilio_number: '+15559990000' },
  enrolled_people: { id: 'p1', phone_number: phone, sms_opted_out: opted },
});
const req = (body = 'hello') => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer t', host: 'emns.example.invalid' },
  body: JSON.stringify({ alert_id: 'alert-1', body }),
});
function setup({ alert = alertRow(), provider = createMockMessageProvider() } = {}) {
  const db = createFakeDb({ tables: { staff_users: staff, alerts: alert }, user: { id: 'u1' } });
  setDbForTests(db); setMessageProviderForTests(provider);
  return { db, provider };
}

test('happy path sends through the provider from the org number to the resolved recipient', async () => {
  const { db, provider } = setup();
  const res = await handler(req());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(provider.sent.length, 1);
  assert.strictEqual(provider.sent[0].to, '+15550001111');
  assert.strictEqual(provider.sent[0].from, '+15559990000');
  const ins = db.calls.find((c) => c.table === 'alert_messages' && c.op === 'insert');
  assert.strictEqual(ins.payload.delivery_status, 'queued');
  assert.strictEqual(ins.payload.twilio_sid, 'MOCK00000001');
});

test('opted-out recipient is blocked before any send', async () => {
  const { provider } = setup({ alert: alertRow('+15550001111', true) });
  const res = await handler(req());
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(provider.sent.length, 0);
});

test('provider failure 21610 marks the person opted out and returns 409', async () => {
  const provider = createMockMessageProvider({ failNumbers: { '+15550001111': 21610 } });
  const { db } = setup({ provider });
  const res = await handler(req());
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(JSON.parse(res.body).code, 'opted_out');
  assert.ok(db.calls.some((c) => c.table === 'enrolled_people' && c.op === 'update' && c.payload.sms_opted_out === true));
  const ins = db.calls.find((c) => c.table === 'alert_messages' && c.op === 'insert');
  assert.strictEqual(ins.payload.delivery_status, 'failed');
});

test('provider failure 21211 returns a friendly 502 and records the failure', async () => {
  const provider = createMockMessageProvider({ failNumbers: { '+15550001111': 21211 } });
  const { db } = setup({ provider });
  const res = await handler(req());
  assert.strictEqual(res.statusCode, 502);
  const ins = db.calls.find((c) => c.table === 'alert_messages' && c.op === 'insert');
  assert.strictEqual(ins.payload.error_code, '21211');
});

test('caller from another org cannot send', async () => {
  const db = createFakeDb({ tables: { staff_users: { ...staff, organization_id: 'other-org' }, alerts: alertRow() }, user: { id: 'u1' } });
  const provider = createMockMessageProvider();
  setDbForTests(db); setMessageProviderForTests(provider);
  const res = await handler(req());
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(provider.sent.length, 0);
});
