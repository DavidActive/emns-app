-- P16: desktop alert channel (Windows desktop agent). Additive. Review before applying. Apply AFTER 20261016001600_audit_hardening.sql.
-- * "desktop" becomes a fourth channel on the same queue (text, email, voice, desktop). Works in "together" and "fallback" modes.
-- * An employee pairs a computer with a short code (shown on their "My contact details" page). The agent then holds a long-lived device token.
--   Only a SHA-256 hash of the token and of the code is stored. A revoked device stops working on its next call.
-- * The agent PULLS alerts over one outbound HTTPS connection (long poll). Nothing is pushed to the workstation, so IT only has to allow one address.
-- * Handing the alert to the agent = "sent"; the agent showing it on screen = "delivered"; an "I'm safe" / "I need help" click is an acknowledgement
--   exactly like a text reply or a keypad press (same roll-call, same inbox item for help requests).
-- * No agent reachable within the wait time (default 2 minutes, set by the sweeper) = "undelivered" (agent_offline), which releases the person's next channel.
-- * A person with no enrolled computer is skipped for this channel (no_agent), so fallback moves on straight away.
-- * Employees never touch these tables directly. All agent calls go through service-role functions that find the person from the device token.

-- 1. Message text for the desktop alert (brand, organization, DRILL/TEST wording built server-side; no "reply STOP" footer)
alter table public.notification_events add column if not exists desktop_text text;

-- 2. Devices
create table if not exists public.agent_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  token_hash text not null unique,
  device_name text not null check (length(device_name) between 1 and 100),
  platform text not null default 'windows' check (platform in ('windows','mac','linux')),
  agent_version text,
  enrolled_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index if not exists agent_devices_person_idx on public.agent_devices (person_id) where revoked_at is null;
create index if not exists agent_devices_org_idx on public.agent_devices (organization_id, last_seen_at desc);
alter table public.agent_devices enable row level security;
drop policy if exists agent_devices_read on public.agent_devices;
create policy agent_devices_read on public.agent_devices for select to authenticated
  using (organization_id = private.current_org_id() or private.is_platform_admin());
drop policy if exists agent_devices_revoke on public.agent_devices;
create policy agent_devices_revoke on public.agent_devices for update to authenticated
  using ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin())
  with check ((organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender')) or private.is_platform_admin());
-- Staff can see devices (never the token hash) and can only set revoked_at.
revoke all on public.agent_devices from anon, authenticated;
grant select (id, organization_id, person_id, device_name, platform, agent_version, enrolled_at, last_seen_at, revoked_at) on public.agent_devices to authenticated;
grant update (revoked_at) on public.agent_devices to authenticated;
grant all on public.agent_devices to service_role;

-- 3. Pairing codes (single use, short lived)
create table if not exists public.agent_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.agent_pairing_codes enable row level security;   -- no policies: service role only
revoke all on public.agent_pairing_codes from anon, authenticated;
grant all on public.agent_pairing_codes to service_role;

-- 4. What each computer has been handed, shown and dismissed
create table if not exists public.desktop_receipts (
  delivery_id uuid not null references public.notification_deliveries(id) on delete cascade,
  device_id uuid not null references public.agent_devices(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  shown_at timestamptz,
  dismissed_at timestamptz,
  primary key (delivery_id, device_id)
);
create index if not exists desktop_receipts_device_idx on public.desktop_receipts (device_id) where dismissed_at is null;
alter table public.desktop_receipts enable row level security;   -- no policies: service role only
revoke all on public.desktop_receipts from anon, authenticated;
grant all on public.desktop_receipts to service_role;

-- 5. Audit: revoking a computer is written to the append-only log
create or replace function public.audit_agent_device() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null then
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (new.organization_id, private.audit_actor(), 'agent.revoked', 'agent_device', new.id::text,
            jsonb_build_object('person_id', new.person_id, 'device_name', new.device_name));
  end if;
  return null;
end $$;
revoke all on function public.audit_agent_device() from public, anon, authenticated;
drop trigger if exists audit_agent_devices on public.agent_devices;
create trigger audit_agent_devices after update on public.agent_devices for each row execute function public.audit_agent_device();

-- 6. Create an event (adds desktop). Same behavior as before for text, email and voice.
drop function if exists public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text,text,int,int);
create or replace function public.create_notification_event(
  p_org uuid, p_kind text, p_body text, p_group_ids uuid[], p_created_by uuid,
  p_requires_ack boolean default true, p_scenario uuid default null, p_idempotency_key text default null,
  p_channels text[] default array['sms']::text[], p_mode text default 'together',
  p_email_subject text default null, p_email_body text default null,
  p_voice_text text default null, p_voice_max_attempts int default 2, p_voice_retry_seconds int default 120,
  p_desktop_text text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_queued int; v_held int; v_opted int; v_nocons int; v_found int; v_people int; v_by jsonb;
begin
  if p_kind not in ('alert','drill','test') then raise exception 'invalid kind'; end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 1600 then raise exception 'body must be 1-1600 characters'; end if;
  if p_group_ids is null or coalesce(array_length(p_group_ids,1),0) = 0 then raise exception 'select at least one group'; end if;
  if p_channels is null or cardinality(p_channels) = 0
     or exists (select 1 from unnest(p_channels) c where c not in ('sms','email','voice','desktop'))
     or cardinality(p_channels) <> (select count(distinct c) from unnest(p_channels) c) then
    raise exception 'invalid channels';
  end if;
  if p_mode not in ('together','fallback') then raise exception 'invalid mode'; end if;
  if 'email' = any(p_channels) then
    if p_email_subject is null or btrim(p_email_subject) = '' or length(p_email_subject) > 200 then raise exception 'email subject must be 1-200 characters'; end if;
    if p_email_body is not null and length(p_email_body) > 10000 then raise exception 'email body too long'; end if;
  end if;
  if 'voice' = any(p_channels) then
    if p_voice_text is null or btrim(p_voice_text) = '' or length(p_voice_text) > 1500 then raise exception 'voice text must be 1-1500 characters'; end if;
    if p_voice_max_attempts is null or p_voice_max_attempts not between 1 and 5 then raise exception 'voice attempts must be 1-5'; end if;
    if p_voice_retry_seconds is null or p_voice_retry_seconds not between 30 and 3600 then raise exception 'voice retry wait must be 30-3600 seconds'; end if;
  end if;
  if 'desktop' = any(p_channels) then
    if p_desktop_text is null or btrim(p_desktop_text) = '' or length(p_desktop_text) > 1000 then raise exception 'desktop text must be 1-1000 characters'; end if;
  end if;
  select count(*) into v_found from public.groups where organization_id = p_org and id = any(p_group_ids);
  if v_found <> cardinality(p_group_ids) then raise exception 'one or more groups do not belong to this organization'; end if;

  if p_idempotency_key is not null then
    select id into v_event from public.notification_events where organization_id = p_org and idempotency_key = p_idempotency_key;
    if v_event is not null then return jsonb_build_object('event_id', v_event, 'deduplicated', true); end if;
  end if;

  insert into public.notification_events (organization_id, scenario_id, kind, status, requires_ack, created_by, body, group_ids, idempotency_key,
                                          channels, channel_mode, email_subject, email_body, voice_text, voice_max_attempts, voice_retry_seconds, desktop_text)
  values (p_org, p_scenario, p_kind, 'sending', p_requires_ack, p_created_by, p_body, p_group_ids, p_idempotency_key,
          p_channels, p_mode, case when 'email' = any(p_channels) then btrim(p_email_subject) end,
          case when 'email' = any(p_channels) then p_email_body end,
          case when 'voice' = any(p_channels) then btrim(p_voice_text) end,
          case when 'voice' = any(p_channels) then p_voice_max_attempts else 2 end,
          case when 'voice' = any(p_channels) then p_voice_retry_seconds else 120 end,
          case when 'desktop' = any(p_channels) then btrim(p_desktop_text) end)
  returning id into v_event;

  insert into public.notification_deliveries (event_id, organization_id, person_id, channel, status, error_code)
  with cand as (
    select p.id as person_id, c.ch, c.ord,
           case c.ch when 'sms' then case when p.sms_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
                     when 'voice' then case when p.voice_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
                     when 'desktop' then case when not exists (select 1 from public.agent_devices ad where ad.person_id = p.id and ad.revoked_at is null) then 'no_agent' end
                     else public.email_skip_reason(p.email, p.email_opted_out, p.email_bounced_at) end as skip
    from public.people p
    cross join unnest(p_channels) with ordinality as c(ch, ord)
    where p.organization_id = p_org and p.is_active
      and exists (select 1 from public.group_members gm where gm.person_id = p.id and gm.group_id = any(p_group_ids))),
  firsts as (select cand.*, min(ord) filter (where skip is null) over (partition by person_id) as first_ok from cand)
  select v_event, p_org, person_id, ch,
         case when skip is not null then 'skipped'
              when p_mode = 'together' or ord = first_ok then 'queued'
              else 'held' end,
         skip
  from firsts
  on conflict (event_id, person_id, channel) do nothing;

  select count(*) filter (where status = 'queued'),
         count(*) filter (where status = 'held'),
         count(*) filter (where channel = 'sms' and error_code = 'opted_out'),
         count(*) filter (where channel = 'sms' and error_code = 'no_consent'),
         count(distinct person_id)
    into v_queued, v_held, v_opted, v_nocons, v_people from public.notification_deliveries where event_id = v_event;
  select coalesce(jsonb_object_agg(channel, jsonb_build_object('queued', q, 'held', h, 'skipped', s)), '{}'::jsonb) into v_by from (
    select channel, count(*) filter (where status = 'queued') q, count(*) filter (where status = 'held') h, count(*) filter (where status = 'skipped') s
    from public.notification_deliveries where event_id = v_event group by channel) t;
  update public.notification_events set recipient_count = v_people,
         status = case when v_queued = 0 then 'complete' else 'sending' end, sent_at = now() where id = v_event;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p_org, p_created_by, 'event_created', 'notification_events', v_event::text,
          jsonb_build_object('kind', p_kind, 'groups', p_group_ids, 'queued', v_queued, 'held', v_held, 'channels', p_channels, 'mode', p_mode,
                             'skipped_opted_out', v_opted, 'skipped_no_consent', v_nocons));
  return jsonb_build_object('event_id', v_event, 'deduplicated', false, 'queued', v_queued, 'held', v_held,
                            'skipped', v_opted + v_nocons, 'skipped_opted_out', v_opted, 'skipped_no_consent', v_nocons, 'by_channel', v_by);
end $$;

-- 7. Claiming: desktop rows are NEVER claimed by the send worker (the agent collects them). Everything else is unchanged.
create or replace function public.claim_deliveries(p_worker text, p_limit int default 50, p_lease_seconds int default 120, p_voice_max_active int default 0)
returns table (delivery_id uuid, event_id uuid, organization_id uuid, person_id uuid, channel text, to_number text, to_email text,
               subject text, body text, attempt int)
language plpgsql security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_events uuid[] := '{}'; g record; v_slots int; v_limit int := least(greatest(p_limit, 1), 500);
begin
  for g in
    with gone as (
      update public.notification_deliveries d
         set status = 'skipped', locked_by = null, updated_at = now(),
             error_code = case d.channel when 'sms' then case when p.sms_opted_out then 'opted_out' else 'no_consent' end
                                         when 'voice' then case when p.voice_opted_out then 'opted_out' else 'no_consent' end
                                         else public.email_skip_reason(p.email, p.email_opted_out, p.email_bounced_at) end
        from public.people p
       where p.id = d.person_id
         and ((d.channel = 'sms' and (p.sms_opted_out or p.consent_status <> 'consented'))
           or (d.channel = 'voice' and (p.voice_opted_out or p.consent_status <> 'consented'))
           or (d.channel = 'email' and public.email_skip_reason(p.email, p.email_opted_out, p.email_bounced_at) is not null))
         and ((d.status = 'queued' and d.next_attempt_at <= now())
           or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds)))
      returning d.event_id, d.person_id)
    select * from gone
  loop
    perform public.release_held(g.event_id, g.person_id);
    v_events := v_events || g.event_id;
  end loop;
  if cardinality(v_events) > 0 then
    perform public.refresh_event_status(e) from (select distinct unnest(v_events) as e) x;
  end if;

  if p_voice_max_active > 0 then
    select greatest(p_voice_max_active - count(*), 0) into v_slots from public.notification_deliveries d
     where d.channel = 'voice' and (d.status = 'sending' or (d.status = 'sent' and d.call_outcome is null and d.sent_at > now() - interval '30 minutes'));
  else
    v_slots := v_limit;
  end if;

  return query
  with picked_other as (
    select d.id from public.notification_deliveries d
    where d.channel not in ('voice','desktop')
      and ((d.status = 'queued' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds)))
    order by d.next_attempt_at
    limit v_limit
    for update skip locked),
  picked_voice as (
    select d.id from public.notification_deliveries d
    where d.channel = 'voice'
      and ((d.status = 'queued' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds)))
    order by d.next_attempt_at
    limit least(v_limit, v_slots)
    for update skip locked),
  picked as (select id from picked_other union all select id from picked_voice),
  upd as (
    update public.notification_deliveries d
       set status = 'sending', locked_by = p_worker, locked_at = now(), attempt = d.attempt + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.event_id, d.organization_id, d.person_id, d.channel, d.attempt)
  select upd.id, upd.event_id, upd.organization_id, upd.person_id, upd.channel,
         case when upd.channel in ('sms','voice') then pp.mobile_phone end,
         case when upd.channel = 'email' then pp.email end,
         case when upd.channel = 'email' then e.email_subject end,
         case upd.channel when 'email' then coalesce(e.email_body, e.body) when 'voice' then coalesce(e.voice_text, e.body) else e.body end,
         upd.attempt
  from upd join public.people pp on pp.id = upd.person_id join public.notification_events e on e.id = upd.event_id;
end $$;

-- 8. Pairing: the employee asks for a code (the function has already verified who they are).
--    One live code per person: asking again replaces the old one.
create or replace function public.create_agent_pairing(p_person uuid, p_code_hash text, p_ttl_seconds int default 600)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare p public.people%rowtype; v_exp timestamptz;
begin
  select * into p from public.people where id = p_person and is_active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'person_not_found'); end if;
  delete from public.agent_pairing_codes where person_id = p_person and used_at is null;
  delete from public.agent_pairing_codes where expires_at < now() - interval '1 day';
  v_exp := now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 3600)));
  insert into public.agent_pairing_codes (organization_id, person_id, code_hash, expires_at) values (p.organization_id, p.id, p_code_hash, v_exp);
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end $$;

-- 9. Enrolling a computer with a code. A code works once. At most 5 computers per person (revoke one to add another).
create or replace function public.enroll_agent_device(p_code_hash text, p_token_hash text, p_device_name text, p_platform text, p_version text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c record; p public.people%rowtype; v_dev uuid; v_org text; v_n int;
begin
  select * into c from public.agent_pairing_codes where code_hash = p_code_hash and used_at is null and expires_at > now() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  select * into p from public.people where id = c.person_id and is_active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  select count(*) into v_n from public.agent_devices where person_id = p.id and revoked_at is null;
  if v_n >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_devices'); end if;
  update public.agent_pairing_codes set used_at = now() where id = c.id;
  insert into public.agent_devices (organization_id, person_id, token_hash, device_name, platform, agent_version, last_seen_at)
  values (p.organization_id, p.id, p_token_hash, left(btrim(coalesce(nullif(p_device_name, ''), 'Computer')), 100),
          case when p_platform in ('windows','mac','linux') then p_platform else 'windows' end, left(p_version, 40), now())
  returning id into v_dev;
  select name into v_org from public.organizations where id = p.organization_id;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p.organization_id, null, 'agent.enrolled', 'agent_device', v_dev::text, jsonb_build_object('person_id', p.id, 'device_name', left(p_device_name, 100)));
  return jsonb_build_object('ok', true, 'device_id', v_dev, 'person_name', p.full_name, 'organization', v_org);
end $$;

-- 10. Employee removes one of their own computers (the function has verified who they are).
create or replace function public.revoke_agent_device_for_person(p_person uuid, p_device uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare d public.agent_devices%rowtype;
begin
  update public.agent_devices set revoked_at = now() where id = p_device and person_id = p_person and revoked_at is null returning * into d;
  if not found then return false; end if;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (d.organization_id, null, 'agent.revoked', 'agent_device', d.id::text, jsonb_build_object('person_id', d.person_id, 'device_name', d.device_name, 'by', 'employee'));
  return true;
end $$;

-- 11. The agent's poll: hand over new alerts for this person that this computer has not seen, and say which earlier alerts to close
--     (answered somewhere else, or the event was cancelled). Marks the computer as seen.
--     An alert that already timed out (agent_offline) is still handed over if the computer comes back within p_max_age_seconds: late is better than never.
create or replace function public.agent_claim(p_token_hash text, p_version text default null, p_max_age_seconds int default 21600)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare dev record; v_alerts jsonb; v_dismiss jsonb;
begin
  select ad.id, ad.person_id, ad.organization_id into dev
    from public.agent_devices ad join public.people p on p.id = ad.person_id and p.is_active
   where ad.token_hash = p_token_hash and ad.revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;

  update public.agent_devices set last_seen_at = now(), agent_version = coalesce(left(p_version, 40), agent_version)
   where id = dev.id and (last_seen_at is null or last_seen_at < now() - interval '10 seconds');

  with fresh as (
    insert into public.desktop_receipts (delivery_id, device_id)
    select d.id, dev.id
      from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
     where d.person_id = dev.person_id and d.channel = 'desktop'
       and d.status in ('queued','sent','delivered','undelivered')
       and (d.status <> 'undelivered' or d.error_code = 'agent_offline')
       and e.status <> 'cancelled'
       and e.created_at > now() - make_interval(secs => greatest(60, least(p_max_age_seconds, 86400)))
       and not exists (select 1 from public.acknowledgements a where a.event_id = d.event_id and a.person_id = d.person_id)
    on conflict do nothing
    returning delivery_id),
  upd as (
    update public.notification_deliveries d set status = 'sent', sent_at = coalesce(d.sent_at, now()), error_code = null, updated_at = now()
      from fresh where d.id = fresh.delivery_id and d.status in ('queued','undelivered')
    returning d.id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', d.id, 'event_id', e.id, 'kind', e.kind, 'body', coalesce(e.desktop_text, e.body),
           'requires_ack', e.requires_ack, 'created_at', e.created_at, 'organization', o.name) order by e.created_at), '[]'::jsonb)
    into v_alerts
    from fresh join public.notification_deliveries d on d.id = fresh.delivery_id
    join public.notification_events e on e.id = d.event_id
    join public.organizations o on o.id = e.organization_id;

  with gone as (
    update public.desktop_receipts r set dismissed_at = now()
      from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
     where r.device_id = dev.id and r.delivery_id = d.id and r.dismissed_at is null
       and (e.status = 'cancelled' or exists (select 1 from public.acknowledgements a where a.event_id = d.event_id and a.person_id = d.person_id))
    returning r.delivery_id)
  select coalesce(jsonb_agg(delivery_id), '[]'::jsonb) into v_dismiss from gone;

  return jsonb_build_object('ok', true, 'alerts', v_alerts, 'dismiss', v_dismiss);
end $$;

-- 12. The agent reports back: shown (on screen), dismiss (closed, nothing to answer), ack (SAFE or SOS).
--     SOS creates a critical inbox item, like an SOS text or a keypad 2. Safe to repeat: the same click is never counted twice.
create or replace function public.agent_report(p_token_hash text, p_delivery uuid, p_action text, p_response text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare dev record; r record; v_ack uuid; v_item uuid; v_msg text := 'Clicked "I need help" on the desktop alert.';
begin
  if p_action not in ('shown','dismiss','ack') then return jsonb_build_object('ok', false, 'reason', 'invalid_action'); end if;
  select ad.id, ad.person_id into dev
    from public.agent_devices ad join public.people p on p.id = ad.person_id and p.is_active
   where ad.token_hash = p_token_hash and ad.revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;

  select d.id, d.event_id, d.person_id, d.organization_id, e.requires_ack into r
    from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
    join public.desktop_receipts rc on rc.delivery_id = d.id and rc.device_id = dev.id
   where d.id = p_delivery and d.person_id = dev.person_id and d.channel = 'desktop';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  update public.desktop_receipts set shown_at = coalesce(shown_at, now()) where delivery_id = r.id and device_id = dev.id;
  -- Putting it on screen proves the alert reached them.
  update public.notification_deliveries set status = 'delivered', delivered_at = coalesce(delivered_at, now()), error_code = null, updated_at = now()
   where id = r.id and status in ('queued','sent','undelivered');
  perform public.refresh_event_status(r.event_id);
  if p_action = 'shown' then return jsonb_build_object('ok', true); end if;

  update public.desktop_receipts set dismissed_at = coalesce(dismissed_at, now()) where delivery_id = r.id and device_id = dev.id;
  if p_action = 'dismiss' then return jsonb_build_object('ok', true); end if;

  if p_response not in ('SAFE','SOS') then return jsonb_build_object('ok', false, 'reason', 'invalid_response'); end if;
  if not r.requires_ack then return jsonb_build_object('ok', false, 'reason', 'no_ack'); end if;
  insert into public.acknowledgements (event_id, person_id, response, reply_text, provider_sid, received_at)
  values (r.event_id, r.person_id, p_response, 'Desktop alert', 'desktop:' || r.id::text || ':' || p_response, clock_timestamp())
  on conflict (event_id, provider_sid) where provider_sid is not null do nothing
  returning id into v_ack;
  if v_ack is null then return jsonb_build_object('ok', true, 'response', p_response, 'duplicate', true); end if;
  if p_response = 'SOS' then
    insert into public.inbox_items (organization_id, person_id, tier, item_type, status, message_body, unread_reply, last_inbound_at)
    values (r.organization_id, r.person_id, 3, 'SOS', 'open', v_msg, true, now()) returning id into v_item;
    insert into public.inbox_messages (item_id, direction, body) values (v_item, 'inbound', v_msg);
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (r.organization_id, null, 'sos_reply', 'notification_events', r.event_id::text, jsonb_build_object('person_id', r.person_id, 'channel', 'desktop'));
  end if;
  return jsonb_build_object('ok', true, 'response', p_response, 'duplicate', false);
end $$;

-- 13. Nobody picked it up: after p_ttl_seconds a queued desktop alert becomes "undelivered" (agent_offline) and the person's next channel is released.
--     Called by the sweeper. A computer that reconnects later still receives the alert (see agent_claim).
create or replace function public.expire_desktop_deliveries(p_ttl_seconds int default 120)
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare g record; n int := 0;
begin
  for g in
    update public.notification_deliveries d set status = 'undelivered', error_code = 'agent_offline', updated_at = now()
     where d.channel = 'desktop' and d.status = 'queued'
       and d.next_attempt_at < now() - make_interval(secs => greatest(10, least(p_ttl_seconds, 86400)))
    returning d.event_id, d.person_id
  loop
    perform public.release_held(g.event_id, g.person_id);
    perform public.refresh_event_status(g.event_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- 14. Compose-screen preview and the "reachable workstations" count (signed-in staff, own organization only).
create or replace function public.preview_desktop_audience(p_group_ids uuid[])
returns jsonb language sql stable set search_path = public, private, pg_temp as $$
  with m as (
    select p.id,
           exists (select 1 from public.agent_devices ad where ad.person_id = p.id and ad.revoked_at is null) as enrolled,
           exists (select 1 from public.agent_devices ad where ad.person_id = p.id and ad.revoked_at is null and ad.last_seen_at > now() - interval '2 minutes') as online
    from public.people p
    where p.organization_id = private.current_org_id() and p.is_active
      and exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  where gm.person_id = p.id and gm.group_id = any(coalesce(p_group_ids, '{}')) and g.organization_id = p.organization_id))
  select jsonb_build_object('total', count(*), 'will_receive', count(*) filter (where enrolled),
         'online', count(*) filter (where online), 'no_agent', count(*) filter (where not enrolled))
  from m;
$$;

create or replace function public.desktop_reachability()
returns jsonb language sql stable set search_path = public, private, pg_temp as $$
  select jsonb_build_object(
    'devices', count(*) filter (where revoked_at is null),
    'online', count(*) filter (where revoked_at is null and last_seen_at > now() - interval '2 minutes'),
    'people', count(distinct person_id) filter (where revoked_at is null),
    'people_online', count(distinct person_id) filter (where revoked_at is null and last_seen_at > now() - interval '2 minutes'))
  from public.agent_devices where organization_id = private.current_org_id();
$$;

-- 15. Permissions: everything the agent and the pairing flow use is service role only; the two read-only previews are for signed-in staff.
revoke all on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text,text,int,int,text),
  public.claim_deliveries(text,int,int,int),
  public.create_agent_pairing(uuid,text,int), public.enroll_agent_device(text,text,text,text,text), public.revoke_agent_device_for_person(uuid,uuid),
  public.agent_claim(text,text,int), public.agent_report(text,uuid,text,text), public.expire_desktop_deliveries(int)
  from public, anon, authenticated;
grant execute on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text,text,int,int,text),
  public.claim_deliveries(text,int,int,int),
  public.create_agent_pairing(uuid,text,int), public.enroll_agent_device(text,text,text,text,text), public.revoke_agent_device_for_person(uuid,uuid),
  public.agent_claim(text,text,int), public.agent_report(text,uuid,text,text), public.expire_desktop_deliveries(int)
  to service_role;
revoke all on function public.preview_desktop_audience(uuid[]), public.desktop_reachability() from public, anon;
grant execute on function public.preview_desktop_audience(uuid[]), public.desktop_reachability() to authenticated;
