const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

const ORG = { id: 'org1', name: 'Example Org', twilio_number: '+16085550100', settings: { qr_sites: { 'RALLY-1': { name: 'Hospital Rally Point' } } } };
function setup({ person = { id: 'p1', full_name: 'Sam Rivera' }, ack = { matched: true, event_id: 'e1', duplicate: false } } = {}) {
  const db = createFakeDb({
    tables: { organizations: ORG, people: person, priority_rules: [] },
    rpc: { record_app_alert_ack: () => ({ data: ack, error: null }), record_acknowledgement: () => ({ data: ack, error: null }) },
  });
  setDbForTests(db);
  return db;
}
const post = (b) => ({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ code: 'RALLY-1', name: 'Sam Rivera', phone: '405-555-0123', ...b }) });
const rpc = (db, n) => db.calls.find((c) => c.rpc === n);
const inbox = (db) => db.calls.find((c) => c.table === 'inbox_items' && c.op === 'insert');

test('GET returns the site name and the organization text number', async () => {
  setup();
  const r = await loadFunction('qr-checkin').handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { code: 'RALLY-1' } });
  const d = JSON.parse(r.body);
  assert.equal(d.ok, true); assert.equal(d.name, 'Hospital Rally Point'); assert.equal(d.org.sms_number, '+16085550100');
});

test('an unusable code is refused without touching the database', async () => {
  const db = setup();
  const r = await loadFunction('qr-checkin').handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { code: 'bad code!' } });
  assert.equal(JSON.parse(r.body).ok, false);
  assert.equal(db.calls.filter((c) => c.table === 'organizations').length, 0);
});

test('CHECKIN and RALLY are recorded as SAFE with their label and the phone location, and open no inbox item', async () => {
  for (const [action, label] of [['CHECKIN', 'Check-in'], ['RALLY', 'At Rally Point']]) {
    const db = setup();
    const r = await loadFunction('qr-checkin').handler(post({ action, device: { lat: 34.2265, lng: -116.0508, accuracy: 9 } }));
    assert.equal(r.statusCode, 200);
    const a = rpc(db, 'record_app_alert_ack').args;
    assert.equal(a.p_response, 'SAFE'); assert.equal(a.p_text, label); assert.equal(a.p_person, 'p1');
    assert.equal(a.p_lat, 34.2265); assert.equal(a.p_lng, -116.0508);
    assert.equal(inbox(db), undefined);
  }
});

test('HELP and MEDICAL are recorded as SOS and open a critical inbox item', async () => {
  for (const [action, label] of [['HELP', 'NEED HELP'], ['MEDICAL', 'NEED MEDICAL HELP']]) {
    const db = setup();
    await loadFunction('qr-checkin').handler(post({ action, device: { lat: 34.2275, lng: -116.0493 } }));
    assert.equal(rpc(db, 'record_app_alert_ack').args.p_response, 'SOS');
    assert.equal(rpc(db, 'record_app_alert_ack').args.p_text, label);
    assert.equal(inbox(db).payload.tier, 3); assert.equal(inbox(db).payload.item_type, 'SOS'); assert.equal(inbox(db).payload.person_id, 'p1');
  }
});

test('no location allowed: the check-in still counts, with no coordinates', async () => {
  const db = setup();
  await loadFunction('qr-checkin').handler(post({ action: 'CHECKIN', device: null }));
  assert.equal(rpc(db, 'record_app_alert_ack').args.p_lat, null);
});

test('impossible coordinates are dropped, the check-in still counts', async () => {
  const db = setup();
  await loadFunction('qr-checkin').handler(post({ action: 'CHECKIN', device: { lat: 999, lng: 5 } }));
  assert.equal(rpc(db, 'record_app_alert_ack').args.p_lat, null);
});

test('free text that reads as an emergency is SOS; routine free text is a reply and goes to the inbox for a look', async () => {
  let db = setup();
  await loadFunction('qr-checkin').handler(post({ action: 'MESSAGE', message: 'I am trapped on the second floor' }));
  assert.equal(rpc(db, 'record_app_alert_ack').args.p_response, 'SOS'); assert.equal(inbox(db).payload.tier, 3);

  db = setup();
  await loadFunction('qr-checkin').handler(post({ action: 'MESSAGE', message: 'Running late, helping a patient' }));
  assert.equal(rpc(db, 'record_acknowledgement').args.p_response, 'TEXT'); assert.equal(inbox(db).payload.tier, 2);
});

test('empty free text and a bad phone number are rejected', async () => {
  setup();
  const fn = loadFunction('qr-checkin');
  assert.equal(JSON.parse((await fn.handler(post({ action: 'MESSAGE', message: '  ' }))).body).error, 'empty_message');
  assert.equal(JSON.parse((await fn.handler(post({ action: 'CHECKIN', phone: '123' }))).body).error, 'invalid_phone');
  assert.equal((await fn.handler(post({ action: 'NOPE' }))).statusCode, 400);
});

test('a person who is not on the roster is never created; a call for help still reaches the inbox', async () => {
  const db = setup({ person: null });
  const r = await loadFunction('qr-checkin').handler(post({ action: 'MEDICAL' }));
  assert.equal(JSON.parse(r.body).enrolled, false);
  assert.equal(rpc(db, 'record_app_alert_ack'), undefined);
  assert.equal(db.calls.find((c) => c.table === 'people' && c.op === 'insert'), undefined);
  assert.equal(inbox(db).payload.person_id, null); assert.equal(inbox(db).payload.tier, 3);
  assert.match(inbox(db).payload.message_body, /Unregistered QR check-in/);

  const db2 = setup({ person: null });
  await loadFunction('qr-checkin').handler(post({ action: 'CHECKIN' }));
  assert.equal(inbox(db2), undefined, 'an unregistered SAFE check-in opens nothing');
});

test('a double tap is reported as a duplicate and does not open a second inbox item', async () => {
  const db = setup({ ack: { matched: true, duplicate: true } });
  const r = await loadFunction('qr-checkin').handler(post({ action: 'HELP' }));
  assert.equal(JSON.parse(r.body).duplicate, true);
  assert.equal(inbox(db), undefined);
});

test('the recorded flag is false when there is no open roll-call (the page can say so)', async () => {
  setup({ ack: { matched: false } });
  const r = await loadFunction('qr-checkin').handler(post({ action: 'CHECKIN' }));
  assert.equal(JSON.parse(r.body).recorded, false);
});
