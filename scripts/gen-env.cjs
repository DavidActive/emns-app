#!/usr/bin/env node
// Writes .env.docker with fresh random secrets and matching API keys for the container profile. Never overwrites an existing file.
//   node scripts/gen-env.cjs [--public-url http://localhost:8080]
const crypto = require('crypto');
const fs = require('fs');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
function jwt(secret, role) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role, iss: 'emns-local', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
function makeEnv(publicUrl = 'http://localhost:8080') {
  const jwtSecret = rand(48);
  return {
    POSTGRES_PASSWORD: rand(24), AUTHENTICATOR_PASSWORD: rand(24), AUTH_ADMIN_PASSWORD: rand(24),
    JWT_SECRET: jwtSecret, ANON_KEY: jwt(jwtSecret, 'anon'), SERVICE_ROLE_KEY: jwt(jwtSecret, 'service_role'),
    EMNS_WORKER_SECRET: rand(32), SEED_ADMIN_EMAIL: 'admin@emns.local', SEED_ADMIN_PASSWORD: rand(18), EMNS_PUBLIC_URL: publicUrl,
  };
}
module.exports = { makeEnv, jwt };
if (require.main === module) {
  const i = process.argv.indexOf('--public-url');
  if (fs.existsSync('.env.docker')) { console.error('.env.docker already exists; delete it first to regenerate.'); process.exit(1); }
  const env = makeEnv(i > 0 ? process.argv[i + 1] : undefined);
  fs.writeFileSync('.env.docker', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`.env.docker written. Sign in at ${env.EMNS_PUBLIC_URL} as ${env.SEED_ADMIN_EMAIL} with the SEED_ADMIN_PASSWORD from that file.`);
}
