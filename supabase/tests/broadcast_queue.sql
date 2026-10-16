-- Broadcast queue test (P5). One transaction, raises at the end so everything is rolled back. Every line should end "(ok)".
-- Run in the SQL editor (runs as an admin role, which can execute the service-role-only functions).
do $$
declare
  o uuid := gen_random_uuid(); g uuid; ev jsonb; ev2 jsonb; eid uuid;
  out text[] := '{}'; n int; r record; ok boolean; cnt int; total_sent int := 0; batch int; t0 timestamptz := clock_timestamp();
  someid uuid; somesid text;
begin
  insert into organizations (id,name,slug) values (o,'Bcast Test','bcast-test');
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id, full_name, mobile_phone, sms_opted_out)
    select o, 'P'||i, '+1555'||lpad(i::text,7,'0'), (i % 100 = 0) from generate_series(1,5000) i;
  insert into group_members (group_id, person_id) select g, id from people where organization_id = o;

  ev := public.create_notification_event(o,'drill','Test drill. Reply SAFE.',array[g],null,true,null,'idem-1');
  eid := (ev->>'event_id')::uuid;
  out := array_append(out, '1 queued/skipped: '||(ev->>'queued')||'/'||(ev->>'skipped')||case when (ev->>'queued')::int=4950 and (ev->>'skipped')::int=50 then ' (ok)' else ' (FAIL)' end);
  ev2 := public.create_notification_event(o,'drill','Test drill. Reply SAFE.',array[g],null,true,null,'idem-1');
  out := array_append(out, '2 same idempotency key deduplicated: '||(ev2->>'deduplicated')||case when (ev2->>'deduplicated')='true' and ev2->>'event_id'=eid::text then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from notification_deliveries where event_id = eid;
  out := array_append(out, '3 one delivery per person (expect 5000): '||n||case when n=5000 then ' (ok)' else ' (FAIL)' end);
  select recipient_count into n from notification_events where id = eid;
  out := array_append(out, '4 recipient_count (expect 5000): '||n||case when n=5000 then ' (ok)' else ' (FAIL)' end);

  create temp table claimedA on commit drop as select * from public.claim_deliveries('A',500,120);
  select count(*) into n from claimedA;
  out := array_append(out, '5 worker A claimed 500: '||n||case when n=500 then ' (ok)' else ' (FAIL)' end);
  for r in select * from claimedA limit 300 loop
    ok := public.record_delivery_result(r.delivery_id,'A','sent','SMA'||r.delivery_id::text);
    if ok then total_sent := total_sent + 1; end if;
  end loop;
  out := array_append(out, '6 A recorded 300 sent: '||total_sent||case when total_sent=300 then ' (ok)' else ' (FAIL)' end);

  select count(*) into n from public.claim_deliveries('B-probe',5000,120);
  select count(*) into cnt from notification_deliveries where event_id=eid and status='sending' and locked_by='A';
  out := array_append(out, '7 A in-flight rows protected by lease (still locked by A: expect 200): '||cnt||case when cnt=200 then ' (ok)' else ' (FAIL)' end);
  update notification_deliveries set status='queued', locked_by=null, attempt=attempt-1 where event_id=eid and locked_by='B-probe';

  update notification_deliveries set locked_at = now() - interval '10 minutes' where event_id=eid and locked_by='A' and status='sending';

  loop
    select count(*) into batch from (select * from public.claim_deliveries('B',500,120)) c;
    exit when batch = 0;
    update notification_deliveries set status='sent', provider_sid='SMB'||id::text, sent_at=now(), locked_by=null
      where event_id=eid and locked_by='B' and status='sending';
    perform public.refresh_event_status(eid);
  end loop;

  select id into someid from notification_deliveries where event_id=eid and attempt=2 limit 1;
  ok := public.record_delivery_result(someid,'A','sent','SMA-LATE');
  out := array_append(out, '8 stale worker cannot overwrite reclaimed row (expect false): '||ok||case when not ok then ' (ok)' else ' (FAIL)' end);

  select count(*) into n from notification_deliveries where event_id=eid and status='sent';
  out := array_append(out, '9 all 4950 eligible deliveries sent exactly once in the DB: '||n||case when n=4950 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from notification_deliveries where event_id=eid and status='skipped';
  out := array_append(out, '10 opted-out people skipped, never claimed (expect 50): '||n||case when n=50 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from notification_deliveries where event_id=eid and attempt=2;
  out := array_append(out, '11 crashed-worker rows retried once (expect 200): '||n||case when n=200 then ' (ok)' else ' (FAIL)' end);
  select status into somesid from notification_events where id=eid;
  out := array_append(out, '12 event complete: '||somesid||case when somesid='complete' then ' (ok)' else ' (FAIL)' end);

  ev := public.create_notification_event(o,'test','Retry test',array[g],null,true,null,'idem-2');
  eid := (ev->>'event_id')::uuid;
  select delivery_id into someid from public.claim_deliveries('R',1,120);
  ok := public.record_delivery_result(someid,'R','retry',null,'30008','carrier error',30,3);
  select status into somesid from notification_deliveries where id=someid;
  out := array_append(out, '13 transient failure goes back to queued with backoff: '||somesid||case when somesid='queued' and exists (select 1 from notification_deliveries where id=someid and next_attempt_at > now()) then ' (ok)' else ' (FAIL)' end);
  update notification_deliveries set status='sending', locked_by='R', attempt=3 where id=someid;
  ok := public.record_delivery_result(someid,'R','retry',null,'30008','carrier error',30,3);
  select status into somesid from notification_deliveries where id=someid;
  out := array_append(out, '14 third failed attempt becomes failed: '||somesid||case when somesid='failed' then ' (ok)' else ' (FAIL)' end);

  select id, provider_sid into someid, somesid from notification_deliveries where event_id=(select id from notification_events where idempotency_key='idem-1' and organization_id=o) and status='sent' limit 1;
  ok := public.apply_delivery_status(somesid,'delivered');
  out := array_append(out, '15 sent -> delivered: '||ok||case when ok then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_delivery_status(somesid,'sent');
  out := array_append(out, '16 late "sent" cannot overwrite delivered (expect false): '||ok||case when not ok then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_delivery_status('NOPE','delivered');
  out := array_append(out, '17 unknown message id ignored (expect false): '||ok||case when not ok then ' (ok)' else ' (FAIL)' end);

  begin
    perform public.create_notification_event(gen_random_uuid(),'test','x',array[g],null);
    out := array_append(out, '18 groups from another org accepted (FAIL)');
  exception when others then out := array_append(out, '18 groups from another org rejected (ok)'); end;

  out := array_append(out, 'elapsed ms: '||round(extract(epoch from clock_timestamp()-t0)*1000));
  raise exception E'BROADCAST QUEUE TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
