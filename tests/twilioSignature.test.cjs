const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { validateTwilioRequest, checkTwilioSignature } = require('../src/server/providers/twilioSignature.cjs');

const token = 'test-token';
const url = 'https://emns.example.invalid/.netlify/functions/sms-status';
const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
const sign = (u, p) => crypto.createHmac('sha1', token).update(Buffer.from(Object.keys(p).sort().reduce((a, k) => a + k + p[k], u))).digest('base64');

test('valid signature passes, tampered params fail', () => {
  const sig = sign(url, params);
  assert.ok(validateTwilioRequest(token, sig, url, params));
  assert.ok(!validateTwilioRequest(token, sig, url, { ...params, MessageStatus: 'failed' }));
});
test('enforcement is ON by default and rejects a bad signature', () => {
  const env = { TWILIO_AUTH_TOKEN: token, TWILIO_WEBHOOK_BASE_URL: 'https://emns.example.invalid' };
  const r = checkTwilioSignature({ headers: { 'x-twilio-signature': 'bogus' } }, params, 'sms-status', env);
  assert.strictEqual(r.enforce, true);
  assert.strictEqual(r.reject, true);
});
test('good signature is accepted; enforcement can be disabled only with explicit false', () => {
  const env = { TWILIO_AUTH_TOKEN: token, TWILIO_WEBHOOK_BASE_URL: 'https://emns.example.invalid' };
  const ok = checkTwilioSignature({ headers: { 'x-twilio-signature': sign(url, params) } }, params, 'sms-status', env);
  assert.strictEqual(ok.reject, false);
  const off = checkTwilioSignature({ headers: {} }, params, 'sms-status', { ...env, TWILIO_ENFORCE_SIGNATURE: 'false' });
  assert.strictEqual(off.reject, false);
});
