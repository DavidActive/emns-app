const test = require('node:test');
const assert = require('node:assert');
const { getMessageProvider } = require('../src/server/providers/index.cjs');

test('default provider is mock', () => {
  assert.strictEqual(getMessageProvider({}).name, 'mock');
});
test('twilio provider is refused unless real sends are explicitly allowed', () => {
  assert.throws(() => getMessageProvider({ EMNS_MESSAGE_PROVIDER: 'twilio' }), (e) => e.code === 'real_send_disabled');
});
test('twilio provider is returned when explicitly allowed', () => {
  assert.strictEqual(getMessageProvider({ EMNS_MESSAGE_PROVIDER: 'twilio', EMNS_ALLOW_REAL_SEND: 'true' }).name, 'twilio');
});
test('unknown provider name is rejected', () => {
  assert.throws(() => getMessageProvider({ EMNS_MESSAGE_PROVIDER: 'carrier-pigeon' }), (e) => e.code === 'bad_config');
});
