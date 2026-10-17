-- Separate consent for automated voice calls. Additive. Review before applying. Apply AFTER 20261016001800_app_alert_rollcall.sql.
-- Why: until now a person's agreement to TEXTS (consent_status) also allowed calls. Calls need their own agreement.
-- * New columns on people: voice_consent_status (pending | consented | withdrawn), voice_consented_at, voice_consent_method.
--   EVERYONE starts as pending, including people who already agreed to texts. Nobody is called until they agree to calls.
-- * Calls are queued and claimed only for people with voice_consent_status = 'consented' and no voice opt-out (key 9 still stops calls).
-- * The enrollment form has a second, unchecked box for calls. Text and call agreement are independent: either can be given alone.
--   record_web_consent records each with the exact text shown and its own version in consent_events (events: opt_in, voice_opt_in).
-- * A changed mobile number sends both agreements back to pending (they covered the old number).
-- * Text behaviour (STOP, START, SMS consent) is unchanged.

alter table public.people
  add column if not exists voice_consent_status text not null default 'pending',
  add column if not exists voice_consented_at timestamptz,
  add column if not exists voice_consent_method text;
alter table public.people drop constraint if exists people_voice_consent_status_check;
alter table public.people add constraint people_voice_consent_status_check check (voice_consent_status in ('pending','consented','withdrawn'));
create index if not exists people_org_voice_consent_idx on public.people (organization_id, voice_consent_status);

-- Someone who pressed 9 earlier already opted out of calls: reflect it as withdrawn.
update public.people set voice_consent_status = 'withdrawn' where voice_opted_out and voice_consent_status <> 'withdrawn';

-- Invites: a person may now be invited to agree to calls even when they already agreed to texts.
create or replace function public.create_enrollment_invites(p_org uuid, p_invites jsonb, p_created_by uuid, p_ttl_days int default 30)
returns uuid[] language plpgsql security invoker set search_path = public, pg_temp as $$
declare r jsonb; v_person uuid; v_done uuid[] := '{}';
begin
  if p_invites is null or jsonb_typeof(p_invites) <> 'array' then raise exception 'invites must be a JSON array'; end if;
  if jsonb_array_length(p_invites) > 5000 then raise exception 'at most 5000 invites per call'; end if;
  for r in select * from jsonb_array_elements(p_invites) loop
    v_person := (r->>'person_id')::uuid;
    continue when not exists (select 1 from public.people where id = v_person and organization_id = p_org and is_active
                                and (consent_status <> 'consented' or voice_consent_status <> 'consented'));
    delete from public.enrollment_invites where person_id = v_person and used_at is null;   -- a new link replaces any unused one
    insert into public.enrollment_invites (organization_id, person_id, token_hash, expires_at, created_by)
    values (p_org, v_person, r->>'token_hash', now() + make_interval(days => greatest(1, least(p_ttl_days, 90))), p_created_by);
    v_done := array_append(v_done, v_person);
  end loop;
  insert into public.audit_log (organization_id, actor, action, entity, details)
  values (p_org, p_created_by, 'invites_created', 'enrollment_invites', jsonb_build_object('count', coalesce(array_length(v_done,1),0)));
  return v_done;
end $$;

create or replace function public.get_enrollment_invite(p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.enrollment_invites%rowtype; p public.people%rowtype; o public.organizations%rowtype; st text;
begin
  select * into i from public.enrollment_invites where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into p from public.people where id = i.person_id;
  select * into o from public.organizations where id = i.organization_id;
  st := case when i.used_at is not null then 'used' when i.expires_at < now() then 'expired' else 'valid' end;
  return jsonb_build_object('status', st, 'org_name', o.name, 'first_name', split_part(coalesce(p.full_name, ''), ' ', 1),
    'phone_last4', right(p.mobile_phone, 4), 'already_consented', p.consent_status = 'consented', 'opted_out', p.sms_opted_out,
    'voice_consented', p.voice_consent_status = 'consented' and not p.voice_opted_out, 'voice_opted_out', p.voice_opted_out);
end $$;

-- Atomic: validates the link, records text consent (when p_text is given) and/or call consent (when p_voice_agreed), burns the link.
drop function if exists public.record_web_consent(text,text,text);
create or replace function public.record_web_consent(p_token_hash text, p_text text, p_text_version text,
                                                     p_voice_agreed boolean default false, p_voice_text text default null, p_voice_text_version text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.enrollment_invites%rowtype; p public.people%rowtype; o public.organizations%rowtype;
        was_consented boolean; was_voice boolean; v_text boolean := p_text is not null and btrim(p_text) <> '';
begin
  if not v_text and not coalesce(p_voice_agreed, false) then raise exception 'nothing to record'; end if;
  if coalesce(p_voice_agreed, false) and (p_voice_text is null or btrim(p_voice_text) = '') then raise exception 'voice consent text is required'; end if;
  select * into i from public.enrollment_invites where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if i.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into p from public.people where id = i.person_id for update;
  select * into o from public.organizations where id = i.organization_id;
  was_consented := p.consent_status = 'consented';
  was_voice := p.voice_consent_status = 'consented';
  if v_text then
    -- A person who replied STOP stays opted out here: the carrier keeps blocking them until they text START.
    update public.people set consent_status = 'consented', consented_at = now(), consent_method = 'web_form', updated_at = now() where id = p.id;
    insert into public.consent_events (person_id, event, method, consent_text, text_version) values (p.id, 'opt_in', 'web_form', p_text, p_text_version);
  end if;
  if coalesce(p_voice_agreed, false) then
    -- Agreeing again after pressing 9 turns calls back on: the person chose it on this form.
    update public.people set voice_consent_status = 'consented', voice_consented_at = now(), voice_consent_method = 'web_form',
           voice_opted_out = false, voice_opted_out_at = null, updated_at = now() where id = p.id;
    insert into public.consent_events (person_id, event, method, consent_text, text_version) values (p.id, 'voice_opt_in', 'web_form', p_voice_text, p_voice_text_version);
  end if;
  update public.enrollment_invites set used_at = now() where id = i.id;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (i.organization_id, null, 'consent_recorded', 'people', p.id::text,
          jsonb_build_object('method', 'web_form', 'text', v_text, 'voice', coalesce(p_voice_agreed, false),
                             'text_version', p_text_version, 'voice_text_version', p_voice_text_version));
  return jsonb_build_object('ok', true, 'org_name', o.name, 'person_id', p.id, 'to', p.mobile_phone,
                            'opted_out', p.sms_opted_out, 'already_consented', was_consented,
                            'text_recorded', v_text, 'voice_recorded', coalesce(p_voice_agreed, false), 'voice_already_consented', was_voice);
end $$;
revoke all on function public.record_web_consent(text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.record_web_consent(text,text,text,boolean,text,text) to service_role;

-- Queue: calls only for people who agreed to calls.
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
                     when 'voice' then case when p.voice_opted_out then 'opted_out' when p.voice_consent_status <> 'consented' then 'no_consent' end
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
           or (d.channel = 'voice' and (p.voice_opted_out or p.voice_consent_status <> 'consented'))
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

-- Compose-screen preview of who can be called.
create or replace function public.preview_voice_audience(p_group_ids uuid[])
returns jsonb language sql stable set search_path = public, private, pg_temp as $$
  with m as (
    select p.voice_opted_out, p.voice_consent_status
    from public.people p
    where p.organization_id = private.current_org_id() and p.is_active
      and exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  where gm.person_id = p.id and gm.group_id = any(coalesce(p_group_ids, '{}')) and g.organization_id = p.organization_id))
  select jsonb_build_object('total', count(*),
    'will_receive', count(*) filter (where not voice_opted_out and voice_consent_status = 'consented'),
    'opted_out', count(*) filter (where voice_opted_out),
    'no_consent', count(*) filter (where not voice_opted_out and voice_consent_status <> 'consented'))
  from m;
$$;

-- A changed mobile number sends both agreements (texts and calls) back to pending.
create or replace function public.self_update_contact(p_person uuid, p_mobile text, p_email text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare p public.people%rowtype; v_changed text[] := '{}'; v_mobile text; v_email text; v_consent_reset boolean := false; v_voice_reset boolean := false;
begin
  select * into p from public.people where id = p_person and is_active for update;
  if not found then raise exception 'person not found'; end if;
  v_mobile := coalesce(nullif(btrim(p_mobile), ''), p.mobile_phone);
  v_email  := case when p_email is null then p.email else nullif(btrim(p_email), '') end;
  if v_mobile !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid mobile number'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email address'; end if;
  if v_mobile is distinct from p.mobile_phone then v_changed := array_append(v_changed, 'mobile_phone'::text); end if;
  if v_email is distinct from p.email then v_changed := array_append(v_changed, 'email'::text); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('changed', '[]'::jsonb, 'consent_reset', false); end if;
  v_consent_reset := 'mobile_phone' = any(v_changed) and p.consent_status = 'consented';
  v_voice_reset := 'mobile_phone' = any(v_changed) and p.voice_consent_status = 'consented';
  begin
    update public.people set
      mobile_phone = v_mobile,
      email = v_email,
      email_bounced_at = case when 'email' = any(v_changed) then null else email_bounced_at end,
      consent_status = case when v_consent_reset then 'pending' else consent_status end,
      consented_at = case when v_consent_reset then null else consented_at end,
      consent_method = case when v_consent_reset then null else consent_method end,
      voice_consent_status = case when v_voice_reset then 'pending' else voice_consent_status end,
      voice_consented_at = case when v_voice_reset then null else voice_consented_at end,
      voice_consent_method = case when v_voice_reset then null else voice_consent_method end,
      updated_at = now()
     where id = p_person;
  exception when unique_violation then
    raise exception 'that number could not be used';
  end;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p.organization_id, null, 'person.self_update', 'person', p_person::text,
          jsonb_build_object('by', p_actor, 'changed', to_jsonb(v_changed), 'consent_reset', v_consent_reset, 'voice_consent_reset', v_voice_reset,
                             'mobile_from_last4', right(p.mobile_phone, 4), 'mobile_to_last4', right(v_mobile, 4),
                             'email_from', p.email, 'email_to', v_email));
  return jsonb_build_object('changed', to_jsonb(v_changed), 'consent_reset', v_consent_reset or v_voice_reset);
end $$;
