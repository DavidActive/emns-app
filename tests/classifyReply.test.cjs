const test = require('node:test');
const assert = require('node:assert');
const { classifyReply } = require('../src/server/replies/classifyReply.cjs');

test('plain safe confirmations are SAFE', () => {
  for (const t of ['SAFE', 'safe', 'Safe.', "I'm safe", 'im safe', 'I am safe', 'OK', 'okay', "I'm OK!", 'all good', 'safe and well', 'ok thanks', 'We are safe', 'SAFE ✅']) {
    assert.equal(classifyReply(t).response, 'SAFE', t);
  }
});

test('SAFE must be the whole message: qualified or mixed messages are never counted as safe', () => {
  assert.notEqual(classifyReply('safe but injured').response, 'SAFE');
  assert.notEqual(classifyReply('safe, but my friend is not').response, 'SAFE');
  assert.equal(classifyReply('I am not safe').response, 'SOS');
});

test('SOS wording is recognised anywhere in the message', () => {
  for (const t of ['SOS', 'sos!!', 'Need help now', 'please send help to building 4', 'There is an emergency', 'I am trapped', 'unsafe here', 'in danger']) {
    assert.equal(classifyReply(t).response, 'SOS', t);
  }
});

test('everything else is TEXT for a human to read; HELP is left to the carrier', () => {
  for (const t of ['Test 6', 'yes', 'got it', 'HELP', 'on my way', '', '   ', null, undefined]) {
    assert.equal(classifyReply(t).response, 'TEXT', String(t));
  }
});
