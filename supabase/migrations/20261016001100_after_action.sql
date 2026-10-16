-- P8: after-action report data for one event. Additive. Review before applying.
-- One function feeds BOTH the on-screen report and the CSV, so the counts cannot disagree.
-- The headline counts are taken straight from event_roll_call (the P7 roll-call), unchanged.
-- SECURITY INVOKER: row-level security keeps every caller inside their own organization.
--
-- Definitions (the report page prints the same wording):
--   t0 = when the operator confirmed the send (notification_events.created_at).
--   time to deliver = carrier delivery receipt time minus t0. Texts with no receipt are counted separately.
--   time to acknowledge = a person's FIRST reply minus t0.
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
    where d.event_id = p_event and d.channel = 'sms' and d.status <> 'skipped'),
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
