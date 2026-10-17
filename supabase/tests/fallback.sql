-- P11 fallback sequencing test. Run AFTER migration 20261016001400_fallback_sequencing.sql. Everything is rolled back (it ends with a deliberate error).
-- Every line should end "(ok)".
do $$
declare
  o uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  g uuid; op uuid; r jsonb; ev uuid; p1 uuid; p2 uuid; p3 uuid; ok boolean; n int; did uuid; st text;
  out text[] := '{}';
begin
  insert into auth.users (id,email) values (u,'fb-a@test.invalid');
  insert into organizations (id,name,slug) values (o,'FB A','fb-a-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P1','+15552000001','p1@test.invalid','consented') returning id into p1;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P2','+15552000002','p2@test.invalid','consented') returning id into p2;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P3','+15552000003','p3@test.invalid','consented') returning id into p3;
  insert into group_members (group_id,person_id) values (g,p1),(g,p2),(g,p3);

  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] f.',array[g],op,true,null,'fb-1',array['sms','email'],'fallback','Drill','Drill body',null,2,60);
  ev := (r->>'event_id')::uuid;
  update public.notification_events set fallback_after_seconds = 300 where id = ev;
  select count(*) into n from public.notification_deliveries where event_id=ev and channel='sms' and status='queued';
  out := array_append(out, '1 channel 1 (text) queued for all 3: '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.notification_deliveries where event_id=ev and channel='email' and status='held';
  out := array_append(out, '2 channel 2 (email) held for all 3: '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);

  create temp table c1 on commit drop as select * from public.claim_deliveries('w1', 50, 120, 0);
  -- P1: channel 1 fails -> channel 2 attempted right away
  select delivery_id into did from c1 where person_id=p1;
  ok := public.record_delivery_result(did,'w1','failed',null,'30003','unreachable');
  select count(*) into n from public.notification_deliveries where event_id=ev and person_id=p1 and channel='email' and status='queued' and next_attempt_at <= now() + interval '5 minutes';
  out := array_append(out, '3 text fails: the email is queued and due within the delay: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.event_timeline where event_id=ev and person_id=p1 and kind='fallback_released' and detail='earlier channel failed';
  out := array_append(out, '4 timeline records the release and its reason: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  -- P2: text delivered, no answer
  select delivery_id into did from c1 where person_id=p2; ok := public.record_delivery_result(did,'w1','sent','SM2');
  ok := public.apply_delivery_status('SM2','delivered');
  n := public.escalate_unacknowledged();
  out := array_append(out, '5 delivered but not yet overdue: nothing escalated: '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  -- P3: text delivered, then answers
  select delivery_id into did from c1 where person_id=p3; ok := public.record_delivery_result(did,'w1','sent','SM3');
  ok := public.apply_delivery_status('SM3','delivered');
  insert into public.acknowledgements (event_id, person_id, response) values (ev, p3, 'SAFE');
  select status||'.'||coalesce(error_code,'') into st from public.notification_deliveries where event_id=ev and person_id=p3 and channel='email';
  out := array_append(out, '6 acknowledged: the later channel is cancelled: '||st||case when st='skipped.acknowledged' then ' (ok)' else ' (FAIL)' end);

  update public.notification_deliveries set delivered_at = now() - interval '10 minutes', sent_at = now() - interval '10 minutes' where event_id=ev and channel='sms' and person_id in (p2,p3);
  n := public.escalate_unacknowledged();
  out := array_append(out, '7 overdue and unacknowledged: exactly one person escalated: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '8 P2 email now queued: '||(select status from public.notification_deliveries where event_id=ev and person_id=p2 and channel='email')
    ||case when (select status from public.notification_deliveries where event_id=ev and person_id=p2 and channel='email')='queued' then ' (ok)' else ' (FAIL)' end);
  n := public.escalate_unacknowledged();
  out := array_append(out, '9 running it again changes nothing: '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.event_timeline where event_id=ev and person_id=p2 and kind='fallback_released' and detail='no acknowledgement in time';
  out := array_append(out, '10 timeline records the timed release: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.event_timeline where event_id=ev and person_id=p3 and kind='acknowledged';
  out := array_append(out, '11 timeline records the acknowledgement: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.event_timeline where event_id=ev;
  out := array_append(out, '12 full timeline kept for the event ('||n||' rows)'||case when n>=15 then ' (ok)' else ' (FAIL)' end);

  set local role authenticated;
  begin perform public.escalate_unacknowledged(); out := array_append(out, '13 signed-in user can run escalation (FAIL)');
  exception when others then out := array_append(out, '13 signed-in users cannot run escalation (ok)'); end;
  reset role;

  raise exception '%', 'FALLBACK TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
