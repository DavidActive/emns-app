-- P5 broadcast engine: recipient resolution, queue claiming, result recording, delivery status callbacks.
-- Applied to the emns project as migration "broadcast_engine". Functions are callable by the service role only.
-- All functions are callable by the service role only (Netlify functions); browsers never call them.

-- 1. Columns the engine needs
alter table public.notification_events
  add column if not exists body text,
  add column if not exists group_ids uuid[] not null default '{}',
  add column if not exists idempotency_key text,
  add column if not exists recipient_count int not null default 0;
create unique index if not exists notification_events_idem_idx
  on public.notification_events (organization_id, idempotency_key) where idempotency_key is not null;

alter table public.notification_deliveries
  add column if not exists sent_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists error_message text;
-- A person in several selected groups gets exactly one delivery per channel.
create unique index if not exists deliveries_person_channel_idx
  on public.notification_deliveries (event_id, person_id, channel);

-- 2. Create an event and resolve recipients server-side from groups.
create or replace function public.create_notification_event(
  p_org uuid, p_kind text, p_body text, p_group_ids uuid[], p_created_by uuid,
  p_requires_ack boolean default true, p_scenario uuid default null, p_idempotency_key text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_queued int; v_skipped int; v_found int;
begin
  if p_kind not in ('alert','drill','test') then raise exception 'invalid kind'; end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 1600 then raise exception 'body must be 1-1600 characters'; end if;
  if p_group_ids is null or coalesce(array_length(p_group_ids,1),0) = 0 then raise exception 'select at least one group'; end if;
  select count(*) into v_found from public.groups where organization_id = p_org and id = any(p_group_ids);
  if v_found <> cardinality(p_group_ids) then raise exception 'one or more groups do not belong to this organization'; end if;

  if p_idempotency_key is not null then
    select id into v_event from public.notification_events where organization_id = p_org and idempotency_key = p_idempotency_key;
    if v_event is not null then return jsonb_build_object('event_id', v_event, 'deduplicated', true); end if;
  end if;

  insert into public.notification_events (organization_id, scenario_id, kind, status, requires_ack, created_by, body, group_ids, idempotency_key)
  values (p_org, p_scenario, p_kind, 'sending', p_requires_ack, p_created_by, p_body, p_group_ids, p_idempotency_key)
  returning id into v_event;

  insert into public.notification_deliveries (event_id, organization_id, person_id, channel, status, error_code)
  select v_event, p_org, p.id, 'sms',
         case when p.sms_opted_out then 'skipped' else 'queued' end,
         case when p.sms_opted_out then 'opted_out' end
  from public.people p
  where p.organization_id = p_org and p.is_active
    and exists (select 1 from public.group_members gm where gm.person_id = p.id and gm.group_id = any(p_group_ids))
  on conflict (event_id, person_id, channel) do nothing;

  select count(*) filter (where status = 'queued'), count(*) filter (where status = 'skipped')
    into v_queued, v_skipped from public.notification_deliveries where event_id = v_event;
  update public.notification_events set recipient_count = v_queued + v_skipped,
         status = case when v_queued = 0 then 'complete' else 'sending' end, sent_at = now() where id = v_event;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p_org, p_created_by, 'event_created', 'notification_events', v_event::text,
          jsonb_build_object('kind', p_kind, 'groups', p_group_ids, 'queued', v_queued, 'skipped_opted_out', v_skipped));
  return jsonb_build_object('event_id', v_event, 'deduplicated', false, 'queued', v_queued, 'skipped', v_skipped);
end $$;

-- 3. Claim a batch for a worker. SKIP LOCKED lets many workers run safely. Rows left in 'sending' past the lease
--    (a crashed worker) become claimable again.
create or replace function public.claim_deliveries(p_worker text, p_limit int default 50, p_lease_seconds int default 120)
returns table (delivery_id uuid, event_id uuid, organization_id uuid, person_id uuid, to_number text, body text, attempt int)
language sql security invoker set search_path = public, pg_temp as $$
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
    returning d.id, d.event_id, d.organization_id, d.person_id, d.attempt)
  select upd.id, upd.event_id, upd.organization_id, upd.person_id, p.mobile_phone, e.body, upd.attempt
  from upd join public.people p on p.id = upd.person_id join public.notification_events e on e.id = upd.event_id;
$$;

-- 4. Record the outcome. Only the worker that holds the claim may write it (fencing), so a slow worker cannot
--    overwrite a reclaimed row. Transient failures retry with backoff up to p_max_attempts.
create or replace function public.record_delivery_result(
  p_delivery uuid, p_worker text, p_outcome text, p_sid text default null,
  p_error_code text default null, p_error_message text default null,
  p_retry_in_seconds int default 30, p_max_attempts int default 3)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_attempt int; v_event uuid; v_rows int;
begin
  select attempt, event_id into v_attempt, v_event from public.notification_deliveries
   where id = p_delivery and locked_by = p_worker and status = 'sending';
  if not found then return false; end if;
  if p_outcome = 'sent' then
    update public.notification_deliveries set status = 'sent', provider_sid = p_sid, sent_at = now(), updated_at = now(), locked_by = null where id = p_delivery;
  elsif p_outcome = 'retry' and v_attempt < p_max_attempts then
    update public.notification_deliveries set status = 'queued', next_attempt_at = now() + make_interval(secs => p_retry_in_seconds * v_attempt),
           error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now(), locked_by = null where id = p_delivery;
  else
    update public.notification_deliveries set status = 'failed', error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now(), locked_by = null where id = p_delivery;
  end if;
  perform public.refresh_event_status(v_event);
  return true;
end $$;

create or replace function public.refresh_event_status(p_event uuid) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update public.notification_events e set status = 'complete'
   where e.id = p_event and e.status = 'sending'
     and not exists (select 1 from public.notification_deliveries d where d.event_id = e.id and d.status in ('queued','sending'));
$$;

-- 5. Carrier status callbacks. Status only moves forward, so a late "sent" never overwrites "delivered".
create or replace function public.apply_delivery_status(p_sid text, p_status text, p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare rank_new int; rank_old int; cur text; d_id uuid;
begin
  rank_new := case p_status when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 when 'undelivered' then 4 when 'failed' then 4 when 'delivered' then 5 else 0 end;
  if rank_new = 0 then return false; end if;
  select id, status into d_id, cur from public.notification_deliveries where provider_sid = p_sid;
  if not found then return false; end if;
  rank_old := case cur when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 when 'undelivered' then 4 when 'failed' then 4 when 'delivered' then 5 else 0 end;
  if rank_new <= rank_old and not (cur = 'sending' and rank_new >= 3) then return false; end if;
  update public.notification_deliveries set status = p_status, error_code = coalesce(p_error_code, error_code),
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end, updated_at = now() where id = d_id;
  return true;
end $$;

-- 6. Service role only.
revoke all on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text),
  public.claim_deliveries(text,int,int), public.record_delivery_result(uuid,text,text,text,text,text,int,int),
  public.refresh_event_status(uuid), public.apply_delivery_status(text,text,text) from public, anon, authenticated;
grant execute on function public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text),
  public.claim_deliveries(text,int,int), public.record_delivery_result(uuid,text,text,text,text,text,int,int),
  public.refresh_event_status(uuid), public.apply_delivery_status(text,text,text) to service_role;
