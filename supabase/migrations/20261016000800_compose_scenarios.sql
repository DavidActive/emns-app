-- P6: scenarios library, compose-screen audience preview, and the recent-events list.
-- Run in the Supabase SQL Editor after 0700, then run supabase/tests/compose.sql to verify.

-- 1. Scenarios: admins and senders manage them (one policy per command so reads stay a single policy).
grant insert, update, delete on public.notification_scenarios to authenticated;
drop policy if exists scenarios_insert on public.notification_scenarios;
drop policy if exists scenarios_update on public.notification_scenarios;
drop policy if exists scenarios_delete on public.notification_scenarios;
create policy scenarios_insert on public.notification_scenarios for insert to authenticated
  with check ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin());
create policy scenarios_update on public.notification_scenarios for update to authenticated
  using ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin())
  with check ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin());
create policy scenarios_delete on public.notification_scenarios for delete to authenticated
  using ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin());

-- Scenario text lives in bodies->>'sms'. Keep names and text within sane limits.
alter table public.notification_scenarios drop constraint if exists notification_scenarios_name_len;
alter table public.notification_scenarios add constraint notification_scenarios_name_len check (char_length(name) between 1 and 120);

-- 2. Audience preview for the compose screen. SECURITY INVOKER: row-level security limits it to the caller's organization.
create or replace function public.preview_event_audience(p_group_ids uuid[])
returns jsonb language sql stable security invoker set search_path = public, private, pg_temp as $$
  with m as (
    select p.is_active, p.sms_opted_out, p.consent_status
    from public.people p
    where p.organization_id = private.current_org_id() and p.is_active
      and exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  where gm.person_id = p.id and gm.group_id = any(coalesce(p_group_ids, '{}')) and g.organization_id = p.organization_id))
  select jsonb_build_object(
    'total', count(*),
    'will_receive', count(*) filter (where not sms_opted_out and consent_status = 'consented'),
    'opted_out', count(*) filter (where sms_opted_out),
    'no_consent', count(*) filter (where not sms_opted_out and consent_status <> 'consented'))
  from m;
$$;
revoke all on function public.preview_event_audience(uuid[]) from public, anon;
grant execute on function public.preview_event_audience(uuid[]) to authenticated;

-- 3. Recent events with delivery counts, for the Events page. SECURITY INVOKER (RLS applies).
create or replace function public.list_recent_events(p_limit int default 25)
returns table (id uuid, kind text, status text, body text, created_at timestamptz, sent_at timestamptz,
               recipient_count int, queued bigint, sending bigint, sent bigint, delivered bigint,
               undelivered bigint, failed bigint, skipped bigint, created_by_name text)
language sql stable security invoker set search_path = public, private, pg_temp as $$
  select e.id, e.kind, e.status, e.body, e.created_at, e.sent_at, e.recipient_count,
         count(d.*) filter (where d.status = 'queued'), count(d.*) filter (where d.status = 'sending'),
         count(d.*) filter (where d.status = 'sent'), count(d.*) filter (where d.status = 'delivered'),
         count(d.*) filter (where d.status = 'undelivered'), count(d.*) filter (where d.status = 'failed'),
         count(d.*) filter (where d.status = 'skipped'), o.full_name
  from public.notification_events e
  left join public.notification_deliveries d on d.event_id = e.id
  left join public.operators o on o.id = e.created_by
  where e.organization_id = private.current_org_id()
  group by e.id, o.full_name
  order by e.created_at desc
  limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.list_recent_events(int) from public, anon;
grant execute on function public.list_recent_events(int) to authenticated;
