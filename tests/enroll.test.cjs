const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { setMessageProviderForTests } = require('../src/server/providers/index.cjs');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');
const { consentText, voiceConsentText, confirmationMessage, TEXT_VERSION, VOICE_TEXT_VERSION } = require('../src/server/consent/consentText.cjs');

const token = crypto.randomBytes(32).toString('base64url');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const get = (t) => ({ httpMethod: 'GET', headers: { host: 'x.netlify.app' }, queryStringParameters: { token: t } });
const post = (t, extra = {}) => ({ httpMethod: 'POST', headers: { host: 'x.netlify.app' }, body: JSON.stringify({ token: t, ...extra }) });
const VALID = { status: 'valid', org_name: 'Acme Hospital', first_name: 'Sam', phone_last4: '4242', already_consented: false, opted_out: false, voice_consented: false, voice_opted_out: false };
const REC = { ok: true, org_name: 'Acme Hospital', person_id: 'p1', to: '+15550004242', opted_out: false, already_consented: false };

function setup({ info = VALID, rec = REC, provider } = {}) {
  const db = createFakeDb({ rpc: { get_enrollment_invite: () => ({ data: info, error: null }), record_web_consent: () => ({ data: rec, error: null }) } });
  setDbForTests(db);
  const p = provider || createMockMessageProvider();
  setMessageProviderForTests(p);
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  return { db, provider: p };
}

test('consent text names the organization and has every required disclosure', () => {
  const t = consentText('Acme Hospital');
  for (const must of ['from Acme Hospital through the Active SOS eMNS service', 'Calm Water Trading, LLC dba Active SOS', 'Message frequency varies',
    'Message and data rates may apply', 'Consent is not a condition of any purchase', 'Reply STOP to opt out', 'HELP for help', 'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes', 'Privacy Policy and SMS Terms']) {
    assert.ok(t.includes(must), must);
  }
  assert.equal(confirmationMessage('Acme Hospital'),
    'Active SOS eMNS: You are enrolled to receive alerts from Acme Hospital. Message frequency varies. Msg&Data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://www.activesos.com/emns-sms-terms Privacy: https://www.activesos.com/emns-privacy-policy');
});

test('GET: malformed links never reach the database; a valid link shows the organization and consent text, never the phone number', async () => {
  const fn = loadFunction('enroll');
  const { db } = setup();
  assert.deepEqual(JSON.parse((await fn.handler(get('short'))).body), { status: 'invalid' });
  assert.equal(db.calls.filter((c) => c.rpc !== 'check_rate_limit').length, 0);

  const r = JSON.parse((await fn.handler(get(token))).body);
  assert.equal(r.status, 'valid');
  assert.equal(r.org_name, 'Acme Hospital');
  assert.equal(r.consent_text, consentText('Acme Hospital'));
  assert.equal(r.text_version, TEXT_VERSION);
  assert.equal(JSON.stringify(r).includes('5550004242'), false);
  assert.equal(db.calls.find((c) => c.rpc === 'get_enrollment_invite').args.p_token_hash, sha(token), 'only the hash is sent to the database');
  assert.equal(JSON.stringify(db.calls).includes(token), false, 'the plaintext token is never passed on');

  for (const status of ['used', 'expired', 'invalid']) {
    setup({ info: { status } });
    assert.deepEqual(JSON.parse((await fn.handler(get(token))).body), { status });
  }
});

test('POST records consent with the exact text shown, then sends ONE confirmation text', async () => {
  const fn = loadFunction('enroll');
  const { db, provider } = setup();
  const res = await fn.handler(post(token));
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.deepEqual(out, { ok: true, org_name: 'Acme Hospital', opted_out: false, confirmation: 'sent', voice: false });
  const rec = db.calls.find((c) => c.rpc === 'record_web_consent').args;
  assert.equal(rec.p_token_hash, sha(token));
  assert.equal(rec.p_text, consentText('Acme Hospital'));
  assert.equal(rec.p_text_version, TEXT_VERSION);
  assert.equal(rec.p_voice_agreed, false, 'calls are never bundled with texts');
  assert.equal(rec.p_voice_text, null);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].to, '+15550004242');
  assert.equal(provider.sent[0].body, confirmationMessage('Acme Hospital'));
  assert.equal(provider.sent[0].messagingServiceSid, 'MGtest');
  assert.equal(JSON.stringify(out).includes('5550004242'), false);
});

test('POST: no confirmation text for someone already consented or who replied STOP', async () => {
  const fn = loadFunction('enroll');
  let s = setup({ rec: { ...REC, already_consented: true } });
  assert.equal(JSON.parse((await fn.handler(post(token))).body).confirmation, 'not_needed');
  assert.equal(s.provider.sent.length, 0);
  s = setup({ rec: { ...REC, opted_out: true } });
  assert.equal(JSON.parse((await fn.handler(post(token))).body).opted_out, true);
  assert.equal(s.provider.sent.length, 0);
});

test('POST: used, expired or unknown links record nothing', async () => {
  const fn = loadFunction('enroll');
  for (const status of ['used', 'expired', 'invalid']) {
    const { db, provider } = setup({ info: { status } });
    assert.deepEqual(JSON.parse((await fn.handler(post(token))).body), { ok: false, reason: status });
    assert.equal(db.calls.some((c) => c.rpc === 'record_web_consent'), false);
    assert.equal(provider.sent.length, 0);
  }
  setup({ rec: { ok: false, reason: 'used' } }); // lost race: burned between lookup and write
  assert.deepEqual(JSON.parse((await fn.handler(post(token))).body), { ok: false, reason: 'used' });
});

test('POST: if the confirmation text fails, consent is still recorded', async () => {
  const fn = loadFunction('enroll');
  const { db } = setup({ provider: createMockMessageProvider({ failNumbers: { '+15550004242': 30008 } }) });
  const out = JSON.parse((await fn.handler(post(token))).body);
  assert.equal(out.ok, true);
  assert.equal(out.confirmation, 'not_sent');
  assert.ok(db.calls.some((c) => c.rpc === 'record_web_consent'));
});

test('only GET and POST are accepted', async () => {
  const fn = loadFunction('enroll');
  setup();
  assert.equal((await fn.handler({ httpMethod: 'DELETE', headers: {} })).statusCode, 405);
});

test('call consent wording is its own statement with every disclosure, and never a condition of texts', () => {
  const t = voiceConsentText('Acme Hospital');
  for (const must of ['by automated voice call from Acme Hospital through the Active SOS eMNS service', 'Calm Water Trading, LLC dba Active SOS', 'artificial or prerecorded voice',
    'Call frequency varies', 'Consent is not a condition of any purchase or of receiving text alerts', 'Press 9 on any call to stop calls', 'Privacy Policy and SMS Terms']) {
    assert.ok(t.includes(must), must);
  }
  assert.notEqual(VOICE_TEXT_VERSION, TEXT_VERSION);
});

test('GET: the form also offers the call statement with its own version and whether calls were already agreed', async () => {
  const fn = loadFunction('enroll');
  setup();
  const r = JSON.parse((await fn.handler(get(token))).body);
  assert.equal(r.voice_consent_text, voiceConsentText('Acme Hospital'));
  assert.equal(r.voice_text_version, VOICE_TEXT_VERSION);
  assert.equal(r.voice_consented, false);
  setup({ info: { ...VALID, voice_consented: true } });
  assert.equal(JSON.parse((await fn.handler(get(token))).body).voice_consented, true);
});

test('POST with the call box ticked records the exact call wording and version alongside the text wording', async () => {
  const fn = loadFunction('enroll');
  const { db, provider } = setup({ rec: { ...REC, text_recorded: true, voice_recorded: true } });
  const out = JSON.parse((await fn.handler(post(token, { text: true, voice: true }))).body);
  assert.equal(out.ok, true);
  assert.equal(out.voice, true);
  const rec = db.calls.find((c) => c.rpc === 'record_web_consent').args;
  assert.equal(rec.p_text, consentText('Acme Hospital'));
  assert.equal(rec.p_voice_agreed, true);
  assert.equal(rec.p_voice_text, voiceConsentText('Acme Hospital'));
  assert.equal(rec.p_voice_text_version, VOICE_TEXT_VERSION);
  assert.equal(provider.sent.length, 1, 'one confirmation text for the text agreement');
});

test('POST agreeing to calls only: text wording is not recorded and no text is sent', async () => {
  const fn = loadFunction('enroll');
  const { db, provider } = setup({ info: { ...VALID, already_consented: true }, rec: { ...REC, already_consented: true, text_recorded: false, voice_recorded: true } });
  const out = JSON.parse((await fn.handler(post(token, { text: false, voice: true }))).body);
  assert.equal(out.ok, true);
  assert.equal(out.voice, true);
  assert.equal(out.confirmation, 'not_needed');
  const rec = db.calls.find((c) => c.rpc === 'record_web_consent').args;
  assert.equal(rec.p_text, null);
  assert.equal(rec.p_text_version, null);
  assert.equal(rec.p_voice_agreed, true);
  assert.equal(provider.sent.length, 0);
});

test('POST with neither box selected is refused and records nothing', async () => {
  const fn = loadFunction('enroll');
  const { db } = setup();
  const res = await fn.handler(post(token, { text: false, voice: false }));
  assert.equal(res.statusCode, 400);
  assert.equal(db.calls.some((c) => c.rpc === 'record_web_consent'), false);
});
