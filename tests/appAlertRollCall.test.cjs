const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

const APP_SOS = 'You are receiving this alert from Sam Rivera (+15550004242) via Active SOS App\nSOS Alert\nACTIVE SHOOTER\nClick here for my location: https://www.google.com/maps?q=35.4576%2C-97.5953';
const APP_SAFE = 'You are receiving this alert from Sam Rivera (+15550004242) via Active SOS App\nSafe Alert\nI am okay\nClick here for my location: https://www.google.com/maps?q=35.4576%2C-97.5953';
const APP_SAFE_ESCALATED = 'You are receiving this alert from Sam Rivera (+15550004242) via Active SOS App\nSafe Alert\nthinking about suicide\nClick here for my location: https://www.google.com/maps?q=35.4576%2C-97.5953';

function inbound(body, sid = 'SMapp1') {
  return { httpMethod: 'POST', headers: { host: 'x.netlify.app' }, body: new URLSearchParams({ From: '+15559990000', To: '+16085575999', Body: body, MessageSid: sid }).toString() };
}
function setup(result = { matched: true, event_id: 'e1', duplicate: false }) {
  process.env.TWILIO_ENFORCE_SIGNATURE = 'false';
  const db = createFakeDb({
    tables: { organizations: { id: 'org1' }, people: { id: 'p1', full_name: 'Sam Rivera' } },
    rpc: { record_app_alert_ack: () => ({ data: result, error: null }), record_acknowledgement: () => ({ data: { matched: false }, error: null }) },
  });
  setDbForTests(db);
  return db;
}
const appAck = (db) => db.calls.find((c) => c.rpc === 'record_app_alert_ack');
const plainAck = (db) => db.calls.find((c) => c.rpc === 'record_acknowledgement');
const inboxInsert = (db) => db.calls.find((c) => c.table === 'inbox_items' && c.op === 'insert');

test('an Active SOS app SOS alert is recorded for the roll-call with its coordinates, and still opens a critical item', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  assert.equal((await fn.handler(inbound(APP_SOS))).statusCode, 200);
  const a = appAck(db).args;
  assert.equal(a.p_response, 'SOS');
  assert.equal(a.p_person, 'p1');
  assert.equal(a.p_lat, 35.4576);
  assert.equal(a.p_lng, -97.5953);
  assert.match(a.p_gps_url, /google\.com\/maps/);
  assert.equal(a.p_message_sid, 'SMapp1');
  assert.equal(inboxInsert(db).payload.tier, 3);
  assert.equal(plainAck(db), undefined, 'app alerts do not go through the plain-reply matcher');
});

test('an Active SOS app SAFE alert is recorded as SAFE with its location, and keeps its normal inbox item', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound(APP_SAFE));
  assert.equal(appAck(db).args.p_response, 'SAFE');
  assert.equal(appAck(db).args.p_lat, 35.4576);
  assert.equal(inboxInsert(db).payload.tier, 1);
});

test('a Safe alert whose reason is a crisis keyword counts as SOS (escalation is never downgraded)', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound(APP_SAFE_ESCALATED));
  assert.equal(appAck(db).args.p_response, 'SOS');
});

test('no open event for the person: the alert behaves exactly as before', async () => {
  const db = setup({ matched: false });
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound(APP_SOS));
  assert.ok(inboxInsert(db), 'inbox item still created');
});

test('a failure recording the roll-call entry does not lose the alert', async () => {
  process.env.TWILIO_ENFORCE_SIGNATURE = 'false';
  const db = createFakeDb({
    tables: { organizations: { id: 'org1' }, people: { id: 'p1', full_name: 'Sam Rivera' } },
    rpc: { record_app_alert_ack: () => ({ data: null, error: { message: 'boom' } }) },
  });
  setDbForTests(db);
  const fn = loadFunction('sms-webhook');
  assert.equal((await fn.handler(inbound(APP_SOS))).statusCode, 200);
  assert.ok(inboxInsert(db), 'the SOS item is still created');
});

test('plain texts and unstructured messages never call the app-alert recorder', async () => {
  const db = setup();
  const fn = loadFunction('sms-webhook');
  await fn.handler(inbound('SAFE'));
  assert.equal(appAck(db), undefined);
});

test('map pins: red for SOS, green for safe, unlocated answers listed, bad coordinates ignored', async () => {
  const { rollCallPins, PIN_COLORS } = await import('../src/lib/rollCallPins.mjs');
  const r = rollCallPins([
    { person_id: 'a', full_name: 'A', status: 'safe', lat: 35.1, lng: -97.1, gps_url: 'https://www.google.com/maps?q=35.1%2C-97.1', responded_at: '2026-10-17T12:00:00Z' },
    { person_id: 'b', full_name: 'B', status: 'sos', lat: 35.2, lng: -97.2, gps_url: 'javascript:alert(1)' },
    { person_id: 'c', full_name: 'C', status: 'sos', lat: null, lng: null },
    { person_id: 'd', full_name: 'D', status: 'unaccounted', lat: null, lng: null },
    { person_id: 'e', full_name: 'E', status: 'safe', lat: 999, lng: 5 },
  ]);
  assert.deepEqual(r.pins.map((p) => p.id), ['a', 'b'], 'red SOS pin draws last, on top');
  assert.equal(r.pins.find((p) => p.id === 'a').color, PIN_COLORS.safe);
  assert.equal(r.pins.find((p) => p.id === 'b').color, PIN_COLORS.sos);
  assert.equal(r.pins.find((p) => p.id === 'b').gpsUrl, null, 'unsafe link dropped');
  assert.deepEqual(r.withoutLocation.map((p) => p.id).sort(), ['c', 'e']);
  assert.deepEqual(r.counts, { sos: 1, safe: 1, located: 2 });
  assert.equal(PIN_COLORS.sos, '#D64545');
  assert.equal(PIN_COLORS.safe, '#2E9E6B');
});
