-- P7: replies, acknowledgements, roll-call. Additive. Review before applying.
-- 1. acknowledgements: raw reply text, provider message id (so a Twilio retry never double-counts), allowed responses.
alter table public.acknowledgements add column if not exists reply_text text;
alter table public.acknowledgements add column if not exists provider_sid text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'acknowledgements_response_check') then
    alter table public.acknowledgements add constraint acknowledgements_response_check check (response in ('SAFE','SOS','TEXT'));
  end if;
end $$;
create unique index if not exists acknowledgements_sid_uq on public.acknowledgements (event_id, provider_sid) where provider_sid is not null;
create index if not exists acknowledgements_event_person_idx on public.acknowledgements (event_id, person_id);
create index if not exists notification_events_org_created_idx on public.notification_events (organization_id, created_at desc);

-- 2. Match a plain reply to the person's most recent notification that (a) asked for an acknowledgement and
--    (b) was actually sent to them, within the window. Service role only (called by the webhook).
create or replace function public.record_acknowledgement(
  p_org uuid, p_person uuid, p_response text, p_text text, p_message_sid text default null, p_window_hours int default 72)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_ack uuid;
begin
  if p_response not in ('SAFE','SOS','TEXT') then raise exception 'invalid response'; end if;
  select e.id into v_event
  from public.notification_events e
  join public.notification_deliveries d on d.event_id = e.id and d.person_id = p_person and d.channel = 'sms'
       and d.status in ('sent','delivered','undelivered')
  where e.organization_id = p_org and e.requires_ack and e.status <> 'cancelled'
    and e.created_at > now() - make_interval(hours => greatest(1, least(p_window_hours, 720)))
  order by e.created_at desc limit 1;
  if v_event is null then return jsonb_build_object('matched', false); end if;

  insert into public.acknowledgements (event_id, person_id, response, reply_text, provider_sid)
  values (v_event, p_person, p_response, left(p_text, 1600), p_message_sid)
  on conflict (event_id, provider_sid) where provider_sid is not null do nothing
  returning id into v_ack;
  if v_ack is null then return jsonb_build_object('matched', true, 'event_id', v_event, 'duplicate', true); end if;

  -- A reply proves the text arrived, even if the carrier receipt is late or missing.
  update public.notification_deliveries set status = 'delivered', updated_at = now()
   where event_id = v_event and person_id = p_person and channel = 'sms' and status in ('sent','undelivered');
  if p_response = 'SOS' then
    insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
    values (p_org, null, 'sos_reply', 'notification_events', v_event::text, jsonb_build_object('person_id', p_person));
  end if;
  return jsonb_build_object('matched', true, 'event_id', v_event, 'ack_id', v_ack, 'duplicate', false);
end $$;
revoke all on function public.record_acknowledgement(uuid, uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.record_acknowledgement(uuid, uuid, text, text, text, int) to service_role;

-- 3. Roll-call for one event. SECURITY INVOKER so RLS keeps it inside the caller's organization.
--    Per person: sos (any SOS reply, sticky) > safe > replied (free text) > unaccounted (sent, no reply)
--    > pending (still being sent) ; not_contacted = skipped (no consent / opted out).
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
    select p.id as person_id, p.full_name, p.mobile_phone, d.status as delivery_status, d.error_code,
           a.last_at as responded_at, a.last_text, coalesce(a.reply_count, 0) as reply_count,
           case when d.status = 'skipped' then 'not_contacted'
                when a.has_sos then 'sos' when a.has_safe then 'safe' when a.has_text then 'replied'
                when d.status in ('queued','sending') then 'pending'
                else 'unaccounted' end as status
    from public.notification_deliveries d
    join public.people p on p.id = d.person_id
    left join a on a.person_id = d.person_id
    where d.event_id = p_event and d.channel = 'sms')
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
revoke all on function public.event_roll_call(uuid) from public, anon;
grant execute on function public.event_roll_call(uuid) to authenticated;
