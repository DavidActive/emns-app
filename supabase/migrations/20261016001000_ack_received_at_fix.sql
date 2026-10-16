-- P7 fix: two replies from the same person inside one transaction got the same received_at (now() is fixed per
-- transaction) and hit the old unique (event_id, person_id, received_at) constraint. Use the real clock time, and drop
-- that constraint: duplicate Twilio retries are already prevented by the unique (event_id, provider_sid) index.
alter table public.acknowledgements drop constraint if exists acknowledgements_event_id_person_id_received_at_key;

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

  insert into public.acknowledgements (event_id, person_id, response, reply_text, provider_sid, received_at)
  values (v_event, p_person, p_response, left(p_text, 1600), p_message_sid, clock_timestamp())
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
