const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

function inbound(body) {
  return { httpMethod: 'POST', headers: { host: 'x.netlify.app' }, body: new URLSearchParams({ From: '+15550004242', To: '+16085575999', Body: body }).toString() };
}
function setup() {
  process.env.TWILIO_ENFORCE_SIGNATURE = 'false';
  const db = createFakeDb({ tables: { organizations: { id: 'org1' }, people: { id: 'p1', full_name: 'Sam' } } });
  setDbForTests(db);
  return db;
}
const personUpdate = (db) => db.calls.find((c) => c.table === 'people' && c.op === 'update');
const consentEvent = (db) => db.calls.find((c) => c.table === 'consent_events' && c.op === 'insert');

test('STOP withdraws consent and opts the person out; the event is recorded', async () => {
  const fn = loadFunction('sms-webhook');
  for (const word of ['STOP', 'stop', 'Stop.', 'unsubscribe', 'CANCEL', 'STOP ALL']) {
    const db = setup();
    assert.equal((await fn.handler(inbound(word))).statusCode, 200);
    assert.equal(personUpdate(db).payload.sms_opted_out, true, word);
    assert.equal(personUpdate(db).payload.consent_status, 'withdrawn', word);
    assert.equal(consentEvent(db).payload.event, 'opt_out', word);
  }
});

test('START is a consent method: it records consent and clears the opt-out', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('START'));
  const u = personUpdate(db).payload;
  assert.equal(u.consent_status, 'consented');
  assert.equal(u.consent_method, 'sms_keyword_start');
  assert.equal(u.sms_opted_out, false);
  assert.ok(u.consented_at);
  const e = consentEvent(db).payload;
  assert.equal(e.event, 'opt_in');
  assert.equal(e.method, 'sms_keyword_start');
  assert.ok(e.consent_text);
});

test('an ordinary message that merely contains "stop" is not an opt-out', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('Please stop the bus at Main'));
  assert.equal(db.calls.some((c) => c.table === 'consent_events'), false);
  const u = personUpdate(db);
  assert.ok(!(u && u.payload.consent_status === 'withdrawn'));
});
