-- P17: Active SOS app alerts count in the roll-call, and their GPS comes with them.
-- * An "I'm safe" or "SOS" alert sent from the Active SOS app is recorded as an acknowledgement for the person's
--   most recent notification that asked for one (any channel), with the app's coordinates.
-- * The roll-call returns each person's latest location, so the screen can draw a map (red = SOS, green = safe).
-- Safe to run more than once. Nothing here changes how text, voice or desktop answers are recorded.

alter table public.acknowledgements add column if not exists source text not null default 'reply';
alter table public.acknowledgements add column if not exists gps_url text;
alter table public.acknowledgements drop constraint if exists acknowledgements_source_check;
alter table public.acknowledgements add constraint acknowledgements_source_check check (source in ('reply', 'app'));

-- 1. Record an app alert against the open event. Service role only (the webhook has already verified the sender).
create or replace function public.record_app_alert_ack(
  p_org uuid, p_person uuid, p_response text, p_text text, p_message_sid text default null,
  p_lat double precision default null, p_lng double precision default null, p_gps_url text default null,
  p_window_hours int default 72)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_ack uuid;
begin
  if p_response not in ('SAFE', 'SOS') then raise exception 'invalid response'; end if;
  -- Impossible coordinates are dropped; the response itself still counts.
  if p_lat is not null and (p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180) then
    p_lat := null; p_lng := null; p_gps_url := null;
  end if;

  -- The person's most recent notification that asked for an answer. They must have been part of it: a delivery that
  -- is not "skipped" (a skipped row that says "acknowledged" counts: an earlier answer cancelled it).
  select e.id into v_event
  from public.notification_events e
  where e.organization_id = p_org and e.requires_ack and e.status <> 'cancelled'
    and e.created_at > now() - make_interval(hours => greatest(1, least(p_window_hours, 720)))
    and exists (select 1 from public.notification_deliveries d
                 where d.event_id = e.id and d.person_id = p_person and (d.status <> 'skipped' or d.error_code = 'acknowledged'))
  order by e.created_at desc limit 1;
  if v_event is null then return jsonb_build_object('matched', false); end if;

  insert into public.acknowledgements (event_id, person_id, response, reply_text, provider_sid, received_at, lat, lng, gps_url, source)
  values (v_event, p_person, p_response, left(p_text, 1600), p_message_sid, clock_timestamp(), p_lat, p_lng, left(p_gps_url, 500), 'app')
  on conflict (event_id, provider_sid) where provider_sid is not null do nothing
  returning id into v_ack;
  if v_ack is null then return jsonb_build_object('matched', true, 'event_id', v_event, 'duplicate', true); end if;

  if p_response = 'SOS' then
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (p_org, null, 'sos_app_alert', 'notification_events', v_event::text,
            jsonb_build_object('person_id', p_person, 'has_location', p_lat is not null));
  end if;
  return jsonb_build_object('matched', true, 'event_id', v_event, 'ack_id', v_ack, 'duplicate', false, 'has_location', p_lat is not null);
end $$;
revoke all on function public.record_app_alert_ack(uuid, uuid, text, text, text, double precision, double precision, text, int) from public, anon, authenticated;
grant execute on function public.record_app_alert_ack(uuid, uuid, text, text, text, double precision, double precision, text, int) to service_role;

-- 2. Roll-call across channels. Same as before, plus each person's latest location and where the last answer came from.
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
           max(received_at) last_at, (array_agg(reply_text order by received_at desc))[1] last_text, count(*) reply_count,
           (array_agg(lat order by received_at desc) filter (where lat is not null))[1] as lat,
           (array_agg(lng order by received_at desc) filter (where lat is not null))[1] as lng,
           (array_agg(gps_url order by received_at desc) filter (where lat is not null))[1] as gps_url,
           (array_agg(source order by received_at desc))[1] as last_source
    from public.acknowledgements where event_id = p_event group by person_id),
  r as (
    select p.id as person_id, p.full_name, p.mobile_phone, d.status as delivery_status, d.error_code, d.channel as delivery_channel,
           a.last_at as responded_at, a.last_text, coalesce(a.reply_count, 0) as reply_count,
           a.lat, a.lng, a.gps_url, a.last_source,
           case when d.status = 'skipped' and a.last_at is null then 'not_contacted'
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
      'delivered', count(*) filter (where delivery_status in ('sent','delivered')),
      'located', count(*) filter (where lat is not null)),
    'people', coalesce(jsonb_agg(to_jsonb(r) order by case r.status when 'sos' then 0 when 'unaccounted' then 1 when 'pending' then 2
                                                  when 'replied' then 3 when 'safe' then 4 else 5 end, r.full_name), '[]'::jsonb))
    into v_out from r;
  return jsonb_build_object('event', v_event) || v_out;
end $$;
revoke all on function public.event_roll_call(uuid) from public, anon;
grant execute on function public.event_roll_call(uuid) to authenticated;
