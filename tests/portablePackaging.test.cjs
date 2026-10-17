const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs'), path = require('path');
const { makeEnv } = require('../scripts/gen-env.cjs');
const { bootstrapSql } = require('../scripts/db-local.cjs');

test('generated keys are valid HS256 tokens for the generated secret, with the right roles', () => {
  const env = makeEnv();
  const check = (token, role) => {
    const [h, b, s] = token.split('.');
    assert.equal(crypto.createHmac('sha256', env.JWT_SECRET).update(`${h}.${b}`).digest('base64url'), s);
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    assert.equal(claims.role, role); assert.ok(claims.exp > Date.now() / 1000);
  };
  check(env.ANON_KEY, 'anon'); check(env.SERVICE_ROLE_KEY, 'service_role');
  assert.notEqual(makeEnv().JWT_SECRET, env.JWT_SECRET, 'fresh secrets each time');
  assert.ok(env.SEED_ADMIN_PASSWORD.length >= 12);
});

test('bootstrap SQL fills in passwords and refuses weak or injectable ones', () => {
  const sql = bootstrapSql({ AUTHENTICATOR_PASSWORD: 'a'.repeat(24), AUTH_ADMIN_PASSWORD: 'b'.repeat(24) });
  assert.doesNotMatch(sql, /{{/); assert.match(sql, /password 'aaaa/);
  assert.throws(() => bootstrapSql({ AUTHENTICATOR_PASSWORD: "x'; drop table people; --xxxxxxxx", AUTH_ADMIN_PASSWORD: 'b'.repeat(24) }));
  assert.throws(() => bootstrapSql({ AUTHENTICATOR_PASSWORD: 'short', AUTH_ADMIN_PASSWORD: 'b'.repeat(24) }));
  assert.throws(() => bootstrapSql({ AUTH_ADMIN_PASSWORD: 'b'.repeat(24) }));
});

test('no hosted-vendor calls outside the provider layer', () => {
  const offenders = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return walk(f);
    if (!/\.(js|cjs)$/.test(e.name)) return;
    const src = fs.readFileSync(f, 'utf8');
    const inProviderLayer = /src[\\/]server[\\/](providers|auth)[\\/]/.test(f);
    if (!inProviderLayer && /@supabase\/supabase-js|\.auth\.(admin|getUser)|createClient\(/.test(src)) offenders.push(f);
    if (!inProviderLayer && /api\.twilio\.com|api\.resend\.com/.test(src)) offenders.push(f);
  });
  walk(path.resolve(__dirname, '../netlify/functions')); walk(path.resolve(__dirname, '../src/server')); walk(path.resolve(__dirname, '../server'));
  assert.deepEqual(offenders, []);
});

test('packaging files exist and the compose file wires the services together', () => {
  const root = path.resolve(__dirname, '..');
  for (const f of ['Dockerfile', 'Dockerfile.gateway', 'docker-compose.yml', 'docker/bootstrap.sql', 'docker/gateway.conf.template', 'docs/sbom.cdx.json']) assert.ok(fs.existsSync(path.join(root, f)), f);
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  for (const s of ['db:', 'bootstrap:', 'auth:', 'rest:', 'migrate:', 'gateway:', 'app:', 'worker:', 'seed:']) assert.ok(compose.includes(`\n  ${s}`), s);
  assert.match(compose, /EMNS_MESSAGE_PROVIDER: mock/); assert.match(compose, /EMNS_ALLOW_REAL_SEND: "false"/);
  assert.doesNotMatch(compose, /eyJ[A-Za-z0-9_-]{20,}/, 'no keys committed');
});
