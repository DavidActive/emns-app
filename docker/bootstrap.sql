-- Prepares a plain PostgreSQL server (local container, RDS, Aurora) to run the eMNS migrations and the open-source PostgREST and GoTrue services.
-- It recreates what a Supabase project provides: the API roles, the auth schema with auth.uid(), default privileges, and an empty realtime publication.
-- Safe to run repeatedly. Placeholders {{AUTHENTICATOR_PASSWORD}} and {{AUTH_ADMIN_PASSWORD}} are filled in by scripts/db-local.cjs.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login password '{{AUTHENTICATOR_PASSWORD}}'; end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin noinherit createrole login password '{{AUTH_ADMIN_PASSWORD}}'; end if;
end $$;
alter role authenticator with password '{{AUTHENTICATOR_PASSWORD}}';
alter role supabase_auth_admin with password '{{AUTH_ADMIN_PASSWORD}}';
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth, public;
grant create on database postgres to supabase_auth_admin;

-- The claims PostgREST sets for each request
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

do $$ begin
  if not exists (select from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
