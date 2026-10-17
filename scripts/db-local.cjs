#!/usr/bin/env node
// Database tooling for the container profile and any plain PostgreSQL server.
//   node scripts/db-local.cjs bootstrap   roles, auth schema, default privileges (docker/bootstrap.sql)
//   node scripts/db-local.cjs migrate     waits for the sign-in service to create auth.users, then applies supabase/migrations in order, once each
//   node scripts/db-local.cjs seed        creates a demo organization and an admin account (idempotent)
// Environment: DATABASE_URL (superuser connection) or the standard PG* variables, AUTHENTICATOR_PASSWORD, AUTH_ADMIN_PASSWORD; seed also SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations');

async function connect(env = process.env) {
  const { Client } = require('pg');
  for (let i = 0; i < 60; i++) {
    const c = new Client(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}); // otherwise the standard PGHOST / PGUSER / PGPASSWORD / PGDATABASE settings
    try { await c.connect(); return c; } catch (e) { await c.end().catch(() => {}); await sleep(2000); }
  }
  throw new Error('database not reachable');
}

function bootstrapSql(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`${k} is required`); return env[k]; };
  const safe = (v) => { if (!/^[A-Za-z0-9_-]{16,}$/.test(v)) throw new Error('passwords must be 16+ letters, digits, - or _'); return v; };
  return fs.readFileSync(path.resolve(__dirname, '../docker/bootstrap.sql'), 'utf8')
    .replace(/{{AUTHENTICATOR_PASSWORD}}/g, safe(need('AUTHENTICATOR_PASSWORD'))).replace(/{{AUTH_ADMIN_PASSWORD}}/g, safe(need('AUTH_ADMIN_PASSWORD')));
}

async function bootstrap() { const c = await connect(); try { await c.query(bootstrapSql()); console.log('bootstrap done'); } finally { await c.end(); } }

async function migrate() {
  const c = await connect();
  try {
    for (let i = 0; i < 90; i++) { // the sign-in service creates auth.users the first time it starts
      const r = await c.query("select to_regclass('auth.users') as t");
      if (r.rows[0].t) break;
      if (i === 89) throw new Error('auth.users never appeared; is the auth service running?');
      await sleep(2000);
    }
    await c.query('create table if not exists public.local_migrations (name text primary key, applied_at timestamptz not null default now())');
    await c.query('alter table public.local_migrations enable row level security'); // no policies: not reachable from the API
    const done = new Set((await c.query('select name from public.local_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      process.stdout.write(`applying ${f} ... `);
      await c.query('begin');
      try { await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')); await c.query('insert into public.local_migrations (name) values ($1)', [f]); await c.query('commit'); console.log('ok'); }
      catch (e) { await c.query('rollback'); console.log('FAILED'); throw e; }
    }
    await c.query("notify pgrst, 'reload schema'");
    console.log('migrations up to date');
  } finally { await c.end(); }
}

async function seed(env = process.env) {
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = env.SEED_ADMIN_EMAIL || 'admin@emns.local';
  const password = env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('SEED_ADMIN_PASSWORD (12+ characters) is required');
  let { data: org } = await db.from('organizations').select('id').eq('slug', 'demo').maybeSingle();
  if (!org) { const r = await db.from('organizations').insert({ name: 'Demo Hospital', slug: 'demo' }).select('id').single(); if (r.error) throw r.error; org = r.data; }
  const existing = await db.from('operators').select('id').eq('organization_id', org.id).eq('role', 'admin').maybeSingle();
  if (existing.data) { console.log('seed already done'); return; }
  const u = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (u.error) throw u.error;
  const op = await db.from('operators').insert({ user_id: u.data.user.id, organization_id: org.id, full_name: 'Demo Admin', role: 'admin' });
  if (op.error) throw op.error;
  console.log(`seed done: sign in as ${email}`);
}

module.exports = { bootstrapSql };
if (require.main === module) {
  const cmd = process.argv[2];
  ({ bootstrap, migrate, seed }[cmd] || (() => { throw new Error('usage: db-local.cjs bootstrap|migrate|seed'); }))()
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
