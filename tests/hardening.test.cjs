const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { rateLimit } = require('../src/server/rateLimit.cjs');
const { checkTwilioSignature } = require('../src/server/providers/twilioSignature.cjs');

const G1 = '11111111-1111-1111-1111-111111111111';
const operator = { id: 'op1', organization_id: 'org1', role: 'admin', is_platform_admin: false };
const req = (body) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer good', host: 'x.netlify.app' }, body: JSON.stringify(body) });
const limited = { check_rate_limit: () => ({ data: { ok: false, retry_after: 17 }, error: null }) };

test('write endpoints answer 429 with Retry-After when the limiter says no, and do no work', async () => {
  for (const [name, body] of [['send-event', { kind: 'drill', body: 'x', group_ids: [G1] }], ['create-invites', { person_ids: [G1] }], ['link-employee', { person_id: G1 }]]) {
    const db = createFakeDb({ tables: { operators: operator }, user: { id: 'u1' }, rpc: limited });
    setDbForTests(db);
    const r = await loadFunction(name).handler(req(body));
    assert.equal(r.statusCode, 429, name);
    assert.equal(r.headers['Retry-After'], '17');
    assert.equal(db.calls.some((c) => c.rpc === 'create_notification_event' || c.rpc === 'create_enrollment_invites' || c.rpc === 'link_person_identity'), false, `${name} did nothing`);
  }
});

test('the public enrollment endpoint is limited per client address', async () => {
  const db = createFakeDb({ tables: {}, rpc: limited });
  setDbForTests(db);
  const r = await loadFunction('enroll').handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.9' }, body: JSON.stringify({ token: 'a'.repeat(43) }) });
  assert.equal(r.statusCode, 429);
  assert.equal(db.calls.find((c) => c.rpc === 'check_rate_limit').args.p_key, 'enroll:203.0.113.9');
  assert.equal(db.calls.some((c) => c.rpc === 'get_enrollment_invite'), false, 'no token lookup while limited');
});

test('the limiter fails open: an outage never blocks an emergency send', async () => {
  const broken = { rpc: async () => ({ data: null, error: { message: 'down' } }) };
  assert.deepEqual(await rateLimit(broken, 'k', 1, 60), { ok: true });
  assert.deepEqual(await rateLimit({ rpc: async () => { throw new Error('boom'); } }, 'k', 1, 60), { ok: true });
  assert.deepEqual(await rateLimit({ rpc: async () => ({ data: { ok: true }, error: null }) }, 'k', 1, 60), { ok: true });
});

test('Twilio signature checking cannot be switched off on the production deploy', () => {
  const evt = { headers: { host: 'x.netlify.app' } };
  const off = { TWILIO_ENFORCE_SIGNATURE: 'false', TWILIO_AUTH_TOKEN: 't' };
  assert.equal(checkTwilioSignature(evt, {}, 'sms-webhook', off).reject, false, 'debug switch works locally');
  assert.equal(checkTwilioSignature(evt, {}, 'sms-webhook', { ...off, CONTEXT: 'production' }).reject, true, 'ignored in production');
  assert.equal(checkTwilioSignature(evt, {}, 'sms-webhook', { TWILIO_AUTH_TOKEN: 't' }).reject, true, 'on by default');
});

test('every Twilio-facing function rejects an unsigned request', async () => {
  process.env.TWILIO_AUTH_TOKEN = 't';
  delete process.env.TWILIO_ENFORCE_SIGNATURE;
  const db = createFakeDb({ tables: {}, rpc: {} });
  setDbForTests(db);
  const unsigned = { httpMethod: 'POST', headers: { host: 'x.netlify.app', 'content-type': 'application/x-www-form-urlencoded' }, body: 'From=%2B15555550100&Body=START', isBase64Encoded: false };
  for (const name of ['sms-webhook', 'sms-status', 'voice-status', 'voice-twiml', 'voice-gather']) {
    const r = await loadFunction(name).handler({ ...unsigned, path: `/.netlify/functions/${name}/00000000-0000-0000-0000-000000000000` });
    assert.equal(r.statusCode, 403, `${name} must refuse unsigned requests`);
  }
  delete process.env.TWILIO_AUTH_TOKEN;
});
