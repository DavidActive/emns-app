const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const tokens = require('../src/server/agentToken.cjs');
const { formatDesktop } = require('../src/server/broadcast/desktopFormat.cjs');
const { Agent } = require('../agent/src/core/agent.cjs');
const { createStore } = require('../agent/src/core/store.cjs');
const { createClient, normalizeServerUrl, RevokedError } = require('../agent/src/core/protocol.cjs');

// ---------- tokens and codes ----------
test('pairing codes: 8 unambiguous characters, typed in any case with or without the dash, hashed the same way', () => {
  const code = tokens.newPairingCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(tokens.hashCode(code), tokens.hashCode(code.toLowerCase().replace('-', ' ')));
  assert.notEqual(tokens.hashCode(code), tokens.hashCode(tokens.newPairingCode()));
  for (const bad of ['', 'ABC', 'ABCD-234', 'ABCD-23456', 'ABCD-23O1', 'ABCD-23I1', null, undefined, 12345678]) assert.equal(tokens.hashCode(bad), null, String(bad));
});

test('device tokens: well formed, hashed with a different salt than codes, malformed tokens never hash', () => {
  const t = tokens.newDeviceToken();
  assert.match(t, tokens.TOKEN_RE);
  assert.notEqual(tokens.newDeviceToken(), t);
  assert.match(tokens.hashToken(t), /^[0-9a-f]{64}$/);
  assert.equal(tokens.hashToken('emns_dev_short'), null);
  assert.equal(tokens.hashToken("x' or 1=1 --"), null);
  assert.equal(tokens.hashToken(''), null);
  assert.equal(tokens.bearer({ headers: { Authorization: `Bearer ${t}` } }), t);
  assert.equal(tokens.bearer({ headers: {} }), '');
});

// ---------- text ----------
test('desktop alert text: brand, organization, drill/test wording; the browser copy is identical', async () => {
  assert.equal(formatDesktop({ kind: 'alert', orgName: 'Acme Hospital', body: 'Shelter in place.' }), 'Active SOS eMNS alert from Acme Hospital: Shelter in place.');
  assert.match(formatDesktop({ kind: 'drill', orgName: 'Acme', body: '' }), /^\[DRILL\] Acme: .*No action is needed/);
  assert.match(formatDesktop({ kind: 'test', orgName: '', body: 'x' }), /^\[TEST\] your organization: x$/);
  assert.throws(() => formatDesktop({ kind: 'bogus', orgName: 'A', body: 'x' }));
  assert.doesNotMatch(formatDesktop({ kind: 'alert', orgName: 'A', body: 'x' }), /STOP/i);
  const { formatDesktop: browser } = await import('../src/lib/desktopFormat.mjs');
  for (const kind of ['alert', 'drill', 'test']) for (const body of ['', 'Line one\nline two', '  spaced   out  ']) {
    assert.equal(browser({ kind, orgName: 'Org', body }), formatDesktop({ kind, orgName: 'Org', body }));
  }
});

// ---------- functions against a fake database ----------
const PERSON = { id: 'p1', organization_id: 'org1', is_active: true, user_id: 'u1' };
function makeDb({ rpc = {}, devices = [] } = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => {
      const st = { filters: [] };
      const b = new Proxy({}, { get(_t, k) {
        if (k === 'eq') return (c, v) => { st.filters.push([c, v]); return b; };
        if (k === 'maybeSingle') return async () => ({ data: table === 'people' && st.filters.some(([c, v]) => c === 'user_id' && v === 'u1') ? PERSON : null, error: null });
        if (k === 'then') return (res) => Promise.resolve({ data: table === 'agent_devices' ? devices : [], error: null }).then(res);
        return () => b;
      } });
      return b;
    },
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return rpc[name] ? rpc[name](args) : { data: { ok: true }, error: null }; },
    auth: { getUser: async (t) => (t === 'good' ? { data: { user: { id: 'u1' } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
  };
}
const post = (body, token) => ({ httpMethod: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
const limiterCalls = (db) => db.calls.filter((c) => c.rpc === 'check_rate_limit');
const rpcCalls = (db, n) => db.calls.filter((c) => c.rpc === n);

test('agent-pair: needs a valid sign-in and a linked employee; the code is stored hashed, never in clear', async () => {
  const pair = loadFunction('agent-pair');
  const db = makeDb(); setDbForTests(db);
  assert.equal((await pair.handler(post({ action: 'create_code' }, 'bad'))).statusCode, 401);
  const stranger = makeDb(); stranger.auth.getUser = async () => ({ data: { user: { id: 'nobody' } }, error: null }); setDbForTests(stranger);
  assert.equal((await pair.handler(post({ action: 'create_code' }, 'x'))).statusCode, 403);
  setDbForTests(db);
  const r = await pair.handler(post({ action: 'create_code' }, 'good'));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const call = rpcCalls(db, 'create_agent_pairing')[0];
  assert.equal(call.args.p_person, 'p1');
  assert.equal(call.args.p_code_hash, tokens.hashCode(body.code));
  assert.ok(!JSON.stringify(db.calls).includes(body.code), 'the clear code is never sent to the database');
  assert.equal((await pair.handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});

test('agent-pair: list and revoke only touch the signed-in person; bad ids are refused', async () => {
  const pair = loadFunction('agent-pair');
  const db = makeDb({ devices: [{ id: 'd1', device_name: 'PC-1' }], rpc: { revoke_agent_device_for_person: ({ p_device }) => ({ data: p_device === '11111111-1111-1111-1111-111111111111', error: null }) } });
  setDbForTests(db);
  const list = JSON.parse((await pair.handler(post({ action: 'list' }, 'good'))).body);
  assert.deepEqual(list.devices, [{ id: 'd1', device_name: 'PC-1' }]);
  assert.equal((await pair.handler(post({ action: 'revoke', device_id: 'not-a-uuid' }, 'good'))).statusCode, 400);
  assert.equal((await pair.handler(post({ action: 'revoke', device_id: '22222222-2222-2222-2222-222222222222' }, 'good'))).statusCode, 404);
  assert.equal((await pair.handler(post({ action: 'revoke', device_id: '11111111-1111-1111-1111-111111111111' }, 'good'))).statusCode, 200);
  assert.equal(rpcCalls(db, 'revoke_agent_device_for_person')[0].args.p_person, 'p1');
});

test('agent-enroll: a good code returns a token and stores only its hash; bad or reused codes get one generic answer', async () => {
  const enroll = loadFunction('agent-enroll');
  const good = tokens.newPairingCode();
  const db = makeDb({ rpc: { enroll_agent_device: ({ p_code_hash }) => (p_code_hash === tokens.hashCode(good) ? { data: { ok: true, person_name: 'Emp A', organization: 'Acme' }, error: null } : { data: { ok: false, reason: 'invalid_code' }, error: null }) } });
  setDbForTests(db);
  const r = await enroll.handler(post({ code: good.toLowerCase(), device_name: 'WS-ICU-04', platform: 'windows', version: '0.1.0' }));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.match(body.device_token, tokens.TOKEN_RE);
  const args = rpcCalls(db, 'enroll_agent_device')[0].args;
  assert.equal(args.p_token_hash, tokens.hashToken(body.device_token));
  assert.ok(!JSON.stringify(db.calls).includes(body.device_token), 'the token itself is never sent to the database');
  assert.equal(args.p_device_name, 'WS-ICU-04');
  const wrong = await enroll.handler(post({ code: tokens.newPairingCode() }));
  assert.equal(wrong.statusCode, 400); assert.doesNotMatch(wrong.body, /device_token/);
  assert.equal((await enroll.handler(post({ code: 'nonsense' }))).statusCode, 400);
  assert.equal(rpcCalls(db, 'enroll_agent_device').length, 2, 'a malformed code never reaches the database');
  assert.equal(limiterCalls(db).length, 3);
});

test('agent-enroll: five computers is the limit and says how to fix it; the limiter blocks a flood from one address', async () => {
  const enroll = loadFunction('agent-enroll');
  setDbForTests(makeDb({ rpc: { enroll_agent_device: () => ({ data: { ok: false, reason: 'too_many_devices' }, error: null }) } }));
  const r = await enroll.handler(post({ code: tokens.newPairingCode() }));
  assert.equal(r.statusCode, 409); assert.match(JSON.parse(r.body).error, /5 computers/);
  setDbForTests(makeDb({ rpc: { check_rate_limit: () => ({ data: { ok: false, retry_after: 30 }, error: null }) } }));
  const limited = await enroll.handler(post({ code: tokens.newPairingCode() }));
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers['Retry-After'], '30');
});

test('agent-poll: unknown or malformed tokens get 401 before any database call; alerts and dismissals come back; a removed computer gets 401', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const poll = loadFunction('agent-poll');
  const t = tokens.newDeviceToken();
  const alert = { delivery_id: 'd1', event_id: 'e1', kind: 'drill', body: 'x', requires_ack: true };
  let mode = 'alerts';
  const db = makeDb({ rpc: { agent_claim: () => (mode === 'revoked' ? { data: { ok: false, reason: 'revoked' }, error: null } : { data: { ok: true, alerts: [alert], dismiss: ['d0'] }, error: null }) } });
  setDbForTests(db);
  assert.equal((await poll.handler(post({}, 'garbage'))).statusCode, 401);
  assert.equal(db.calls.length, 0);
  const r = await poll.handler(post({ version: '0.1.0' }, t));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body).alerts, [alert]); assert.deepEqual(JSON.parse(r.body).dismiss, ['d0']);
  assert.equal(rpcCalls(db, 'agent_claim')[0].args.p_token_hash, tokens.hashToken(t));
  mode = 'revoked';
  const gone = await poll.handler(post({}, t));
  assert.equal(gone.statusCode, 401); assert.equal(JSON.parse(gone.body).error, 'revoked');
  setDbForTests(makeDb({ rpc: { agent_claim: () => ({ data: null, error: { message: 'db down' } }) } }));
  assert.equal((await poll.handler(post({}, t))).statusCode, 503);
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent-poll: waits for an alert (long poll) and returns as soon as one arrives', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '5'; process.env.EMNS_AGENT_POLL_STEP_MS = '20';
  const poll = loadFunction('agent-poll');
  let n = 0;
  setDbForTests(makeDb({ rpc: { agent_claim: () => (++n < 4 ? { data: { ok: true, alerts: [], dismiss: [] }, error: null } : { data: { ok: true, alerts: [{ delivery_id: 'd9', kind: 'alert', body: 'b' }], dismiss: [] }, error: null }) } }));
  const t0 = Date.now();
  const r = await poll.handler(post({}, tokens.newDeviceToken()));
  assert.equal(JSON.parse(r.body).alerts.length, 1);
  assert.ok(n === 4 && Date.now() - t0 < 2000, `polled ${n} times in ${Date.now() - t0}ms`);
  delete process.env.EMNS_AGENT_POLL_SECONDS; delete process.env.EMNS_AGENT_POLL_STEP_MS;
});

test('agent-report: validates the action and response, passes the hashed token, maps outcomes to the right status codes', async () => {
  const report = loadFunction('agent-report');
  const t = tokens.newDeviceToken();
  const id = '33333333-3333-3333-3333-333333333333';
  let result = { ok: true };
  const db = makeDb({ rpc: { agent_report: () => ({ data: result, error: null }) } });
  setDbForTests(db);
  assert.equal((await report.handler(post({ delivery_id: id, action: 'ack', response: 'SAFE' }, 'junk'))).statusCode, 401);
  assert.equal((await report.handler(post({ delivery_id: 'nope', action: 'shown' }, t))).statusCode, 400);
  assert.equal((await report.handler(post({ delivery_id: id, action: 'explode' }, t))).statusCode, 400);
  assert.equal((await report.handler(post({ delivery_id: id, action: 'ack', response: 'MAYBE' }, t))).statusCode, 400);
  assert.equal((await report.handler(post({ delivery_id: id, action: 'ack' }, t))).statusCode, 400);
  assert.equal(rpcCalls(db, 'agent_report').length, 0, 'nothing invalid reaches the database');
  const ok = await report.handler(post({ delivery_id: id, action: 'ack', response: 'SOS' }, t));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(rpcCalls(db, 'agent_report')[0].args, { p_token_hash: tokens.hashToken(t), p_delivery: id, p_action: 'ack', p_response: 'SOS' });
  result = { ok: false, reason: 'not_found' }; assert.equal((await report.handler(post({ delivery_id: id, action: 'shown' }, t))).statusCode, 404);
  result = { ok: false, reason: 'revoked' }; assert.equal((await report.handler(post({ delivery_id: id, action: 'shown' }, t))).statusCode, 401);
  result = { ok: true, duplicate: true }; assert.equal(JSON.parse((await report.handler(post({ delivery_id: id, action: 'ack', response: 'SAFE' }, t))).body).duplicate, true);
});

// ---------- send-event with the desktop channel ----------
test('send-event: desktop is an accepted channel, its text is built server-side with no STOP footer, and unknown channels are still refused', async () => {
  const sendEvent = loadFunction('send-event');
  const rpcArgs = [];
  const db = makeDb({ rpc: { create_notification_event: (a) => { rpcArgs.push(a); return { data: { event_id: 'e1', deduplicated: false, queued: 0 }, error: null }; } } });
  db.from = (table) => {
    const b = new Proxy({}, { get(_t, k) {
      if (k === 'maybeSingle') return async () => ({ data: table === 'operators' ? { id: 'op1', organization_id: 'org1', role: 'admin', is_platform_admin: false } : table === 'organizations' ? { name: 'Acme Hospital', settings: {} } : null, error: null });
      return () => b;
    } });
    return b;
  };
  setDbForTests(db);
  const base = { kind: 'drill', body: 'Walk to the north exit.', group_ids: ['44444444-4444-4444-4444-444444444444'] };
  const r = await sendEvent.handler(post({ ...base, channels: ['desktop', 'sms'], mode: 'fallback' }, 'good'));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(rpcArgs[0].p_channels, ['desktop', 'sms']);
  assert.match(rpcArgs[0].p_desktop_text, /^\[DRILL\] Acme Hospital: Walk to the north exit\.$/);
  const bad = await sendEvent.handler(post({ ...base, channels: ['pager'] }, 'good'));
  assert.equal(bad.statusCode, 400);
  const smsOnly = await sendEvent.handler(post({ ...base, channels: ['sms'] }, 'good'));
  assert.equal(smsOnly.statusCode, 200);
  assert.equal(rpcArgs[1].p_desktop_text, null);
});

test('send-sweeper: expires desktop alerts nobody picked up, and never wakes the worker just for desktop rows', async () => {
  process.env.EMNS_WORKER_SECRET = 's'; process.env.URL = 'https://example.test';
  const sweeper = loadFunction('send-sweeper');
  const calls = [];
  const db = makeDb({ rpc: { expire_desktop_deliveries: (a) => { calls.push(a); return { data: 1, error: null }; }, escalate_unacknowledged: () => ({ data: 0, error: null }) } });
  const filters = [];
  db.from = () => { const b = new Proxy({}, { get(_t, k) { if (k === 'then') return (res) => Promise.resolve({ count: 0, error: null }).then(res); return (...a) => { filters.push([k, ...a]); return b; }; } }); return b; };
  setDbForTests(db);
  const r = await sweeper.handler({});
  assert.equal(calls.length, 1); assert.equal(calls[0].p_ttl_seconds, 120);
  assert.ok(filters.some(([k, c, v]) => k === 'neq' && c === 'channel' && v === 'desktop'), 'desktop rows are excluded from the worker wake-up check');
  assert.equal(r.body, 'idle');
  delete process.env.EMNS_WORKER_SECRET; delete process.env.URL;
});

// ---------- the agent against the real functions ----------
// A fake server that routes the agent's HTTP calls to the real function handlers and keeps simple in-memory device state.
function fakeServer() {
  const state = { codes: new Map(), devices: new Map(), alerts: [], reports: [], revoked: false, down: false };
  const rpc = {
    enroll_agent_device: ({ p_code_hash, p_token_hash }) => {
      if (!state.codes.has(p_code_hash)) return { data: { ok: false, reason: 'invalid_code' }, error: null };
      state.codes.delete(p_code_hash); state.devices.set(p_token_hash, true);
      return { data: { ok: true, person_name: 'Emp A', organization: 'Acme Hospital' }, error: null };
    },
    agent_claim: ({ p_token_hash }) => {
      if (state.revoked || !state.devices.has(p_token_hash)) return { data: { ok: false, reason: 'revoked' }, error: null };
      const alerts = state.alerts.splice(0); return { data: { ok: true, alerts, dismiss: [] }, error: null };
    },
    agent_report: ({ p_token_hash, p_delivery, p_action, p_response }) => {
      if (state.revoked || !state.devices.has(p_token_hash)) return { data: { ok: false, reason: 'revoked' }, error: null };
      state.reports.push({ id: p_delivery, action: p_action, response: p_response }); return { data: { ok: true }, error: null };
    },
  };
  setDbForTests(makeDb({ rpc }));
  const fetchImpl = async (url, opts) => {
    await new Promise((r) => setImmediate(r)); // a real network round trip always lets timers run
    if (state.down) throw new Error('ECONNREFUSED');
    const name = new URL(url).pathname.split('/').pop();
    const fn = loadFunction(name);
    const out = await fn.handler({ httpMethod: opts.method, headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])), body: opts.body });
    return { ok: out.statusCode < 400, status: out.statusCode, json: async () => JSON.parse(out.body || '{}') };
  };
  return { state, fetchImpl };
}
const tmpStore = () => createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emns-agent-')), 'state.json') });
const tick = () => new Promise((r) => setImmediate(r)); // a sleep that returns at once but still lets the event loop breathe
const newAgent = (srv, store = tmpStore(), extra = {}) => new Agent({ store, fetchImpl: srv.fetchImpl, sleep: tick, minPollMs: 0, random: () => 0.5, log: (...m) => { if (process.env.DEBUG_AGENT) console.error(...m); }, ...extra });
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const ALERT = { delivery_id: '55555555-5555-5555-5555-555555555555', event_id: 'e1', kind: 'alert', body: 'Active SOS eMNS alert from Acme Hospital: shelter in place', requires_ack: true, organization: 'Acme Hospital', created_at: new Date().toISOString() };

test('agent end to end: pair with a code, receive an alert, report shown, answer "I need help", and the token is stored only on disk', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const srv = fakeServer();
  const code = tokens.newPairingCode(); srv.state.codes.set(tokens.hashCode(code), true);
  const store = tmpStore();
  const agent = newAgent(srv, store);
  const seen = [];
  agent.on('alert', (a) => seen.push(a));
  assert.equal(agent.paired, false);
  await assert.rejects(agent.enroll({ serverUrl: 'http://example.org', code, deviceName: 'PC' }), /https/);
  await assert.rejects(agent.enroll({ serverUrl: 'https://emns.test', code: 'ZZZZ-ZZZZ', deviceName: 'PC' }), /not valid|expired/);
  const person = await agent.enroll({ serverUrl: 'https://emns.test/some/path?x=1', code, deviceName: 'WS-ICU-04' });
  assert.deepEqual(person, { name: 'Emp A', organization: 'Acme Hospital' });
  assert.equal(agent.serverUrl, 'https://emns.test');
  assert.ok(agent.paired);
  srv.state.alerts.push(ALERT);
  agent.start();
  await until(() => seen.length === 1);
  assert.equal(seen[0].delivery_id, ALERT.delivery_id);
  assert.ok(store.read().alerts[ALERT.delivery_id], 'the alert is on disk before anyone sees it');
  await agent.shown(ALERT.delivery_id);
  await agent.shown(ALERT.delivery_id);
  assert.deepEqual(srv.state.reports.map((r) => r.action), ['shown'], 'shown is reported once');
  const res = await agent.ack(ALERT.delivery_id, 'SOS');
  assert.equal(res.sent, true);
  assert.deepEqual(srv.state.reports.at(-1), { id: ALERT.delivery_id, action: 'ack', response: 'SOS' });
  assert.equal(agent.activeAlerts.length, 0);
  await assert.rejects(agent.ack(ALERT.delivery_id, 'MAYBE'));
  await agent.stop();
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent: an answer given while offline is kept on disk, reported as not sent, and delivered when the connection returns', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const srv = fakeServer();
  const code = tokens.newPairingCode(); srv.state.codes.set(tokens.hashCode(code), true);
  const store = tmpStore();
  const agent = newAgent(srv, store);
  await agent.enroll({ serverUrl: 'https://emns.test', code, deviceName: 'PC' });
  srv.state.alerts.push(ALERT);
  agent.start();
  await until(() => agent.activeAlerts.length === 1);
  srv.state.down = true;
  const res = await agent.ack(ALERT.delivery_id, 'SOS');
  assert.equal(res.sent, false, 'the screen is told the answer has not reached the server');
  assert.equal(store.read().pending.length, 1);
  assert.equal(srv.state.reports.length, 0);
  srv.state.down = false;
  await until(() => srv.state.reports.some((r) => r.action === 'ack'));
  assert.deepEqual(srv.state.reports.find((r) => r.action === 'ack'), { id: ALERT.delivery_id, action: 'ack', response: 'SOS' });
  await until(() => store.read().pending.length === 0);
  await agent.stop();
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent: an alert handed over before a crash is shown again after a restart, and old ones are dropped', async () => {
  const srv = fakeServer();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emns-agent-')), 'state.json');
  const first = createStore({ file });
  first.update((s) => {
    s.token = tokens.newDeviceToken(); s.serverUrl = 'https://emns.test';
    s.alerts.fresh = { ...ALERT, delivery_id: 'fresh', received_at: Date.now() - 60 * 1000 };
    s.alerts.stale = { ...ALERT, delivery_id: 'stale', received_at: Date.now() - 7 * 3600 * 1000 };
  });
  const agent = newAgent(srv, createStore({ file }));
  const seen = []; agent.on('alert', (a) => seen.push(a.delivery_id));
  agent.resume();
  assert.deepEqual(seen, ['fresh']);
});

test('agent: when the server says the computer was removed, the token and pending work are forgotten and the app asks to be paired again', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const srv = fakeServer();
  const code = tokens.newPairingCode(); srv.state.codes.set(tokens.hashCode(code), true);
  const store = tmpStore();
  const agent = newAgent(srv, store);
  await agent.enroll({ serverUrl: 'https://emns.test', code, deviceName: 'PC' });
  let revoked = 0; agent.on('revoked', () => revoked++);
  srv.state.revoked = true;
  agent.start();
  await until(() => revoked === 1);
  assert.equal(agent.paired, false);
  assert.equal(store.read().token, null);
  assert.equal(agent.state, 'unpaired');
  await agent.stop();
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent: a failed connection backs off and goes offline, then recovers by itself', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const srv = fakeServer();
  const code = tokens.newPairingCode(); srv.state.codes.set(tokens.hashCode(code), true);
  const waits = [];
  const agent = newAgent(srv, tmpStore(), { sleep: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 2)); } });
  await agent.enroll({ serverUrl: 'https://emns.test', code, deviceName: 'PC' });
  const states = []; agent.on('state', (s) => states.push(s));
  srv.state.down = true;
  agent.start();
  await until(() => states.includes('offline'));
  await until(() => waits.length >= 3);
  assert.ok(waits[1] >= waits[0] && waits[2] >= waits[1], `backoff grows: ${waits.slice(0, 3)}`);
  assert.ok(waits.every((w) => w <= 30000 * 1.2));
  srv.state.down = false;
  await until(() => states.at(-1) === 'online');
  await agent.stop();
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent: malformed alerts from the server are ignored, and the same alert is never shown twice', async () => {
  process.env.EMNS_AGENT_POLL_SECONDS = '0';
  const srv = fakeServer();
  const code = tokens.newPairingCode(); srv.state.codes.set(tokens.hashCode(code), true);
  const agent = newAgent(srv);
  await agent.enroll({ serverUrl: 'https://emns.test', code, deviceName: 'PC' });
  const seen = []; agent.on('alert', (a) => seen.push(a));
  srv.state.alerts.push({ delivery_id: 'x', kind: 'weird', body: 'b' }, { kind: 'alert', body: 'no id' }, { ...ALERT, body: 'y'.repeat(5000) }, ALERT);
  agent.start();
  await until(() => seen.length >= 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 1, 'only the first valid copy is shown');
  assert.equal(seen[0].body.length, 2000, 'long text is cut, not rejected');
  await agent.stop();
  delete process.env.EMNS_AGENT_POLL_SECONDS;
});

test('agent protocol: only https (or localhost while testing) with no embedded password; the origin alone is kept; a 401 with a token means removed', async () => {
  assert.equal(normalizeServerUrl('https://emns.example.org/x/y?z=1'), 'https://emns.example.org');
  assert.equal(normalizeServerUrl('http://localhost:8080/'), 'http://localhost:8080');
  for (const bad of ['http://emns.example.org', 'ftp://x', 'https://user:pw@emns.example.org', 'not a url', '', null]) assert.equal(normalizeServerUrl(bad), null, String(bad));
  assert.throws(() => createClient({ serverUrl: 'http://emns.example.org' }));
  const c = createClient({ serverUrl: 'https://emns.test', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'revoked' }) }) });
  await assert.rejects(c.poll('tok', {}), RevokedError);
  const c2 = createClient({ serverUrl: 'https://emns.test', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'That code is not valid or has expired.' }) }) });
  await assert.rejects(c2.enroll({ code: 'x' }), /not valid/);
  const c3 = createClient({ serverUrl: 'https://emns.test', fetchImpl: async () => { throw new Error('down'); } });
  await assert.rejects(c3.poll('tok', {}), (e) => e.code === 'network');
});

test('agent store: the token is encrypted on disk, a state file that cannot be decrypted means "not paired", and a corrupt file starts fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emns-store-'));
  const file = path.join(dir, 's.json');
  const enc = (s) => `enc:${Buffer.from(s).toString('base64')}`, dec = (s) => { if (!s.startsWith('enc:')) throw new Error('bad'); return Buffer.from(s.slice(4), 'base64').toString(); };
  const a = createStore({ file, encrypt: enc, decrypt: dec });
  a.update((s) => { s.token = 'secret-token'; s.serverUrl = 'https://emns.test'; });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret-token/);
  assert.equal(createStore({ file, encrypt: enc, decrypt: dec }).read().token, 'secret-token');
  assert.equal(createStore({ file, encrypt: enc, decrypt: () => { throw new Error('other user'); } }).read().token, null);
  fs.writeFileSync(file, '{ not json');
  const fresh = createStore({ file, encrypt: enc, decrypt: dec }).read();
  assert.equal(fresh.token, null); assert.deepEqual(fresh.pending, []);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('the agent app ships no network or file access to its screens: strict content policy, no inline script, context isolation on', () => {
  const root = path.join(__dirname, '..', 'agent', 'src');
  for (const f of ['alert.html', 'enroll.html']) {
    const html = fs.readFileSync(path.join(root, 'ui', f), 'utf8');
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /<script>(?!<)/, 'no inline script');
    assert.doesNotMatch(html.replace(/placeholder="[^"]*"/g, ''), /https?:\/\//, 'no remote content');
  }
  const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
  assert.match(main, /contextIsolation: true/); assert.match(main, /nodeIntegration: false/); assert.match(main, /sandbox: true/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'ui', 'alert.js'), 'utf8'), /innerHTML|insertAdjacentHTML|eval\(/, 'alert text is only ever inserted as text');
});
