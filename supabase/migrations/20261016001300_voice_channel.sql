-- P10: voice channel. Additive. Review before applying. Apply AFTER 20261016001200_email_channel.sql.
-- * Voice is a third channel on the same queue (text, email, voice). It works in "together" and "fallback" modes like email.
-- * A call is "placed" (delivery status sent) when Twilio accepts it. The call result then arrives by status callback:
--   answered / voicemail -> delivered; busy / no answer -> retried (up to the event's attempt limit) then undelivered; failed -> failed.
--   Undelivered or failed releases the person's next held channel, exactly as for email.
-- * Keypad: 1 = safe, 2 = need help (creates a critical inbox item, like an SOS text), 9 = stop voice calls.
-- * Concurrency: claim_deliveries takes a cap on calls in flight, so a big call-out cannot exceed the carrier's limit.
-- * Consent: calls require the same consent_status as texts, plus no voice opt-out. Make sure the consent wording people agree to covers calls.

-- 1. Columns
alter table public.people
  add column if not exists voice_opted_out boolean not null default false,
  add column if not exists voice_opted_out_at timestamptz;

alter table public.notification_events
  add column if not exists voice_text text,
  add column if not exists voice_max_attempts int not null default 2,
  add column if not exists voice_retry_seconds int not null default 120;
alter table public.notification_events drop constraint if exists notification_events_voice_retry_check;
alter table public.notification_events add constraint notification_events_voice_retry_check
  check (voice_max_attempts between 1 and 5 and voice_retry_seconds between 30 and 3600);

alter table public.notification_deliveries
  add column if not exists call_outcome text,
  add column if not exists call_duration_seconds int,
  add column if not exists answered_by text,
  add column if not exists call_attempts int not null default 0;
alter table public.notification_deliveries drop constraint if exists notification_deliveries_call_outcome_check;
alter table public.notification_deliveries add constraint notification_deliveries_call_outcome_check
  check (call_outcome is null or call_outcome in ('answered','voicemail','no_answer','busy','failed','canceled'));

-- 2. Create an event (adds voice). Same behavior as before for text and email.
drop function if exists public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text);
create or replace function public.create_notification_event(
  p_org uuid, p_kind text, p_body text, p_group_ids uuid[], p_created_by uuid,
  p_requires_ack boolean default true, p_scenario uuid default null, p_idempotency_key text default null,
  p_channels text[] default array['sms']::text[], p_mode text default 'together',
  p_email_subject text default null, p_email_body text default null,
  p_voice_text text default null, p_voice_max_attempts int default 2, p_voice_retry_seconds int default 120)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_queued int; v_held int; v_opted int; v_nocons int; v_found int; v_people int; v_by jsonb;
begin
  if p_kind not in ('alert','drill','test') then raise exception 'invalid kind'; end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 1600 then raise exception 'body must be 1-1600 characters'; end if;
  if p_group_ids is null or coalesce(array_length(p_group_ids,1),0) = 0 then raise exception 'select at least one group'; end if;
  if p_channels is null or cardinality(p_channels) = 0
     or exists (select 1 from unnest(p_channels) c where c not in ('sms','email','voice'))
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
  select count(*) into v_found from public.groups where organization_id = p_org and id = any(p_group_ids);
  if v_found <> cardinality(p_group_ids) then raise exception 'one or more groups do not belong to this organization'; end if;

  if p_idempotency_key is not null then
    select id into v_event from public.notification_events where organization_id = p_org and idempotency_key = p_idempotency_key;
    if v_event is not null then return jsonb_build_object('event_id', v_event, 'deduplicated', true); end if;
  end if;

  insert into public.notification_events (organization_id, scenario_id, kind, status, requires_ack, created_by, body, group_ids, idempotency_key,
                                          channels, channel_mode, email_subject, email_body, voice_text, voice_max_attempts, voice_retry_seconds)
  values (p_org, p_scenario, p_kind, 'sending', p_requires_ack, p_created_by, p_body, p_group_ids, p_idempotency_key,
          p_channels, p_mode, case when 'email' = any(p_channels) then btrim(p_email_subject) end,
          case when 'email' = any(p_channels) then p_email_body end,
          case when 'voice' = any(p_channels) then btrim(p_voice_text) end,
          case when 'voice' = any(p_channels) then p_voice_max_attempts else 2 end,
          case when 'voice' = any(p_channels) then p_voice_retry_seconds else 120 end)
  returning id into v_event;

  insert into public.notification_deliveries (event_id, organization_id, person_id, channel, status, error_code)
  with cand as (
    select p.id as person_id, c.ch, c.ord,
           case c.ch when 'sms' then case when p.sms_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
                     when 'voice' then case when p.voice_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
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

-- 3. Claiming: voice rows are re-checked for consent / voice opt-out, and no more calls are handed out than the cap allows.
--    p_voice_max_active = 0 means no cap. Calls placed but without a result yet (last 30 minutes) count as in flight.
drop function if exists public.claim_deliveries(text,int,int);
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
    where d.channel <> 'voice'
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

-- 4. Recording results: placing a call counts one call attempt.
create or replace function public.record_delivery_result(
  p_delivery uuid, p_worker text, p_outcome text, p_sid text default null,
  p_error_code text default null, p_error_message text default null,
  p_retry_in_seconds int default 30, p_max_attempts int default 3)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_attempt int; v_event uuid; v_person uuid;
begin
  select attempt, event_id, person_id into v_attempt, v_event, v_person from public.notification_deliveries
   where id = p_delivery and locked_by = p_worker and status = 'sending';
  if not found then return false; end if;
  if p_outcome = 'sent' then
    update public.notification_deliveries set status = 'sent', provider_sid = p_sid, sent_at = now(), updated_at = now(), locked_by = null,
           call_attempts = call_attempts + case when channel = 'voice' then 1 else 0 end where id = p_delivery;
  elsif p_outcome = 'retry' and v_attempt < p_max_attempts then
    update public.notification_deliveries set status = 'queued', next_attempt_at = now() + make_interval(secs => p_retry_in_seconds * v_attempt),
           error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now(), locked_by = null where id = p_delivery;
  else
    update public.notification_deliveries set status = 'failed', error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now(), locked_by = null where id = p_delivery;
    perform public.release_held(v_event, v_person);
  end if;
  perform public.refresh_event_status(v_event);
  return true;
end $$;

-- 5. Call results from the carrier's status callback. Terminal results are never overwritten (duplicate or late callbacks are ignored).
create or replace function public.apply_call_status(
  p_sid text, p_call_status text, p_answered_by text default null, p_duration int default null, p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare r record; v_outcome text; v_max int; v_wait int; v_machine boolean;
begin
  v_machine := lower(coalesce(p_answered_by, '')) like 'machine%' or lower(coalesce(p_answered_by, '')) = 'fax';
  v_outcome := case lower(coalesce(p_call_status, ''))
    when 'completed' then case when v_machine then 'voicemail' else 'answered' end
    when 'busy' then 'busy' when 'no-answer' then 'no_answer' when 'failed' then 'failed' when 'canceled' then 'canceled' end;
  if v_outcome is null then return false; end if; -- queued / ringing / in-progress: nothing to record yet

  select id, event_id, person_id, status, call_attempts into r from public.notification_deliveries
   where provider_sid = p_sid and channel = 'voice' for update;
  if not found then return false; end if;
  if r.status <> 'sent' then
    -- already final (for example the keypad answered it) or a retry is already scheduled: only fill in missing details
    update public.notification_deliveries set call_duration_seconds = coalesce(call_duration_seconds, p_duration), answered_by = coalesce(answered_by, p_answered_by)
     where id = r.id;
    return false;
  end if;

  select voice_max_attempts, voice_retry_seconds into v_max, v_wait from public.notification_events where id = r.event_id;
  if v_outcome in ('answered','voicemail') then
    update public.notification_deliveries set status = 'delivered', delivered_at = now(), call_outcome = v_outcome, answered_by = p_answered_by,
           call_duration_seconds = p_duration, error_code = null, updated_at = now() where id = r.id;
  elsif v_outcome in ('busy','no_answer') and r.call_attempts < v_max then
    update public.notification_deliveries set status = 'queued', next_attempt_at = now() + make_interval(secs => v_wait), call_outcome = v_outcome,
           answered_by = p_answered_by, call_duration_seconds = p_duration, updated_at = now() where id = r.id;
    update public.notification_events set status = 'sending' where id = r.event_id and status = 'complete';
  elsif v_outcome in ('busy','no_answer') then
    update public.notification_deliveries set status = 'undelivered', call_outcome = v_outcome, error_code = v_outcome, answered_by = p_answered_by,
           call_duration_seconds = p_duration, updated_at = now() where id = r.id;
    perform public.release_held(r.event_id, r.person_id);
    perform public.refresh_event_status(r.event_id);
  else
    update public.notification_deliveries set status = 'failed', call_outcome = v_outcome, error_code = coalesce(p_error_code, v_outcome),
           answered_by = p_answered_by, call_duration_seconds = p_duration, updated_at = now() where id = r.id;
    perform public.release_held(r.event_id, r.person_id);
    perform public.refresh_event_status(r.event_id);
  end if;
  return true;
end $$;

-- 6. Keypad. 1 = safe, 2 = need help (critical inbox item), 9 = stop voice calls. Safe to repeat: the same press is never counted twice.
create or replace function public.record_keypad_ack(p_delivery uuid, p_digit text, p_call_sid text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare r record; v_resp text; v_ack uuid; v_item uuid; v_msg text := 'Pressed 2 (needs help) on the emergency voice call.';
begin
  select d.id, d.event_id, d.person_id, d.organization_id, e.requires_ack into r
    from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
   where d.id = p_delivery and d.channel = 'voice';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if p_digit = '9' then
    update public.people set voice_opted_out = true, voice_opted_out_at = now() where id = r.person_id and not voice_opted_out;
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (r.organization_id, null, 'voice_opt_out', 'people', r.person_id::text, jsonb_build_object('event_id', r.event_id));
    return jsonb_build_object('ok', true, 'action', 'opt_out');
  end if;

  v_resp := case p_digit when '1' then 'SAFE' when '2' then 'SOS' end;
  if v_resp is null then return jsonb_build_object('ok', false, 'reason', 'invalid_digit'); end if;
  if not r.requires_ack then return jsonb_build_object('ok', false, 'reason', 'no_ack'); end if;

  insert into public.acknowledgements (event_id, person_id, response, reply_text, provider_sid)
  values (r.event_id, r.person_id, v_resp, 'Keypad ' || p_digit, coalesce(p_call_sid, p_delivery::text) || ':' || p_digit)
  on conflict (event_id, provider_sid) where provider_sid is not null do nothing
  returning id into v_ack;
  if v_ack is null then return jsonb_build_object('ok', true, 'response', v_resp, 'duplicate', true); end if;

  -- Pressing a key proves the call was answered by a person.
  update public.notification_deliveries set status = 'delivered', delivered_at = coalesce(delivered_at, now()), call_outcome = 'answered', updated_at = now()
   where id = r.id and status in ('sent','delivered');

  if v_resp = 'SOS' then
    insert into public.inbox_items (organization_id, person_id, tier, item_type, status, message_body, unread_reply, last_inbound_at)
    values (r.organization_id, r.person_id, 3, 'SOS', 'open', v_msg, true, now()) returning id into v_item;
    insert into public.inbox_messages (item_id, direction, body) values (v_item, 'inbound', v_msg);
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (r.organization_id, null, 'sos_reply', 'notification_events', r.event_id::text, jsonb_build_object('person_id', r.person_id, 'channel', 'voice'));
  end if;
  return jsonb_build_object('ok', true, 'response', v_resp, 'duplicate', false);
end $$;

-- 7. Compose-screen preview of who can be called.
create or replace function public.preview_voice_audience(p_group_ids uuid[])
returns jsonb language sql stable set search_path = public, private, pg_temp as $$
  with m as (
    select p.voice_opted_out, p.consent_status
    from public.people p
    where p.organization_id = private.current_org_id() and p.is_active
      and exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  where gm.person_id = p.id and gm.group_id = any(coalesce(p_group_ids, '{}')) and g.organization_id = p.organization_id))
  select jsonb_build_object('total', count(*),
    'will_receive', count(*) filter (where not voice_opted_out and consent_status = 'consented'),
    'opted_out', count(*) filter (where voice_opted_out),
    'no_consent', count(*) filter (where not voice_opted_out and consent_status <> 'consented'))
  from m;
$$;

-- 8. Permissions: queue and provider-result functions are service role only; the preview is for signed-in staff.
revoke all on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text,text,int,int),
  public.claim_deliveries(text,int,int,int), public.apply_call_status(text,text,text,int,text), public.record_keypad_ack(uuid,text,text),
  public.record_delivery_result(uuid,text,text,text,text,text,int,int) from public, anon, authenticated;
grant execute on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text,text,int,int),
  public.claim_deliveries(text,int,int,int), public.apply_call_status(text,text,text,int,text), public.record_keypad_ack(uuid,text,text),
  public.record_delivery_result(uuid,text,text,text,text,text,int,int) to service_role;
revoke all on function public.preview_voice_audience(uuid[]) from public, anon;
grant execute on function public.preview_voice_audience(uuid[]) to authenticated;
