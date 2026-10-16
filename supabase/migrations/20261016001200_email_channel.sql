-- P9: email channel. Additive. Review before applying.
-- * Email is a second channel on the same queue. Email has its own opt-out and bounce suppression (not SMS consent).
-- * An event can send "together" (every channel at once) or "fallback" (first channel now; the next channel is HELD and
--   released only if the earlier channel fails, undelivers or bounces).
-- * The roll-call now looks across channels per person; for text-only events it returns exactly what it did before.

-- 1. Columns
alter table public.people
  add column if not exists email_opted_out boolean not null default false,
  add column if not exists email_opted_out_at timestamptz,
  add column if not exists email_bounced_at timestamptz;

alter table public.notification_events
  add column if not exists channels text[] not null default array['sms']::text[],
  add column if not exists channel_mode text not null default 'together',
  add column if not exists email_subject text,
  add column if not exists email_body text;
alter table public.notification_events drop constraint if exists notification_events_channel_mode_check;
alter table public.notification_events add constraint notification_events_channel_mode_check check (channel_mode in ('together','fallback'));

alter table public.notification_deliveries drop constraint if exists notification_deliveries_status_check;
alter table public.notification_deliveries add constraint notification_deliveries_status_check
  check (status in ('queued','sending','sent','delivered','undelivered','failed','skipped','held'));

-- 2. Why an email address cannot be used (null = it can).
create or replace function public.email_skip_reason(p_email text, p_opted_out boolean, p_bounced timestamptz)
returns text language sql immutable as $$
  select case when p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then 'no_email'
              when p_opted_out then 'opted_out'
              when p_bounced is not null then 'bounced' end;
$$;

-- 3. Create an event. Same behavior as before for text-only; new optional channel arguments.
drop function if exists public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text);
create or replace function public.create_notification_event(
  p_org uuid, p_kind text, p_body text, p_group_ids uuid[], p_created_by uuid,
  p_requires_ack boolean default true, p_scenario uuid default null, p_idempotency_key text default null,
  p_channels text[] default array['sms']::text[], p_mode text default 'together',
  p_email_subject text default null, p_email_body text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_queued int; v_held int; v_opted int; v_nocons int; v_found int; v_people int; v_by jsonb;
begin
  if p_kind not in ('alert','drill','test') then raise exception 'invalid kind'; end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 1600 then raise exception 'body must be 1-1600 characters'; end if;
  if p_group_ids is null or coalesce(array_length(p_group_ids,1),0) = 0 then raise exception 'select at least one group'; end if;
  if p_channels is null or cardinality(p_channels) = 0
     or exists (select 1 from unnest(p_channels) c where c not in ('sms','email'))
     or cardinality(p_channels) <> (select count(distinct c) from unnest(p_channels) c) then
    raise exception 'invalid channels';
  end if;
  if p_mode not in ('together','fallback') then raise exception 'invalid mode'; end if;
  if 'email' = any(p_channels) then
    if p_email_subject is null or btrim(p_email_subject) = '' or length(p_email_subject) > 200 then raise exception 'email subject must be 1-200 characters'; end if;
    if p_email_body is not null and length(p_email_body) > 10000 then raise exception 'email body too long'; end if;
  end if;
  select count(*) into v_found from public.groups where organization_id = p_org and id = any(p_group_ids);
  if v_found <> cardinality(p_group_ids) then raise exception 'one or more groups do not belong to this organization'; end if;

  if p_idempotency_key is not null then
    select id into v_event from public.notification_events where organization_id = p_org and idempotency_key = p_idempotency_key;
    if v_event is not null then return jsonb_build_object('event_id', v_event, 'deduplicated', true); end if;
  end if;

  insert into public.notification_events (organization_id, scenario_id, kind, status, requires_ack, created_by, body, group_ids, idempotency_key,
                                          channels, channel_mode, email_subject, email_body)
  values (p_org, p_scenario, p_kind, 'sending', p_requires_ack, p_created_by, p_body, p_group_ids, p_idempotency_key,
          p_channels, p_mode, case when 'email' = any(p_channels) then btrim(p_email_subject) end,
          case when 'email' = any(p_channels) then p_email_body end)
  returning id into v_event;

  insert into public.notification_deliveries (event_id, organization_id, person_id, channel, status, error_code)
  with cand as (
    select p.id as person_id, c.ch, c.ord,
           case c.ch when 'sms' then case when p.sms_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
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

-- 4. Fall-through: release the person's next held channel when an earlier one has failed.
create or replace function public.release_held(p_event uuid, p_person uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if exists (select 1 from public.notification_deliveries
              where event_id = p_event and person_id = p_person and status in ('queued','sending','sent','delivered')) then
    return false; -- another channel is still working or already reached them
  end if;
  select d.id into v_id from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
   where d.event_id = p_event and d.person_id = p_person and d.status = 'held'
   order by array_position(e.channels, d.channel) limit 1 for update of d;
  if v_id is null then return false; end if;
  update public.notification_deliveries set status = 'queued', next_attempt_at = now(), updated_at = now() where id = v_id;
  update public.notification_events set status = 'sending' where id = p_event and status = 'complete';
  return true;
end $$;

-- 5. Claiming: now returns the channel and the destination for it; email rows are re-checked for opt-out/bounce.
drop function if exists public.claim_deliveries(text,int,int);
create or replace function public.claim_deliveries(p_worker text, p_limit int default 50, p_lease_seconds int default 120)
returns table (delivery_id uuid, event_id uuid, organization_id uuid, person_id uuid, channel text, to_number text, to_email text,
               subject text, body text, attempt int)
language plpgsql security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_events uuid[] := '{}'; g record;
begin
  -- Anyone who opted out, lost consent, or whose address bounced since the event was created is skipped, never contacted.
  for g in
    with gone as (
      update public.notification_deliveries d
         set status = 'skipped', locked_by = null, updated_at = now(),
             error_code = case d.channel when 'sms' then case when p.sms_opted_out then 'opted_out' else 'no_consent' end
                                         else public.email_skip_reason(p.email, p.email_opted_out, p.email_bounced_at) end
        from public.people p
       where p.id = d.person_id
         and ((d.channel = 'sms' and (p.sms_opted_out or p.consent_status <> 'consented'))
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

  return query
  with picked as (
    select d.id from public.notification_deliveries d
    where (d.status = 'queued' and d.next_attempt_at <= now())
       or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds))
    order by d.next_attempt_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked),
  upd as (
    update public.notification_deliveries d
       set status = 'sending', locked_by = p_worker, locked_at = now(), attempt = d.attempt + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.event_id, d.organization_id, d.person_id, d.channel, d.attempt)
  select upd.id, upd.event_id, upd.organization_id, upd.person_id, upd.channel,
         case when upd.channel = 'sms' then pp.mobile_phone end,
         case when upd.channel = 'email' then pp.email end,
         case when upd.channel = 'email' then e.email_subject end,
         case when upd.channel = 'email' then coalesce(e.email_body, e.body) else e.body end,
         upd.attempt
  from upd join public.people pp on pp.id = upd.person_id join public.notification_events e on e.id = upd.event_id;
end $$;

-- 6. Recording results: a final failure releases the next held channel.
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
    update public.notification_deliveries set status = 'sent', provider_sid = p_sid, sent_at = now(), updated_at = now(), locked_by = null where id = p_delivery;
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

-- 7. Status callbacks (SMS and email): status only moves forward; a failure releases the next held channel.
create or replace function public.apply_delivery_status(p_sid text, p_status text, p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare rank_new int; rank_old int; cur text; d_id uuid; d_event uuid; d_person uuid;
begin
  rank_new := case p_status when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 when 'undelivered' then 4 when 'failed' then 4 when 'delivered' then 5 else 0 end;
  if rank_new = 0 then return false; end if;
  select id, status, event_id, person_id into d_id, cur, d_event, d_person from public.notification_deliveries where provider_sid = p_sid;
  if not found then return false; end if;
  rank_old := case cur when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 when 'undelivered' then 4 when 'failed' then 4 when 'delivered' then 5 else 0 end;
  if rank_new <= rank_old and not (cur = 'sending' and rank_new >= 3) then return false; end if;
  update public.notification_deliveries set status = p_status, error_code = coalesce(p_error_code, error_code),
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end, updated_at = now() where id = d_id;
  if p_status in ('failed','undelivered') then
    perform public.release_held(d_event, d_person);
    perform public.refresh_event_status(d_event);
  end if;
  return true;
end $$;

-- 8. Email provider events (delivered, bounced, complained...). Hard bounces suppress the address; complaints opt the person out of email.
create or replace function public.record_email_event(p_sid text, p_type text, p_bounce_type text default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare d record; v_ok boolean := false;
begin
  select id, person_id into d from public.notification_deliveries where provider_sid = p_sid and channel = 'email';
  if not found then return false; end if;
  if p_type = 'email.delivered' then
    return public.apply_delivery_status(p_sid, 'delivered', null);
  elsif p_type = 'email.bounced' then
    v_ok := public.apply_delivery_status(p_sid, 'failed', 'bounced_' || lower(coalesce(p_bounce_type, 'unknown')));
    if lower(coalesce(p_bounce_type, '')) = 'permanent' then
      update public.people set email_bounced_at = now() where id = d.person_id and email_bounced_at is null;
    end if;
    return v_ok;
  elsif p_type = 'email.complained' then
    update public.people set email_opted_out = true, email_opted_out_at = now() where id = d.person_id and not email_opted_out;
    return true;
  elsif p_type in ('email.failed', 'email.suppressed') then
    return public.apply_delivery_status(p_sid, 'failed', replace(p_type, '.', '_'));
  end if;
  return false;
end $$;

-- 9. Compose-screen preview of who has a usable email address.
create or replace function public.preview_email_audience(p_group_ids uuid[])
returns jsonb language sql stable set search_path = public, private, pg_temp as $$
  with m as (
    select public.email_skip_reason(p.email, p.email_opted_out, p.email_bounced_at) as reason
    from public.people p
    where p.organization_id = private.current_org_id() and p.is_active
      and exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  where gm.person_id = p.id and gm.group_id = any(coalesce(p_group_ids, '{}')) and g.organization_id = p.organization_id))
  select jsonb_build_object('total', count(*), 'will_receive', count(*) filter (where reason is null),
         'no_email', count(*) filter (where reason = 'no_email'), 'opted_out', count(*) filter (where reason = 'opted_out'),
         'bounced', count(*) filter (where reason = 'bounced'))
  from m;
$$;

-- 10. Roll-call across channels (per person: delivered > sent > in flight > held > failed > skipped).
create or replace function public.event_roll_call(p_event uuid)
returns jsonb language plpgsql stable security invoker set search_path = public, private, pg_temp as $$
declare v_event jsonb; v_out jsonb;
begin
  select to_jsonb(x) into v_event from (
    select e.id, e.kind, e.status, e.body, e.requires_ack, e.created_at, e.sent_at
    from public.notification_events e
    where e.id = p_event and (e.organization_id = private.current_org_id() or private.is_platform_admin())) x;
  if v_event is null then return null; end if;

  with a as (
    select person_id, bool_or(response = 'SOS') has_sos, bool_or(response = 'SAFE') has_safe, bool_or(response = 'TEXT') has_text,
           max(received_at) last_at, (array_agg(reply_text order by received_at desc))[1] last_text, count(*) reply_count
    from public.acknowledgements where event_id = p_event group by person_id),
  r as (
    select p.id as person_id, p.full_name, p.mobile_phone, d.status as delivery_status, d.error_code, d.channel as delivery_channel,
           a.last_at as responded_at, a.last_text, coalesce(a.reply_count, 0) as reply_count,
           case when d.status = 'skipped' then 'not_contacted'
                when a.has_sos then 'sos' when a.has_safe then 'safe' when a.has_text then 'replied'
                when d.status in ('queued','sending','held') then 'pending'
                else 'unaccounted' end as status
    from (select distinct person_id from public.notification_deliveries where event_id = p_event) x
    join public.people p on p.id = x.person_id
    cross join lateral (
      select dd.status, dd.error_code, dd.channel from public.notification_deliveries dd
       where dd.event_id = p_event and dd.person_id = p.id
       order by case dd.status when 'delivered' then 1 when 'sent' then 2 when 'sending' then 3 when 'queued' then 3 when 'held' then 4
                               when 'undelivered' then 5 when 'failed' then 5 else 6 end,
                case dd.channel when 'sms' then 0 else 1 end
       limit 1) d
    left join a on a.person_id = p.id)
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'targeted', count(*) filter (where status <> 'not_contacted'),
      'safe', count(*) filter (where status = 'safe'),
      'sos', count(*) filter (where status = 'sos'),
      'replied', count(*) filter (where status = 'replied'),
      'responded', count(*) filter (where status in ('safe','sos','replied')),
      'unaccounted', count(*) filter (where status = 'unaccounted'),
      'undeliverable', count(*) filter (where status = 'unaccounted' and delivery_status in ('failed','undelivered')),
      'pending', count(*) filter (where status = 'pending'),
      'not_contacted', count(*) filter (where status = 'not_contacted'),
      'delivered', count(*) filter (where delivery_status in ('sent','delivered'))),
    'people', coalesce(jsonb_agg(to_jsonb(r) order by case r.status when 'sos' then 0 when 'unaccounted' then 1 when 'pending' then 2
                                                  when 'replied' then 3 when 'safe' then 4 else 5 end, r.full_name), '[]'::jsonb))
    into v_out from r;
  return jsonb_build_object('event', v_event) || v_out;
end $$;

-- 11. After-action report: per-person timing stays text-based; held rows are not counted as texts.
create or replace function public.event_after_action(p_event uuid)
returns jsonb language plpgsql stable security invoker set search_path = public, private, pg_temp as $$
declare rc jsonb; v_t0 timestamptz; v_out jsonb;
begin
  rc := public.event_roll_call(p_event);
  if rc is null then return null; end if;
  v_t0 := (rc->'event'->>'created_at')::timestamptz;

  with pp as (
    select (x.obj->>'person_id')::uuid as person_id, x.obj->>'status' as status, x.ord
    from jsonb_array_elements(rc->'people') with ordinality as x(obj, ord)),
  dl as (
    select d.person_id, d.status, d.sent_at, d.delivered_at,
           greatest(extract(epoch from (d.delivered_at - v_t0)), 0) as secs
    from public.notification_deliveries d
    where d.event_id = p_event and d.channel = 'sms' and d.status not in ('skipped','held')),
  dc as (
    select dl.*,
           case when dl.delivered_at is not null then
                  case when dl.secs < 60 then 'lt_1m' when dl.secs < 120 then 'm1_2' when dl.secs < 300 then 'm2_5'
                       when dl.secs < 600 then 'm5_10' else 'gt_10m' end
                when dl.status in ('failed', 'undelivered') then 'failed'
                when dl.status in ('queued', 'sending') then 'pending'
                else 'no_receipt' end as b
    from dl),
  ak as (
    select a.person_id, min(a.received_at) as first_at, max(a.received_at) as last_at,
           greatest(extract(epoch from (min(a.received_at) - v_t0)), 0) as secs
    from public.acknowledgements a where a.event_id = p_event group by a.person_id),
  ac as (
    select ak.*,
           case when ak.secs < 60 then 'lt_1m' when ak.secs < 120 then 'm1_2' when ak.secs < 300 then 'm2_5'
                when ak.secs < 600 then 'm5_10' else 'gt_10m' end as b
    from ak join pp on pp.person_id = ak.person_id
    where pp.status in ('safe', 'sos', 'replied'))
  select jsonb_build_object(
    'timeline', jsonb_build_object(
      'event_created_at', v_t0,
      'first_sent_at', (select min(sent_at) from dl),
      'last_sent_at', (select max(sent_at) from dl),
      'first_delivered_at', (select min(delivered_at) from dl),
      'last_delivered_at', (select max(delivered_at) from dl),
      'first_reply_at', (select min(first_at) from ac),
      'last_reply_at', (select max(last_at) from ac),
      'first_sos_at', (select min(a.received_at) from public.acknowledgements a where a.event_id = p_event and a.response = 'SOS')),
    'delivery', jsonb_build_object(
      'buckets', jsonb_build_object(
        'lt_1m', (select count(*) from dc where b = 'lt_1m'), 'm1_2', (select count(*) from dc where b = 'm1_2'),
        'm2_5', (select count(*) from dc where b = 'm2_5'), 'm5_10', (select count(*) from dc where b = 'm5_10'),
        'gt_10m', (select count(*) from dc where b = 'gt_10m'), 'no_receipt', (select count(*) from dc where b = 'no_receipt'),
        'failed', (select count(*) from dc where b = 'failed'), 'pending', (select count(*) from dc where b = 'pending')),
      'seconds', jsonb_build_object(
        'p50', (select round(percentile_cont(0.5) within group (order by secs)::numeric, 1) from dc where delivered_at is not null),
        'p90', (select round(percentile_cont(0.9) within group (order by secs)::numeric, 1) from dc where delivered_at is not null),
        'max', (select round(max(secs)::numeric, 1) from dc where delivered_at is not null))),
    'acknowledgement', jsonb_build_object(
      'buckets', jsonb_build_object(
        'lt_1m', (select count(*) from ac where b = 'lt_1m'), 'm1_2', (select count(*) from ac where b = 'm1_2'),
        'm2_5', (select count(*) from ac where b = 'm2_5'), 'm5_10', (select count(*) from ac where b = 'm5_10'),
        'gt_10m', (select count(*) from ac where b = 'gt_10m')),
      'seconds', jsonb_build_object(
        'p50', (select round(percentile_cont(0.5) within group (order by secs)::numeric, 1) from ac),
        'p90', (select round(percentile_cont(0.9) within group (order by secs)::numeric, 1) from ac),
        'max', (select round(max(secs)::numeric, 1) from ac))),
    'channels', (select coalesce(jsonb_agg(jsonb_build_object('channel', c.channel, 'status', c.status, 'count', c.n) order by c.channel, c.status), '[]'::jsonb)
                 from (select channel, status, count(*) as n from public.notification_deliveries
                       where event_id = p_event group by channel, status) c),
    'people', (select coalesce(jsonb_agg(pp2.obj || jsonb_build_object(
                       'sent_at', dl.sent_at, 'delivered_at', dl.delivered_at, 'first_reply_at', ak.first_at,
                       'seconds_to_deliver', case when dl.delivered_at is null then null else round(dl.secs::numeric, 1) end,
                       'seconds_to_first_reply', round(ak.secs::numeric, 1)) order by pp2.ord), '[]'::jsonb)
               from (select x.obj, x.ord, (x.obj->>'person_id')::uuid as person_id
                     from jsonb_array_elements(rc->'people') with ordinality as x(obj, ord)) pp2
               left join dl on dl.person_id = pp2.person_id
               left join ak on ak.person_id = pp2.person_id)
  ) into v_out;

  return jsonb_build_object(
    'event', (rc->'event') || jsonb_build_object(
      'sent_by', (select o.full_name from public.notification_events e left join public.operators o on o.id = e.created_by where e.id = p_event),
      'groups', (select coalesce(jsonb_agg(g.name order by g.name), '[]'::jsonb) from public.groups g
                 where g.id = any (coalesce((select e.group_ids from public.notification_events e where e.id = p_event), '{}'::uuid[])))),
    'counts', rc->'counts',
    'generated_at', now()) || v_out;
end $$;
revoke all on function public.event_after_action(uuid) from public, anon;
grant execute on function public.event_after_action(uuid) to authenticated;

-- 12. Permissions. Queue and provider-event functions are service role only, like the rest of the engine.
revoke all on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text),
  public.claim_deliveries(text,int,int), public.release_held(uuid,uuid), public.record_email_event(text,text,text),
  public.record_delivery_result(uuid,text,text,text,text,text,int,int), public.apply_delivery_status(text,text,text) from public, anon, authenticated;
grant execute on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text,text[],text,text,text),
  public.claim_deliveries(text,int,int), public.release_held(uuid,uuid), public.record_email_event(text,text,text),
  public.record_delivery_result(uuid,text,text,text,text,text,int,int), public.apply_delivery_status(text,text,text) to service_role;
revoke all on function public.preview_email_audience(uuid[]) from public, anon;
grant execute on function public.preview_email_audience(uuid[]) to authenticated;
grant execute on function public.email_skip_reason(text,boolean,timestamptz) to authenticated, service_role;
