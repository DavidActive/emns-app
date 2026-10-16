const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { formatEmail } = require('../src/server/broadcast/emailFormat.cjs');
const { createMockEmailProvider } = require('../src/server/providers/mockEmailProvider.cjs');
const { createMockMessageProvider } = require('../src/server/providers/mockMessageProvider.cjs');
const { createResendEmailProvider, htmlFromText } = require('../src/server/providers/resendEmailProvider.cjs');
const { getEmailProvider } = require('../src/server/providers/index.cjs');
const { verifySvix, signSvix } = require('../src/server/providers/svixSignature.cjs');
const { runWorker } = require('../src/server/broadcast/worker.cjs');

// ---------- formatting ----------
test('email text carries brand footer, organization, tag, and never puts a line break in the subject', () => {
  const d = formatEmail({ kind: 'drill', orgName: 'Acme Hospital', subject: 'Evacuation\r\nBcc: x@evil.test', body: 'Go to the east lot', requiresAck: true });
  assert.ok(!/[\r\n]/.test(d.subject));
  assert.match(d.subject, /^\[DRILL\] Evacuation Bcc: x@evil\.test$/);
  assert.match(d.text, /^\[DRILL\] This is a drill from Acme Hospital\./);
  assert.match(d.text, /Go to the east lot/);
  assert.match(d.text, /Sent by Active SOS eMNS on behalf of Acme Hospital/);
  const a = formatEmail({ kind: 'alert', orgName: 'Acme Hospital', subject: 'Shelter in place', body: 'Stay inside.', requiresAck: false });
  assert.strictEqual(a.subject, 'ALERT from Acme Hospital: Shelter in place');
  assert.ok(!/reply SAFE/i.test(a.text), 'no reply prompt when acknowledgement is not requested');
  const t = formatEmail({ kind: 'test', orgName: '', body: '', testTag: 'sys test' });
  assert.match(t.subject, /^\[SYS TEST\] Test of the notification system for your organization$/);
  assert.match(t.text, /No action is needed\./);
  assert.throws(() => formatEmail({ kind: 'nope' }));
  assert.ok(formatEmail({ kind: 'alert', orgName: 'X', subject: 'a'.repeat(500), body: 'b' }).subject.length <= 200);
});

test('browser preview copy of the email formatter produces identical text', async () => {
  const { formatEmail: browser } = await import('../src/lib/emailFormat.mjs');
  for (const kind of ['alert', 'drill', 'test']) {
    for (const requiresAck of [true, false]) {
      const o = { kind, orgName: 'Acme', subject: 'S', body: 'Body text', requiresAck, drillTag: 'exercise', testTag: 'check' };
      assert.deepStrictEqual(browser(o), formatEmail(o));
    }
  }
});

// ---------- providers ----------
test('mock email provider records sends and forces failures for chosen addresses', async () => {
  const p = createMockEmailProvider({ failAddresses: { 'bad@example.test': 'invalid_email' } });
  const ok = await p.send({ channel: 'email', to: 'a@example.test', subject: 's', body: 'b' });
  assert.match(ok.sid, /^MOCKMAIL/);
  await assert.rejects(p.send({ channel: 'email', to: 'bad@example.test', subject: 's', body: 'b' }), (e) => e.code === 'invalid_email');
  assert.strictEqual(p.sent.length, 1); assert.strictEqual(p.failed.length, 1);
});

test('Resend adapter builds the right request and escapes the HTML copy', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ id: 'abc123' }) }; };
  const p = createResendEmailProvider({ RESEND_API_KEY: 'key_1', EMNS_EMAIL_FROM: 'eMNS <alerts@example.test>', EMNS_EMAIL_REPLY_TO: 'ops@example.test' }, fetchImpl);
  const r = await p.send({ channel: 'email', to: 'person@example.test', subject: 'Hello', body: 'a <b>bold</b> & more', idempotencyKey: 'emns-d1' });
  assert.deepStrictEqual(r, { sid: 'abc123', status: 'queued' });
  assert.strictEqual(seen.url, 'https://api.resend.com/emails');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer key_1');
  assert.strictEqual(seen.init.headers['Idempotency-Key'], 'emns-d1');
  const body = JSON.parse(seen.init.body);
  assert.deepStrictEqual(body.to, ['person@example.test']);
  assert.strictEqual(body.from, 'eMNS <alerts@example.test>'); assert.strictEqual(body.reply_to, 'ops@example.test');
  assert.strictEqual(body.text, 'a <b>bold</b> & more');
  assert.ok(body.html.includes('a &lt;b&gt;bold&lt;/b&gt; &amp; more') && !body.html.includes('<b>'));
  assert.ok(htmlFromText('"q"').includes('&quot;q&quot;'));
});

test('Resend errors map to permanent (next channel) or retryable codes', async () => {
  const env = { RESEND_API_KEY: 'k', EMNS_EMAIL_FROM: 'a@example.test' };
  const mk = (status, data) => createResendEmailProvider(env, async () => ({ ok: false, status, json: async () => data }));
  const send = (p) => p.send({ channel: 'email', to: 'x@example.test', subject: 's', body: 'b' });
  await assert.rejects(send(mk(422, { name: 'validation_error', message: 'bad to' })), (e) => e.code === 'invalid_email' && /bad to/.test(e.message));
  await assert.rejects(send(mk(401, { message: 'no' })), (e) => e.code === 'email_auth');
  await assert.rejects(send(mk(429, {})), (e) => e.code === 'rate_limited');
  await assert.rejects(send(mk(503, {})), (e) => e.code === '503');
  await assert.rejects(send(mk(400, {})), (e) => e.code === 'email_rejected');
  await assert.rejects(send(createResendEmailProvider(env, async () => { throw new Error('boom'); })), (e) => e.code === 'network');
  await assert.rejects(send(createResendEmailProvider({}, async () => ({}))), (e) => e.code === 'email_not_configured');
});

test('email provider factory defaults to the mock and refuses real sends unless explicitly allowed', () => {
  assert.strictEqual(getEmailProvider({}).name, 'mock');
  assert.throws(() => getEmailProvider({ EMNS_EMAIL_PROVIDER: 'resend' }), (e) => e.code === 'real_send_disabled');
  assert.strictEqual(getEmailProvider({ EMNS_EMAIL_PROVIDER: 'resend', EMNS_ALLOW_REAL_SEND: 'true', RESEND_API_KEY: 'k', EMNS_EMAIL_FROM: 'a@example.test' }).name, 'resend');
  assert.throws(() => getEmailProvider({ EMNS_EMAIL_PROVIDER: 'pigeon' }), (e) => e.code === 'bad_config');
});

// ---------- worker routing ----------
function mixedQueue(rows) {
  const results = [];
  let claimed = false;
  return {
    results,
    async rpc(name, args) {
      if (name === 'claim_deliveries') { if (claimed) return { data: [], error: null }; claimed = true; return { data: rows, error: null }; }
      if (name === 'record_delivery_result') { results.push(args); return { data: true, error: null }; }
      throw new Error('unexpected rpc ' + name);
    },
    from() { const b = { update: () => b, eq: async () => ({ error: null }) }; return b; },
  };
}
const row = (id, channel, extra) => ({ delivery_id: id, event_id: 'e1', organization_id: 'o1', person_id: 'p' + id, channel, to_number: channel === 'sms' ? '+15550000001' : null, to_email: channel === 'email' ? id + '@example.test' : null, subject: channel === 'email' ? 'Subj' : null, body: 'Body ' + id, attempt: 1, ...extra });

test('worker sends email rows through the email provider and text rows through the text provider', async () => {
  const db = mixedQueue([row('d1', 'sms'), row('d2', 'email'), row('d3', 'email')]);
  const sms = createMockMessageProvider(); const email = createMockEmailProvider();
  const stats = await runWorker({ db, provider: sms, emailProvider: email, workerId: 'w' });
  assert.strictEqual(sms.sent.length, 1); assert.strictEqual(email.sent.length, 2);
  assert.deepStrictEqual(email.sent.map((s) => [s.to, s.subject, s.body, s.idempotencyKey]), [['d2@example.test', 'Subj', 'Body d2', 'emns-d2'], ['d3@example.test', 'Subj', 'Body d3', 'emns-d3']]);
  assert.strictEqual(sms.sent[0].channel, 'sms');
  assert.strictEqual(stats.sent, 3); assert.strictEqual(stats.emailSent, 2);
  assert.ok(db.results.every((r) => r.p_outcome === 'sent'));
});

test('a bad address fails permanently (so the next channel takes over); a rate limit is retried', async () => {
  const db = mixedQueue([row('d1', 'email'), row('d2', 'email'), row('d3', 'email')]);
  const email = createMockEmailProvider({ failAddresses: { 'd1@example.test': 'invalid_email', 'd2@example.test': 'rate_limited' } });
  const stats = await runWorker({ db, provider: createMockMessageProvider(), emailProvider: email, workerId: 'w' });
  const by = Object.fromEntries(db.results.map((r) => [r.p_delivery, r]));
  assert.strictEqual(by.d1.p_outcome, 'failed'); assert.strictEqual(by.d1.p_error_code, 'invalid_email');
  assert.strictEqual(by.d2.p_outcome, 'retry'); assert.strictEqual(by.d3.p_outcome, 'sent');
  assert.strictEqual(stats.emailFailed, 1); assert.strictEqual(stats.retried, 1);
});

test('with no email provider available, email rows fail over instead of being lost or retried forever', async () => {
  const db = mixedQueue([row('d1', 'email')]);
  await runWorker({ db, provider: createMockMessageProvider(), workerId: 'w' });
  assert.strictEqual(db.results[0].p_outcome, 'failed'); assert.strictEqual(db.results[0].p_error_code, 'email_not_configured');
});

test('the STOP opt-out code only changes a person for text, never for email', async () => {
  let peopleUpdates = 0;
  const db = mixedQueue([row('d1', 'email')]);
  db.from = () => { const b = { update: () => { peopleUpdates++; return b; }, eq: async () => ({ error: null }) }; return b; };
  await runWorker({ db, provider: createMockMessageProvider(), emailProvider: createMockEmailProvider({ failAddresses: { 'd1@example.test': '21610' } }), workerId: 'w' });
  assert.strictEqual(peopleUpdates, 0);
});

// ---------- webhook signature + function ----------
const SECRET = 'whsec_' + Buffer.from('super-secret-key-bytes').toString('base64');
test('Svix signatures: valid, tampered, wrong secret, stale, and multi-signature headers', () => {
  const rawBody = '{"type":"email.bounced"}'; const now = Date.now(); const ts = Math.floor(now / 1000);
  const h = signSvix({ id: 'msg_1', timestamp: ts, rawBody, secret: SECRET });
  const base = { id: h['svix-id'], timestamp: h['svix-timestamp'], signatureHeader: h['svix-signature'], rawBody, secret: SECRET, nowMs: now };
  assert.strictEqual(verifySvix(base), true);
  assert.strictEqual(verifySvix({ ...base, rawBody: rawBody + ' ' }), false);
  assert.strictEqual(verifySvix({ ...base, secret: 'whsec_' + Buffer.from('other').toString('base64') }), false);
  assert.strictEqual(verifySvix({ ...base, nowMs: now + 10 * 60 * 1000 }), false);
  assert.strictEqual(verifySvix({ ...base, signatureHeader: 'v1,AAAA ' + h['svix-signature'] }), true);
  assert.strictEqual(verifySvix({ ...base, signatureHeader: 'v2,' + h['svix-signature'].slice(3) }), false);
  assert.strictEqual(verifySvix({ ...base, id: undefined }), false);
});

function webhookEvent(payload, { secret = SECRET, tamper = false } = {}) {
  const rawBody = JSON.stringify(payload); const ts = Math.floor(Date.now() / 1000);
  const headers = signSvix({ id: 'msg_1', timestamp: ts, rawBody, secret });
  return { httpMethod: 'POST', headers, body: tamper ? rawBody.replace('email.', 'email_') : rawBody };
}
test('webhook records bounces, complaints and receipts through the database function', async () => {
  const fn = loadFunction('email-webhook');
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const db = createFakeDb({ rpc: { record_email_event: () => ({ data: true, error: null }) } });
  setDbForTests(db);
  const r = await fn.handler(webhookEvent({ type: 'email.bounced', data: { email_id: 'em_9', bounce: { type: 'Permanent' } } }));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(db.calls.find((c) => c.rpc === 'record_email_event').args, { p_sid: 'em_9', p_type: 'email.bounced', p_bounce_type: 'Permanent' });
  await fn.handler(webhookEvent({ type: 'email.delivered', data: { email_id: 'em_10' } }));
  assert.deepStrictEqual(db.calls.filter((c) => c.rpc).at(-1).args, { p_sid: 'em_10', p_type: 'email.delivered', p_bounce_type: null });
  await fn.handler(webhookEvent({ type: 'email.complained', data: { email_id: 'em_11' } }));
  assert.strictEqual(db.calls.filter((c) => c.rpc).at(-1).args.p_type, 'email.complained');
});

test('webhook fails closed: bad signature, missing secret, wrong method; ignores other event types', async () => {
  const fn = loadFunction('email-webhook');
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const db = createFakeDb({ rpc: { record_email_event: () => ({ data: true, error: null }) } });
  setDbForTests(db);
  assert.strictEqual((await fn.handler(webhookEvent({ type: 'email.bounced', data: { email_id: 'x' } }, { tamper: true }))).statusCode, 401);
  assert.strictEqual((await fn.handler(webhookEvent({ type: 'email.bounced', data: { email_id: 'x' } }, { secret: 'whsec_' + Buffer.from('nope').toString('base64') }))).statusCode, 401);
  assert.strictEqual((await fn.handler({ httpMethod: 'GET', headers: {}, body: '' })).statusCode, 405);
  assert.strictEqual((await fn.handler(webhookEvent({ type: 'email.opened', data: { email_id: 'x' } }))).statusCode, 200);
  assert.strictEqual(db.calls.some((c) => c.rpc), false, 'nothing recorded for rejected or ignored requests');
  delete process.env.RESEND_WEBHOOK_SECRET;
  assert.strictEqual((await fn.handler(webhookEvent({ type: 'email.bounced', data: { email_id: 'x' } }))).statusCode, 503);
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  setDbForTests(createFakeDb({ rpc: { record_email_event: () => ({ data: null, error: { message: 'db down' } }) } }));
  assert.strictEqual((await fn.handler(webhookEvent({ type: 'email.bounced', data: { email_id: 'x' } }))).statusCode, 500, 'Resend retries on 5xx');
  delete process.env.RESEND_WEBHOOK_SECRET;
});

// ---------- send-event with channels ----------
const G1 = '11111111-1111-1111-1111-111111111111';
const operator = (role) => ({ id: 'op1', organization_id: 'org1', role, is_platform_admin: false });
const RPC_OK = { data: { event_id: 'e1', deduplicated: false, queued: 3, held: 0, skipped: 0 }, error: null };
const post = (body) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer good', host: 'x.netlify.app' }, body: JSON.stringify(body) });
function setup(scenario = null) {
  const db = createFakeDb({ tables: { operators: operator('admin'), organizations: { name: 'Acme Hospital', settings: {} }, notification_scenarios: scenario }, user: { id: 'u1' }, rpc: { create_notification_event: () => RPC_OK } });
  setDbForTests(db); return db;
}
const args = (db) => db.calls.find((c) => c.rpc === 'create_notification_event').args;

test('send-event defaults to text only and passes no email content', async () => {
  const fn = loadFunction('send-event'); const db = setup();
  const r = await fn.handler(post({ kind: 'drill', group_ids: [G1] }));
  assert.strictEqual(r.statusCode, 200);
  const a = args(db);
  assert.deepStrictEqual(a.p_channels, ['sms']); assert.strictEqual(a.p_mode, 'together'); assert.strictEqual(a.p_email_subject, null); assert.strictEqual(a.p_email_body, null);
});

test('send-event builds the email subject and text itself and passes channel order and mode', async () => {
  const fn = loadFunction('send-event'); const db = setup();
  const r = await fn.handler(post({ kind: 'drill', body: 'Meet at the east lot', group_ids: [G1], channels: ['email', 'sms'], mode: 'fallback', email_subject: 'Evacuation drill' }));
  assert.strictEqual(r.statusCode, 200);
  const a = args(db);
  assert.deepStrictEqual(a.p_channels, ['email', 'sms']); assert.strictEqual(a.p_mode, 'fallback');
  assert.strictEqual(a.p_email_subject, '[DRILL] Evacuation drill');
  assert.match(a.p_email_body, /Meet at the east lot/); assert.match(a.p_email_body, /Sent by Active SOS eMNS on behalf of Acme Hospital/);
  assert.match(a.p_body, /^Active SOS eMNS: \[DRILL\]/, 'the text version is still built as before');
});

test('send-event rejects bad channels and modes before touching the database', async () => {
  const fn = loadFunction('send-event');
  for (const extra of [{ channels: [] }, { channels: ['carrier-pigeon'] }, { channels: ['sms', 'sms'] }, { channels: 'sms' }, { mode: 'sideways' }]) {
    const db = setup();
    const r = await fn.handler(post({ kind: 'drill', group_ids: [G1], ...extra }));
    assert.strictEqual(r.statusCode, 400, JSON.stringify(extra));
    assert.strictEqual(db.calls.some((c) => c.rpc === 'create_notification_event'), false);
  }
});

test('send-event takes the email subject and body from the scenario when the request gives none', async () => {
  const fn = loadFunction('send-event');
  const scenario = { id: '33333333-3333-3333-3333-333333333333', kind: 'drill', bodies: { sms: 'sms words', email: { subject: 'Scenario subject', body: 'Scenario email words' } }, default_group_ids: [G1], requires_ack: true };
  const db = setup(scenario);
  const r = await fn.handler(post({ kind: 'drill', scenario_id: scenario.id, channels: ['email'] }));
  assert.strictEqual(r.statusCode, 200);
  const a = args(db);
  assert.strictEqual(a.p_email_subject, '[DRILL] Scenario subject');
  assert.match(a.p_email_body, /Scenario email words/);
  assert.doesNotMatch(a.p_email_body, /sms words/);
});
