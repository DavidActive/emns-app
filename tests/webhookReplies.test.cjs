const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

function inbound(body, sid = 'SMtest1') {
  return { httpMethod: 'POST', headers: { host: 'x.netlify.app' }, body: new URLSearchParams({ From: '+15550004242', To: '+16085575999', Body: body, MessageSid: sid }).toString() };
}
function setup(ackResult) {
  process.env.TWILIO_ENFORCE_SIGNATURE = 'false';
  const db = createFakeDb({
    tables: { organizations: { id: 'org1' }, people: { id: 'p1', full_name: 'Sam' }, inbox_items: { id: 'i1', tier: 1, item_type: 'SAFE', status: 'open', created_at: new Date().toISOString() } },
    rpc: { record_acknowledgement: () => ({ data: ackResult, error: null }) },
  });
  setDbForTests(db);
  return db;
}
const ackCall = (db) => db.calls.find((c) => c.rpc === 'record_acknowledgement');
const inboxInsert = (db) => db.calls.find((c) => c.table === 'inbox_items' && c.op === 'insert');
const MATCH = { matched: true, event_id: 'e1', duplicate: false };

test('SAFE reply to an open event is recorded and creates NO triage item', async () => {
  const db = setup(MATCH);
  const fn = loadFunction('sms-webhook');
  assert.equal((await fn.handler(inbound('SAFE'))).statusCode, 200);
  assert.deepEqual({ ...ackCall(db).args }, { p_org: 'org1', p_person: 'p1', p_response: 'SAFE', p_text: 'SAFE', p_message_sid: 'SMtest1' });
  assert.equal(inboxInsert(db), undefined);
});

test('SOS reply is recorded and becomes a critical (tier 3) SOS item', async () => {
  const db = setup(MATCH);
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('SOS I am trapped'));
  assert.equal(ackCall(db).args.p_response, 'SOS');
  const items = db.calls.filter((c) => c.table === 'inbox_items' && (c.op === 'insert' || c.op === 'update'));
  assert.ok(items.length > 0, 'a triage item is created or raised');
  const p = items[0].payload;
  assert.equal(p.tier, 3);
  assert.ok(!p.item_type || p.item_type === 'SOS');
});

test('free text is recorded as TEXT and still goes to triage', async () => {
  const db = setup(MATCH);
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('On my way to the east lot'));
  assert.equal(ackCall(db).args.p_response, 'TEXT');
  assert.ok(db.calls.some((c) => c.table === 'inbox_items' && (c.op === 'insert' || c.op === 'update') || c.table === 'inbox_messages' && c.op === 'insert'));
});

test('with no matching event, behavior is unchanged: SAFE still goes through the normal triage path', async () => {
  const db = setup({ matched: false });
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('SAFE'));
  assert.ok(db.calls.some((c) => (c.table === 'inbox_items' || c.table === 'inbox_messages') && c.op === 'insert'));
});

test('a Twilio retry (duplicate message) does nothing more', async () => {
  const db = setup({ matched: true, event_id: 'e1', duplicate: true });
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('SOS help me'));
  assert.equal(inboxInsert(db), undefined);
});

test('STOP and START are not acknowledgements', async () => {
  for (const w of ['STOP', 'START']) {
    const db = setup(MATCH);
    const fn = loadFunction('sms-webhook');
    await fn.handler(inbound(w));
    assert.equal(ackCall(db), undefined, w);
  }
});

test('a failure recording the acknowledgement does not lose the message', async () => {
  process.env.TWILIO_ENFORCE_SIGNATURE = 'false';
  const db = createFakeDb({ tables: { organizations: { id: 'org1' }, people: { id: 'p1', full_name: 'Sam' } }, rpc: { record_acknowledgement: () => ({ data: null, error: { message: 'boom' } }) } });
  setDbForTests(db);
  const fn = loadFunction('sms-webhook');
  assert.equal((await fn.handler(inbound('SAFE'))).statusCode, 200);
  assert.ok(db.calls.some((c) => c.table === 'inbox_items' && c.op === 'insert'));
});
