const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

function signed(params) {
  const url = 'https://x.netlify.app/.netlify/functions/sms-status';
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  const sig = crypto.createHmac('sha1', 'tok').update(data).digest('base64');
  return { httpMethod: 'POST', headers: { 'x-twilio-signature': sig, host: 'x.netlify.app' }, body: new URLSearchParams(params).toString() };
}

test('status callback forwards broadcast delivery status to the database function', async () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  const db = createFakeDb({ rpc: { apply_delivery_status: () => ({ data: true, error: null }) } });
  setDbForTests(db);
  const fn = loadFunction('sms-status');
  const r = await fn.handler(signed({ MessageSid: 'SM1', MessageStatus: 'delivered' }));
  assert.equal(r.statusCode, 200);
  const c = db.calls.find((x) => x.rpc === 'apply_delivery_status');
  assert.deepEqual(c.args, { p_sid: 'SM1', p_status: 'delivered', p_error_code: null });
});

test('status callback rejects bad signatures', async () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  setDbForTests(createFakeDb({}));
  const fn = loadFunction('sms-status');
  const r = await fn.handler({ httpMethod: 'POST', headers: { 'x-twilio-signature': 'nope', host: 'x.netlify.app' }, body: 'MessageSid=SM1&MessageStatus=delivered' });
  assert.equal(r.statusCode, 403);
});
