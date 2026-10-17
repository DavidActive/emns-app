-- P14: audit and hardening. Additive. Review before applying. Apply AFTER 20261016001500_self_service.sql.
-- 1. audit_log becomes truly append-only (no update, no delete, no truncate, even for the service role).
-- 2. Staff changes (added, role changed, removed), organization setting changes, and deletions of people and groups are logged automatically by triggers,
--    so they are recorded no matter which screen or function made the change.
-- 3. Exports are logged through log_export(), called before a file is handed to the user.
-- 4. A small database-backed rate limiter for the write endpoints (check_rate_limit), used by the Netlify functions.

-- 1. Append-only
revoke update, delete, truncate on public.audit_log from anon, authenticated, service_role;
create or replace function public.audit_log_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    -- the only change ever allowed: the foreign key clearing "actor" when that staff member is removed
    if new.actor is null and (to_jsonb(new) - 'actor') = (to_jsonb(old) - 'actor') then return new; end if;
    raise exception 'audit_log is append-only';
  elsif tg_op = 'DELETE' then
    -- removing a whole organization is a deliberate procedure: SET LOCAL emns.allow_audit_purge = 'on' in that transaction
    if current_setting('emns.allow_audit_purge', true) = 'on' then return old; end if;
    raise exception 'audit_log is append-only';
  end if;
  raise exception 'audit_log is append-only';
end $$;
revoke all on function public.audit_log_guard() from public, anon, authenticated;
drop trigger if exists audit_log_no_change on public.audit_log;
create trigger audit_log_no_change before update or delete on public.audit_log for each row execute function public.audit_log_guard();
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function public.audit_log_guard();

-- 2. Automatic audit of staff, organization, people-deletion and group-deletion changes
create or replace function private.audit_actor() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.operators where user_id = auth.uid() limit 1
$$;
revoke all on function private.audit_actor() from public, anon;
grant execute on function private.audit_actor() to authenticated, service_role;

create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := private.audit_actor();
begin
  if tg_table_name = 'operators' then
    if tg_op = 'INSERT' then
      insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
      values (new.organization_id, v_actor, 'staff.added', 'operator', new.id::text, jsonb_build_object('role', new.role, 'platform_admin', new.is_platform_admin));
    elsif tg_op = 'UPDATE' and (new.role is distinct from old.role or new.is_platform_admin is distinct from old.is_platform_admin or new.organization_id is distinct from old.organization_id) then
      insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
      values (coalesce(new.organization_id, old.organization_id), v_actor, 'staff.role_changed', 'operator', new.id::text,
              jsonb_build_object('role_from', old.role, 'role_to', new.role, 'platform_admin_from', old.is_platform_admin, 'platform_admin_to', new.is_platform_admin,
                                 'org_changed', new.organization_id is distinct from old.organization_id));
    elsif tg_op = 'DELETE' then
      insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
      values (old.organization_id, v_actor, 'staff.removed', 'operator', old.id::text, jsonb_build_object('role', old.role));
    end if;
  elsif tg_table_name = 'organizations' then
    if new.settings is distinct from old.settings or new.name is distinct from old.name or new.twilio_number is distinct from old.twilio_number then
      insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
      values (new.id, v_actor, 'org.settings_changed', 'organization', new.id::text,
              jsonb_build_object('name_changed', new.name is distinct from old.name, 'number_changed', new.twilio_number is distinct from old.twilio_number,
                                 'settings_changed', new.settings is distinct from old.settings));
    end if;
  elsif tg_table_name = 'people' then
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (old.organization_id, v_actor, 'person.deleted', 'person', old.id::text, jsonb_build_object('mobile_last4', right(old.mobile_phone, 4)));
  elsif tg_table_name = 'groups' then
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (old.organization_id, v_actor, 'group.deleted', 'group', old.id::text, jsonb_build_object('name', old.name));
  end if;
  return null;
end $$;
revoke all on function public.audit_row_change() from public, anon, authenticated;
drop trigger if exists audit_operators on public.operators;
create trigger audit_operators after insert or update or delete on public.operators for each row execute function public.audit_row_change();
drop trigger if exists audit_organizations on public.organizations;
create trigger audit_organizations after update on public.organizations for each row execute function public.audit_row_change();
drop trigger if exists audit_people_delete on public.people;
create trigger audit_people_delete after delete on public.people for each row execute function public.audit_row_change();
drop trigger if exists audit_groups_delete on public.groups;
create trigger audit_groups_delete after delete on public.groups for each row execute function public.audit_row_change();

-- 3. Exports
create or replace function public.log_export(p_kind text, p_rows int default null, p_ref text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid := private.current_org_id();
begin
  if v_org is null then raise exception 'not allowed'; end if;
  if p_kind not in ('after_action_csv', 'enrollment_links_csv') then raise exception 'unknown export'; end if;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (v_org, private.audit_actor(), 'export.' || p_kind, 'export', left(p_ref, 100), jsonb_build_object('rows', p_rows));
end $$;
revoke all on function public.log_export(text,int,text) from public, anon;
grant execute on function public.log_export(text,int,text) to authenticated;

-- 4. Rate limiter (fixed window). Infrastructure table keyed by caller, not by organization; no client access.
create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;   -- no policies: service role only
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_start timestamptz; v_hits int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits (key, window_start, hits) values (left(p_key, 200), v_start, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then delete from public.rate_limits where window_start < now() - interval '1 day'; end if;
  if v_hits > p_limit then
    return jsonb_build_object('ok', false, 'retry_after', greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::int));
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.check_rate_limit(text,int,int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text,int,int) to service_role;
