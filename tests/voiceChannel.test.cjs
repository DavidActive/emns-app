const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { formatVoice, answerTwiml, digitTwiml, xmlEscape } = require('../src/server/broadcast/voiceFormat.cjs');
const { createMockVoiceProvider } = require('../src/server/providers/mockVoiceProvider.cjs');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');
const { createTwilioVoiceProvider } = require('../src/server/providers/twilioVoiceProvider.cjs');
const { getVoiceProvider } = require('../src/server/providers/index.cjs');
const { runWorker } = require('../src/server/broadcast/worker.cjs');

// ---------- spoken text ----------
test('spoken text carries the organization and the drill/test wording; alerts carry the brand', () => {
  assert.strictEqual(formatVoice({ kind: 'drill', orgName: 'Acme Hospital', body: 'Go to the east lot' }), 'This is a drill from Acme Hospital. Go to the east lot.');
  assert.strictEqual(formatVoice({ kind: 'drill', orgName: 'Acme', body: '' }), 'This is a drill from Acme. No action is needed.');
  assert.strictEqual(formatVoice({ kind: 'test', orgName: '', body: 'Hello.' }), 'This is a test of the notification system for your organization. Hello.');
  assert.strictEqual(formatVoice({ kind: 'alert', orgName: 'Acme', body: 'Shelter in place\nnow' }), 'Active SOS eMNS alert from Acme. Shelter in place now.');
  assert.throws(() => formatVoice({ kind: 'nope' }));
});

test('browser copy of the spoken text is identical', async () => {
  const { formatVoice: browser } = await import('../src/lib/voiceFormat.mjs');
  for (const kind of ['alert', 'drill', 'test']) {
    for (const body of ['Words here', '', 'Two\nlines  ']) {
      const o = { kind, orgName: 'Acme', body };
      assert.strictEqual(browser(o), formatVoice(o));
    }
  }
});

// ---------- TwiML ----------
test('a person hears the message and the keypad choices; the keypad goes to the delivery-specific URL', () => {
  const x = answerTwiml({ text: 'Fire in building 2 & 3', requiresAck: true, answeredBy: 'human', gatherUrl: 'https://s.test/.netlify/functions/voice-gather/abc' });
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?><Response>/);
  assert.match(x, /<Gather numDigits="1" timeout="6" action="https:\/\/s\.test\/\.netlify\/functions\/voice-gather\/abc" method="POST">/);
  assert.match(x, /Fire in building 2 &amp; 3/);
  assert.match(x, /Press 1 if you are safe\. Press 2 if you need help\. Press 9/);
  assert.ok(!/Fire in building 2 & 3/.test(x), 'text is XML-escaped');
});

test('an answering machine gets the message twice, no prompt and no keypad', () => {
  for (const by of ['machine_start', 'machine_end_beep', 'machine_end_silence', 'fax']) {
    const x = answerTwiml({ text: 'Drill message', requiresAck: true, answeredBy: by, gatherUrl: 'https://s.test/g' });
    assert.ok(!x.includes('<Gather'), by);
    assert.strictEqual(x.split('Drill message').length - 1, 2, by);
    assert.ok(x.includes('<Hangup/>'));
    assert.ok(!/Press 1/.test(x));
  }
});

test('when acknowledgement is not requested only the stop option is offered', () => {
  const x = answerTwiml({ text: 'Info', requiresAck: false, answeredBy: 'human', gatherUrl: 'https://s.test/g' });
  assert.ok(!/Press 1|Press 2/.test(x)); assert.match(x, /press 9/);
});

test('key press replies: safe, help, stop calls, and an unknown key asks again', () => {
  const g = 'https://s.test/g';
  assert.match(digitTwiml({ result: { ok: true, response: 'SAFE' }, requiresAck: true, gatherUrl: g }), /marked safe/);
  assert.match(digitTwiml({ result: { ok: true, response: 'SOS' }, requiresAck: true, gatherUrl: g }), /request for help has been sent/);
  assert.match(digitTwiml({ result: { ok: true, action: 'opt_out' }, requiresAck: true, gatherUrl: g }), /no longer receive calls/);
  const again = digitTwiml({ result: { ok: false, reason: 'invalid_digit' }, requiresAck: true, gatherUrl: g });
  assert.match(again, /that key is not an option/); assert.ok(again.includes('<Gather'));
  assert.strictEqual(xmlEscape(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;');
});

// ---------- providers ----------
test('mock voice provider records calls and forces failures for chosen numbers', async () => {
  const p = createMockVoiceProvider({ failNumbers: { '+15550000009': '13224' } });
  const ok = await p.send({ channel: 'voice', to: '+15550000001', twimlUrl: 'u', statusCallback: 's' });
  assert.match(ok.sid, /^MOCKCALL/);
  await assert.rejects(p.send({ channel: 'voice', to: '+15550000009' }), (e) => e.code === '13224');
  assert.strictEqual(p.sent.length, 1); assert.strictEqual(p.failed.length, 1);
});

test('Twilio voice adapter builds the call request: caller number, TwiML URL, status callback, machine detection, ring time', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 201, json: async () => ({ sid: 'CA123', status: 'queued' }) }; };
  const p = createTwilioVoiceProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_VOICE_FROM: '+15551230000', EMNS_VOICE_RING_SECONDS: '20' }, fetchImpl);
  const r = await p.send({ channel: 'voice', to: '+15559990000', twimlUrl: 'https://s.test/.netlify/functions/voice-twiml/d1', statusCallback: 'https://s.test/.netlify/functions/voice-status' });
  assert.deepStrictEqual(r, { sid: 'CA123', status: 'queued' });
  assert.strictEqual(seen.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json');
  assert.match(seen.init.headers.Authorization, /^Basic /);
  const f = Object.fromEntries(new URLSearchParams(seen.init.body));
  assert.deepStrictEqual(f, {
    To: '+15559990000', From: '+15551230000', Url: 'https://s.test/.netlify/functions/voice-twiml/d1', Method: 'POST', Timeout: '20',
    MachineDetection: 'Enable', StatusCallbackEvent: 'completed', StatusCallbackMethod: 'POST', StatusCallback: 'https://s.test/.netlify/functions/voice-status',
  });
});

test('Twilio voice adapter reports missing configuration and carrier errors with their codes', async () => {
  const bad = createTwilioVoiceProvider({}, async () => { throw new Error('should not be called'); });
  await assert.rejects(bad.send({ to: '+1', twimlUrl: 'u' }), (e) => e.code === 'not_configured');
  const noFrom = createTwilioVoiceProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }, async () => { throw new Error('no'); });
  await assert.rejects(noFrom.send({ to: '+1', twimlUrl: 'u' }), (e) => e.code === 'not_configured' && /TWILIO_VOICE_FROM/.test(e.message));
  const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_VOICE_FROM: '+15551230000' };
  const rejected = createTwilioVoiceProvider(env, async () => ({ ok: false, status: 400, json: async () => ({ code: 21215, message: 'Geo permission' }) }));
  await assert.rejects(rejected.send({ to: '+1', twimlUrl: 'u' }), (e) => e.code === 21215);
  const noUrl = createTwilioVoiceProvider(env, async () => { throw new Error('no'); });
  await assert.rejects(noUrl.send({ to: '+1' }), (e) => e.code === 'bad_request');
});

test('the voice provider defaults to the safe mock and refuses real calls without the master switch', () => {
  assert.strictEqual(getVoiceProvider({}).name, 'mock');
  assert.throws(() => getVoiceProvider({ EMNS_VOICE_PROVIDER: 'twilio' }), (e) => e.code === 'real_send_disabled');
  assert.strictEqual(getVoiceProvider({ EMNS_VOICE_PROVIDER: 'twilio', EMNS_ALLOW_REAL_SEND: 'true', TWILIO_ACCOUNT_SID: 'a' }).name, 'twilio');
  assert.throws(() => getVoiceProvider({ EMNS_VOICE_PROVIDER: 'carrier-pigeon' }), (e) => e.code === 'bad_config');
});

// ---------- worker ----------
function queue(rows) {
  let claimed = false; const results = []; const claimArgs = [];
  return {
    results, claimArgs,
    async rpc(name, a) {
      if (name === 'claim_deliveries') { claimArgs.push(a); if (claimed) return { data: [], error: null }; claimed = true; return { data: rows, error: null }; }
      if (name === 'record_delivery_result') { results.push(a); return { data: true, error: null }; }
      throw new Error('unexpected rpc ' + name);
    },
    from() { const b = { update: () => b, eq: async () => ({ error: null }) }; return b; },
  };
}
const vrow = (id, channel, extra) => ({ delivery_id: id, event_id: 'e1', organization_id: 'o1', person_id: 'p' + id, channel, to_number: '+1555000' + id.replace(/\D/g, '').padStart(4, '0'), to_email: null, subject: null, body: 'Body ' + id, attempt: 1, ...extra });
const BASE = 'https://s.test/.netlify/functions';

test('worker places call rows through the voice provider with signed-path URLs, and texts through the text provider', async () => {
  const db = queue([vrow('d1', 'sms'), vrow('d2', 'voice'), vrow('d3', 'voice')]);
  const sms = createMockMessageProvider(); const voice = createMockVoiceProvider();
  const stats = await runWorker({ db, provider: sms, voiceProvider: voice, voiceBaseUrl: BASE, workerId: 'w' });
  assert.strictEqual(sms.sent.length, 1); assert.strictEqual(voice.sent.length, 2);
  assert.deepStrictEqual(voice.sent.map((s) => [s.channel, s.twimlUrl, s.statusCallback]), [
    ['voice', `${BASE}/voice-twiml/d2`, `${BASE}/voice-status`], ['voice', `${BASE}/voice-twiml/d3`, `${BASE}/voice-status`]]);
  assert.strictEqual(stats.sent, 3); assert.strictEqual(stats.voiceSent, 2);
  assert.ok(db.results.every((r) => r.p_outcome === 'sent' && /^MOCK/.test(r.p_sid)));
});

test('the call concurrency limit is handed to the queue on every claim', async () => {
  const db = queue([vrow('d1', 'voice')]);
  await runWorker({ db, provider: createMockMessageProvider(), voiceProvider: createMockVoiceProvider(), voiceBaseUrl: BASE, voiceMaxActive: 7, workerId: 'w' });
  assert.ok(db.claimArgs.length >= 1 && db.claimArgs.every((a) => a.p_voice_max_active === 7));
  const db2 = queue([]);
  await runWorker({ db: db2, provider: createMockMessageProvider(), workerId: 'w' });
  assert.strictEqual(db2.claimArgs[0].p_voice_max_active, 0, 'no cap by default');
});

test('call failures: unreachable number or missing permission fail permanently (next channel takes over); other errors are retried', async () => {
  const db = queue([vrow('d1', 'voice'), vrow('d2', 'voice'), vrow('d3', 'voice'), vrow('d4', 'voice')]);
  const nums = (id) => '+1555000' + id.replace(/\D/g, '').padStart(4, '0');
  const voice = createMockVoiceProvider({ failNumbers: { [nums('d1')]: '13224', [nums('d2')]: '21215', [nums('d3')]: 'timeout' } });
  const stats = await runWorker({ db, provider: createMockMessageProvider(), voiceProvider: voice, voiceBaseUrl: BASE, workerId: 'w' });
  const by = Object.fromEntries(db.results.map((r) => [r.p_delivery, r]));
  assert.strictEqual(by.d1.p_outcome, 'failed'); assert.strictEqual(by.d1.p_error_code, '13224');
  assert.strictEqual(by.d2.p_outcome, 'failed'); assert.strictEqual(by.d2.p_error_code, '21215');
  assert.strictEqual(by.d3.p_outcome, 'retry'); assert.strictEqual(by.d4.p_outcome, 'sent');
  assert.strictEqual(stats.voiceFailed, 2); assert.strictEqual(stats.retried, 1);
});

test('with no voice provider available, call rows fail over instead of being lost or retried forever', async () => {
  const db = queue([vrow('d1', 'voice')]);
  await runWorker({ db, provider: createMockMessageProvider(), workerId: 'w' });
  assert.strictEqual(db.results[0].p_outcome, 'failed'); assert.strictEqual(db.results[0].p_error_code, 'voice_not_configured');
});

test('a call error never changes a person\'s text opt-out', async () => {
  let updates = 0;
  const db = queue([vrow('d1', 'voice')]);
  db.from = () => { const b = { update: () => { updates++; return b; }, eq: async () => ({ error: null }) }; return b; };
  const voice = createMockVoiceProvider({ failNumbers: { '+15550000001': '21610' } });
  await runWorker({ db, provider: createMockMessageProvider(), voiceProvider: voice, voiceBaseUrl: BASE, workerId: 'w' });
  assert.strictEqual(updates, 0);
});

// ---------- call endpoints ----------
const ID = '44444444-4444-4444-4444-444444444444';
const TOKEN = 'test-auth-token';
const HOST = 'x.netlify.app';
function signed(fnPath, params, { tamper = false } = {}) {
  const url = `https://${HOST}/.netlify/functions/${fnPath}`;
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  const sig = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  return { httpMethod: 'POST', path: `/.netlify/functions/${fnPath}`, headers: { host: HOST, 'x-twilio-signature': tamper ? 'AAAA' + sig.slice(4) : sig }, body: new URLSearchParams(params).toString() };
}
function env(on = true) { process.env.TWILIO_AUTH_TOKEN = TOKEN; delete process.env.TWILIO_WEBHOOK_BASE_URL; if (on) delete process.env.TWILIO_ENFORCE_SIGNATURE; else process.env.TWILIO_ENFORCE_SIGNATURE = 'false'; }
const tables = (extra = {}) => ({
  notification_deliveries: { id: ID, event_id: 'e1', channel: 'voice' },
  notification_events: { requires_ack: true, body: 'Text version', voice_text: 'This is a drill from Acme. Meet at the east lot.' },
  ...extra,
});

test('voice-twiml speaks the stored call text to a person and rejects unsigned or malformed requests', async () => {
  env(); const fn = loadFunction('voice-twiml');
  setDbForTests(createFakeDb({ tables: tables() }));
  const ok = await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1', AnsweredBy: 'human' }));
  assert.strictEqual(ok.statusCode, 200); assert.strictEqual(ok.headers['Content-Type'], 'text/xml');
  assert.match(ok.body, /Meet at the east lot/); assert.match(ok.body, new RegExp(`voice-gather/${ID}`)); assert.match(ok.body, /Press 1 if you are safe/);
  const machine = await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1', AnsweredBy: 'machine_end_beep' }));
  assert.ok(!machine.body.includes('<Gather'));
  assert.strictEqual((await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1' }, { tamper: true }))).statusCode, 403);
  assert.strictEqual((await fn.handler(signed(`voice-twiml/not-a-uuid`, { CallSid: 'CA1' }))).statusCode, 404);
  // a signature made for one delivery does not work on another (the id is inside the signed URL)
  const other = signed(`voice-twiml/${ID}`, { CallSid: 'CA1' }); other.path = `/.netlify/functions/voice-twiml/55555555-5555-5555-5555-555555555555`;
  assert.strictEqual((await fn.handler(other)).statusCode, 403);
});

test('voice-twiml falls back to the text body, and says sorry for a call it does not know', async () => {
  env(); const fn = loadFunction('voice-twiml');
  setDbForTests(createFakeDb({ tables: tables({ notification_events: { requires_ack: false, body: 'Text only words', voice_text: null } }) }));
  const r = await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1', AnsweredBy: 'human' }));
  assert.match(r.body, /Text only words/); assert.ok(!/Press 1/.test(r.body));
  setDbForTests(createFakeDb({ tables: tables({ notification_deliveries: { id: ID, event_id: 'e1', channel: 'sms' } }) }));
  assert.match((await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1' }))).body, /could not be completed/);
  setDbForTests(createFakeDb({ tables: { notification_deliveries: null } }));
  assert.match((await fn.handler(signed(`voice-twiml/${ID}`, { CallSid: 'CA1' }))).body, /could not be completed/);
});

test('voice-gather records the key through the database and answers with the right words', async () => {
  env(); const fn = loadFunction('voice-gather');
  const results = { 1: { ok: true, response: 'SAFE' }, 2: { ok: true, response: 'SOS' }, 9: { ok: true, action: 'opt_out' }, 5: { ok: false, reason: 'invalid_digit' } };
  let db;
  const run = async (d) => {
    db = createFakeDb({ tables: tables(), rpc: { record_keypad_ack: (a) => ({ data: results[a.p_digit], error: null }) } });
    setDbForTests(db);
    return fn.handler(signed(`voice-gather/${ID}`, { CallSid: 'CA9', Digits: d }));
  };
  assert.match((await run('1')).body, /marked safe/);
  assert.deepStrictEqual(db.calls.find((c) => c.rpc).args, { p_delivery: ID, p_digit: '1', p_call_sid: 'CA9' });
  assert.match((await run('2')).body, /request for help has been sent/);
  assert.match((await run('9')).body, /no longer receive calls/);
  const bad = await run('5'); assert.match(bad.body, /not an option/); assert.ok(bad.body.includes('<Gather'));
  assert.strictEqual(db.calls.find((c) => c.rpc).args.p_digit, '5');
});

test('voice-gather: extra digits are cut to one, bad signatures record nothing, a database error never leaves the caller in silence', async () => {
  env(); const fn = loadFunction('voice-gather');
  let db = createFakeDb({ tables: tables(), rpc: { record_keypad_ack: () => ({ data: { ok: true, response: 'SAFE' }, error: null }) } });
  setDbForTests(db);
  await fn.handler(signed(`voice-gather/${ID}`, { CallSid: 'CA9', Digits: '12' }));
  assert.strictEqual(db.calls.find((c) => c.rpc).args.p_digit, '1');
  db = createFakeDb({ tables: tables(), rpc: { record_keypad_ack: () => ({ data: null, error: { message: 'db down' } }) } });
  setDbForTests(db);
  const err = await fn.handler(signed(`voice-gather/${ID}`, { CallSid: 'CA9', Digits: '1' }));
  assert.strictEqual(err.statusCode, 200); assert.match(err.body, /could not record that/); assert.match(err.body, /emergency services/);
  db = createFakeDb({ tables: tables() }); setDbForTests(db);
  assert.strictEqual((await fn.handler(signed(`voice-gather/${ID}`, { CallSid: 'CA9', Digits: '1' }, { tamper: true }))).statusCode, 403);
  assert.strictEqual(db.calls.some((c) => c.rpc), false);
});

test('voice-status passes the carrier result to the database and fails closed', async () => {
  env(); const fn = loadFunction('voice-status');
  let db = createFakeDb({ rpc: { apply_call_status: () => ({ data: true, error: null }) } }); setDbForTests(db);
  const r = await fn.handler(signed('voice-status', { CallSid: 'CA7', CallStatus: 'completed', AnsweredBy: 'machine_start', CallDuration: '31', ErrorCode: '' }));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(db.calls.find((c) => c.rpc).args, { p_sid: 'CA7', p_call_status: 'completed', p_answered_by: 'machine_start', p_duration: 31, p_error_code: null });
  await fn.handler(signed('voice-status', { CallSid: 'CA8', CallStatus: 'no-answer' }));
  assert.deepStrictEqual(db.calls.filter((c) => c.rpc).at(-1).args, { p_sid: 'CA8', p_call_status: 'no-answer', p_answered_by: null, p_duration: null, p_error_code: null });
  const n = db.calls.filter((c) => c.rpc).length;
  assert.strictEqual((await fn.handler(signed('voice-status', { CallSid: 'CA9', CallStatus: 'completed' }, { tamper: true }))).statusCode, 403);
  assert.strictEqual((await fn.handler(signed('voice-status', { CallStatus: 'completed' }))).statusCode, 200);
  assert.strictEqual(db.calls.filter((c) => c.rpc).length, n, 'nothing recorded for rejected or incomplete requests');
  setDbForTests(createFakeDb({ rpc: { apply_call_status: () => ({ data: null, error: { message: 'db down' } }) } }));
  assert.strictEqual((await fn.handler(signed('voice-status', { CallSid: 'CA7', CallStatus: 'completed' }))).statusCode, 500);
});

// ---------- send-event with voice ----------
const G1 = '11111111-1111-1111-1111-111111111111';
const post = (body) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer good', host: 'x.netlify.app' }, body: JSON.stringify(body) });
function setup(scenario = null) {
  const db = createFakeDb({
    tables: { operators: { id: 'op1', organization_id: 'org1', role: 'admin', is_platform_admin: false }, organizations: { name: 'Acme Hospital', settings: {} }, notification_scenarios: scenario },
    user: { id: 'u1' }, rpc: { create_notification_event: () => ({ data: { event_id: 'e1', deduplicated: false, queued: 3, held: 0, skipped: 0 }, error: null }) },
  });
  setDbForTests(db); return db;
}
const args = (db) => db.calls.find((c) => c.rpc === 'create_notification_event').args;

test('send-event builds the spoken text itself and applies the default retry rules', async () => {
  const fn = loadFunction('send-event'); const db = setup();
  const r = await fn.handler(post({ kind: 'drill', body: 'Meet at the east lot', group_ids: [G1], channels: ['voice', 'sms'], mode: 'fallback' }));
  assert.strictEqual(r.statusCode, 200);
  const a = args(db);
  assert.deepStrictEqual(a.p_channels, ['voice', 'sms']); assert.strictEqual(a.p_mode, 'fallback');
  assert.strictEqual(a.p_voice_text, 'This is a drill from Acme Hospital. Meet at the east lot.');
  assert.strictEqual(a.p_voice_max_attempts, 2); assert.strictEqual(a.p_voice_retry_seconds, 120);
});

test('send-event leaves out spoken text when voice is not selected', async () => {
  const fn = loadFunction('send-event'); const db = setup();
  await fn.handler(post({ kind: 'drill', group_ids: [G1] }));
  assert.strictEqual(args(db).p_voice_text, null);
});

test('send-event keeps the retry rules inside their limits, and accepts a separate spoken message', async () => {
  const fn = loadFunction('send-event');
  const run = async (extra) => { const db = setup(); const r = await fn.handler(post({ kind: 'alert', body: 'Text words', group_ids: [G1], channels: ['voice'], ...extra })); assert.strictEqual(r.statusCode, 200); return args(db); };
  let a = await run({ voice_max_attempts: 99, voice_retry_seconds: 5 });
  assert.strictEqual(a.p_voice_max_attempts, 5); assert.strictEqual(a.p_voice_retry_seconds, 30);
  a = await run({ voice_max_attempts: 0, voice_retry_seconds: 999999 });
  assert.strictEqual(a.p_voice_max_attempts, 1); assert.strictEqual(a.p_voice_retry_seconds, 3600);
  a = await run({ voice_max_attempts: 'many', voice_retry_seconds: null });
  assert.strictEqual(a.p_voice_max_attempts, 2); assert.strictEqual(a.p_voice_retry_seconds, 120);
  a = await run({ voice_text: 'Spoken words only' });
  assert.strictEqual(a.p_voice_text, 'Active SOS eMNS alert from Acme Hospital. Spoken words only.');
});

test('send-event takes the spoken message from the scenario, and refuses a spoken message that is too long', async () => {
  const fn = loadFunction('send-event');
  const scenario = { id: '33333333-3333-3333-3333-333333333333', kind: 'drill', bodies: { sms: 'sms words', voice: 'Scenario spoken words' }, default_group_ids: [G1], requires_ack: true };
  let db = setup(scenario);
  await fn.handler(post({ kind: 'drill', scenario_id: scenario.id, channels: ['voice'] }));
  assert.strictEqual(args(db).p_voice_text, 'This is a drill from Acme Hospital. Scenario spoken words.');
  db = setup();
  const r = await fn.handler(post({ kind: 'drill', group_ids: [G1], channels: ['voice'], voice_text: 'x'.repeat(1100) }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(db.calls.some((c) => c.rpc === 'create_notification_event'), false);
});
