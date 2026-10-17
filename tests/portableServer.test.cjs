const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createServer } = require('../server/main.cjs');
const { publicBaseUrl, internalBaseUrl, functionUrl, isProduction, clientIp } = require('../src/server/runtime.cjs');

function start(handlers, env = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'emns-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>APP</html>');
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  const srv = createServer({ distDir: dist, env, log: { error() {} }, loadHandler: (n) => { if (!handlers[n]) throw new Error('none'); return handlers[n]; } });
  return new Promise((r) => srv.listen(0, () => r({ srv, port: srv.address().port })));
}
const call = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('functions answer on the Netlify paths with the same event shape; the app and unknown paths serve the single-page app', async () => {
  let seen;
  const { srv, port } = await start({ echo: async (e) => { seen = e; return { statusCode: 201, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' }, body: JSON.stringify({ ok: true }) }; } });
  try {
    const r = await call(port, 'POST', '/.netlify/functions/echo/abc?x=1', '{"a":1}', { Authorization: 'Bearer t', 'Content-Type': 'application/json' });
    assert.equal(r.status, 201); assert.equal(r.headers['retry-after'], '5'); assert.deepEqual(JSON.parse(r.body), { ok: true });
    assert.equal(seen.httpMethod, 'POST'); assert.equal(seen.body, '{"a":1}'); assert.equal(seen.headers.authorization, 'Bearer t');
    assert.equal(seen.path, '/.netlify/functions/echo/abc'); assert.deepEqual(seen.queryStringParameters, { x: '1' });
    assert.equal((await call(port, 'GET', '/.netlify/functions/missing')).status, 404);
    assert.equal((await call(port, 'GET', '/.netlify/functions/..%2f..%2fetc')).status, 404);
    assert.match((await call(port, 'GET', '/people/123')).body, /APP/);
    assert.equal((await call(port, 'GET', '/assets/a.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await call(port, 'GET', '/healthz')).body, 'ok');
    assert.equal((await call(port, 'DELETE', '/anything')).status, 405);
    assert.equal((await call(port, 'GET', '/..%2f..%2fetc%2fpasswd')).status, 403);
  } finally { srv.close(); }
});

test('a handler that throws gives a clean 500; an oversized body is refused', async () => {
  const { srv, port } = await start({ boom: async () => { throw new Error('secret detail'); }, big: async () => ({ statusCode: 200, body: 'x' }) });
  try {
    const r = await call(port, 'POST', '/.netlify/functions/boom', '{}');
    assert.equal(r.status, 500); assert.doesNotMatch(r.body, /secret detail/);
    const huge = await call(port, 'POST', '/.netlify/functions/big', 'x'.repeat(3 * 1024 * 1024)).catch((e) => ({ status: 0, err: e }));
    assert.ok(huge.status === 413 || huge.status === 0);
  } finally { srv.close(); }
});

test('background functions return 202 at once and keep running; an unauthorized call is refused', async () => {
  let done = false;
  const { srv, port } = await start({
    'send-worker-background': async (e) => { if (e.headers['x-emns-worker-secret'] !== 's') return { statusCode: 401, body: 'Unauthorized' }; await new Promise((r) => setTimeout(r, 300)); done = true; return { statusCode: 200 }; },
  });
  try {
    assert.equal((await call(port, 'POST', '/.netlify/functions/send-worker-background', '', {})).status, 401);
    const t = Date.now();
    const r = await call(port, 'POST', '/.netlify/functions/send-worker-background', '', { 'x-emns-worker-secret': 's' });
    assert.equal(r.status, 202); assert.ok(Date.now() - t < 250, 'did not wait for the worker');
    assert.equal(done, false);
    await new Promise((r2) => setTimeout(r2, 400)); assert.equal(done, true);
  } finally { srv.close(); }
});

test('/config.js carries the browser settings from the environment', async () => {
  const { srv, port } = await start({}, { EMNS_PUBLIC_SUPABASE_URL: 'http://localhost:8000', EMNS_PUBLIC_SUPABASE_KEY: 'anon-key' });
  try {
    const r = await call(port, 'GET', '/config.js');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.body, /"supabaseUrl":"http:\/\/localhost:8000"/); assert.match(r.body, /"supabaseKey":"anon-key"/);
    assert.doesNotMatch(r.body, /service_role|SERVICE/i);
  } finally { srv.close(); }
});

test('runtime helpers: addresses, production switch, client address', () => {
  assert.equal(publicBaseUrl({ headers: { host: 'h.test' } }, {}), 'https://h.test');
  assert.equal(publicBaseUrl({}, { URL: 'https://n.test/' }), 'https://n.test');
  assert.equal(publicBaseUrl({}, { URL: 'https://n.test', EMNS_BASE_URL: 'https://emns.activesos.com' }), 'https://emns.activesos.com');
  assert.equal(internalBaseUrl({}, { EMNS_INTERNAL_URL: 'http://app:8080', EMNS_BASE_URL: 'https://x' }), 'http://app:8080');
  assert.equal(functionUrl('https://a.test/', 'sms-status'), 'https://a.test/.netlify/functions/sms-status');
  assert.equal(isProduction({ EMNS_ENV: 'production' }), true); assert.equal(isProduction({ CONTEXT: 'production' }), true); assert.equal(isProduction({}), false);
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
});

test('the real functions load through the container server (CommonJS) and refuse what they should', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'emns-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), 'APP');
  const srv = createServer({ distDir: dist, env: {}, log: { error() {} } });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const saved = process.env.TWILIO_AUTH_TOKEN; process.env.TWILIO_AUTH_TOKEN = 't';
    assert.equal((await call(port, 'GET', '/.netlify/functions/enroll?token=short')).status, 200);
    assert.equal((await call(port, 'POST', '/.netlify/functions/sms-webhook', 'Body=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 403, 'unsigned Twilio request refused');
    assert.equal((await call(port, 'POST', '/.netlify/functions/send-worker-background')).status, 401, 'worker needs its secret');
    if (saved === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = saved;
  } finally { srv.close(); }
});
