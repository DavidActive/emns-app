-- P11: fallback sequencing. Additive. Review before applying. Apply AFTER 20261016001300_voice_channel.sql.
-- * An event in "in this order" mode can wait for an acknowledgement: fallback_after_seconds (0 = move on only when a channel fails, as before).
--   When a channel reached the person but they have not acknowledged within that time, the next held channel is released.
-- * A failed channel still releases the next one right away.
-- * Once a person acknowledges, their remaining held channels are cancelled (skipped, reason "acknowledged").
-- * event_timeline records every step for every person: queued, held, released, sent, delivered, failed, skipped, acknowledged.

-- 1. Setting
alter table public.notification_events add column if not exists fallback_after_seconds int not null default 0;
alter table public.notification_events drop constraint if exists notification_events_fallback_after_check;
alter table public.notification_events add constraint notification_events_fallback_after_check
  check (fallback_after_seconds between 0 and 86400);

-- 2. Timeline
create table if not exists public.event_timeline (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.notification_events(id) on delete cascade,
  person_id uuid references public.people(id) on delete cascade,
  channel text,
  kind text not null,
  detail text,
  at timestamptz not null default now()
);
create index if not exists event_timeline_event_idx on public.event_timeline (event_id, at, id);
alter table public.event_timeline enable row level security;
drop policy if exists event_timeline_read on public.event_timeline;
create policy event_timeline_read on public.event_timeline for select to authenticated
  using (organization_id = private.current_org_id() or private.is_platform_admin());
grant select on public.event_timeline to authenticated;
grant all on public.event_timeline to service_role;

create or replace function public.log_delivery_step() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.event_timeline (organization_id, event_id, person_id, channel, kind, detail)
    values (new.organization_id, new.event_id, new.person_id, new.channel, new.status, new.error_code);
  end if;
  return new;
end $$;
revoke all on function public.log_delivery_step() from public, anon, authenticated;
drop trigger if exists delivery_timeline on public.notification_deliveries;
create trigger delivery_timeline after insert or update of status on public.notification_deliveries
  for each row execute function public.log_delivery_step();

-- 3. An acknowledgement stops the person's remaining held channels.
create or replace function public.stop_fallback_on_ack() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.notification_events where id = new.event_id;
  insert into public.event_timeline (organization_id, event_id, person_id, kind, detail)
  values (v_org, new.event_id, new.person_id, 'acknowledged', left(new.response, 40));
  update public.notification_deliveries set status = 'skipped', error_code = 'acknowledged', updated_at = now()
   where event_id = new.event_id and person_id = new.person_id and status = 'held';
  return new;
end $$;
revoke all on function public.stop_fallback_on_ack() from public, anon, authenticated;
drop trigger if exists ack_stops_fallback on public.acknowledgements;
create trigger ack_stops_fallback after insert on public.acknowledgements
  for each row execute function public.stop_fallback_on_ack();

-- 4. Release the next held channel. p_force releases even though an earlier channel was sent/delivered (used for unacknowledged escalation).
drop function if exists public.release_held(uuid, uuid);
create or replace function public.release_held(p_event uuid, p_person uuid, p_force boolean default false)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id uuid; v_org uuid; v_channel text;
begin
  if exists (select 1 from public.acknowledgements where event_id = p_event and person_id = p_person) then
    return false; -- already answered: nothing more to send
  end if;
  if exists (select 1 from public.notification_deliveries
              where event_id = p_event and person_id = p_person
                and (status in ('queued','sending') or (not p_force and status in ('sent','delivered')))) then
    return false; -- another channel is still working (or already reached them)
  end if;
  select d.id, d.organization_id, d.channel into v_id, v_org, v_channel
    from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
   where d.event_id = p_event and d.person_id = p_person and d.status = 'held'
   order by array_position(e.channels, d.channel) limit 1 for update of d;
  if v_id is null then return false; end if;
  insert into public.event_timeline (organization_id, event_id, person_id, channel, kind, detail)
  values (v_org, p_event, p_person, v_channel, 'fallback_released', case when p_force then 'no acknowledgement in time' else 'earlier channel failed' end);
  update public.notification_deliveries set status = 'queued', next_attempt_at = now(), updated_at = now() where id = v_id;
  update public.notification_events set status = 'sending' where id = p_event and status = 'complete';
  return true;
end $$;

-- 5. Escalation: called every minute by the sweeper. Returns how many people moved to their next channel.
create or replace function public.escalate_unacknowledged()
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in
    select distinct d.event_id, d.person_id
      from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
     where d.status = 'held' and e.channel_mode = 'fallback' and e.fallback_after_seconds > 0 and e.requires_ack
       and e.status in ('sending','complete')
       and exists (select 1 from public.notification_deliveries s
                    where s.event_id = d.event_id and s.person_id = d.person_id and s.status in ('sent','delivered')
                      and coalesce(s.delivered_at, s.sent_at) <= now() - make_interval(secs => e.fallback_after_seconds))
  loop
    if public.release_held(r.event_id, r.person_id, true) then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function public.release_held(uuid,uuid,boolean), public.escalate_unacknowledged() from public, anon, authenticated;
grant execute on function public.release_held(uuid,uuid,boolean), public.escalate_unacknowledged() to service_role;
