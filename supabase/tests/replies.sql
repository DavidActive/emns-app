-- P7 replies / roll-call test. One transaction, rolled back at the end. Run as the project owner (postgres).
-- Expected: every line ends with (ok).
do $$
declare
  o uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  g uuid; ev1 uuid; ev2 uuid; ev3 uuid; r jsonb; rc jsonb; n int; out text[] := '{}';
  expected uuid[]; got uuid[]; pid uuid; i int;
begin
  insert into auth.users (id,email) values (u,'rc-a@test.invalid'),(u2,'rc-b@test.invalid');
  insert into organizations (id,name,slug) values (o,'RC A','rc-a-test'),(o2,'RC B','rc-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin'),(u2,o2,'B admin','admin');
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone,consent_status)
    select o, 'P'||lpad(i::text,3,'0'), '+1555'||lpad(i::text,7,'0'), 'consented' from generate_series(1,100) i;
  insert into people (organization_id,full_name,mobile_phone) values (o,'NoConsent','+15550009001');
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o;

  -- Event 1 asks for acknowledgement; event 2 (newer) does not; event 3 (newest) does.
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] x. Reply SAFE.',array[g],null,true,null,'rc-1');  ev1 := (r->>'event_id')::uuid;
  out := array_append(out, '1 100 queued, the unconsented person skipped: '||(r->>'queued')||'/'||(r->>'skipped')||case when (r->>'queued')::int=100 and (r->>'skipped')::int=1 then ' (ok)' else ' (FAIL)' end);
  update notification_deliveries set status='sent' where event_id=ev1 and status='queued';

  -- Scripted run: people 1..80 reply, 81..100 stay silent. Mix of SAFE, free text, one SOS.
  for i in 1..80 loop
    select id into pid from people where organization_id=o and full_name='P'||lpad(i::text,3,'0');
    r := public.record_acknowledgement(o, pid, case when i=7 then 'SOS' when i%10=0 then 'TEXT' else 'SAFE' end, 'reply '||i, 'SM'||i);
    if (r->>'matched') <> 'true' then raise exception 'reply % did not match', i; end if;
  end loop;

  rc := public.event_roll_call(ev1);
  out := array_append(out, '2 counts: '||(rc->'counts')::text||case when (rc->'counts'->>'targeted')::int=100 and (rc->'counts'->>'responded')::int=80 and (rc->'counts'->>'unaccounted')::int=20
        and (rc->'counts'->>'sos')::int=1 and (rc->'counts'->>'replied')::int=8 and (rc->'counts'->>'safe')::int=71 and (rc->'counts'->>'not_contacted')::int=1 then ' (ok)' else ' (FAIL)' end);
  select array_agg(id) into expected from people where organization_id=o and full_name between 'P081' and 'P100';
  select array_agg((x->>'person_id')::uuid) into got from jsonb_array_elements(rc->'people') x where x->>'status'='unaccounted';
  out := array_append(out, '3 the 20 unaccounted people are exactly P081..P100: '||case when got @> expected and expected @> got and cardinality(got)=20 then 'match (ok)' else 'MISMATCH (FAIL)' end);
  out := array_append(out, '4 the SOS person is listed first: '||(rc->'people'->0->>'full_name')||' '||(rc->'people'->0->>'status')||case when rc->'people'->0->>'status'='sos' and rc->'people'->0->>'full_name'='P007' then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from notification_deliveries where event_id=ev1 and status='delivered';
  out := array_append(out, '5 a reply marks the text delivered (expect 80): '||n||case when n=80 then ' (ok)' else ' (FAIL)' end);

  -- Duplicate provider message id is ignored.
  select id into pid from people where organization_id=o and full_name='P001';
  r := public.record_acknowledgement(o, pid, 'SAFE', 'again', 'SM1');
  select count(*) into n from acknowledgements where event_id=ev1 and person_id=pid;
  out := array_append(out, '6 retry of the same message id not double counted (expect 1 row): '||n||case when n=1 and (r->>'duplicate')='true' then ' (ok)' else ' (FAIL)' end);

  -- SOS is sticky: a later SAFE does not clear it.
  select id into pid from people where organization_id=o and full_name='P007';
  perform public.record_acknowledgement(o, pid, 'SAFE', 'actually fine', 'SM7b');
  rc := public.event_roll_call(ev1);
  out := array_append(out, '7 SOS stays SOS after a later SAFE: '||(rc->'counts'->>'sos')||case when (rc->'counts'->>'sos')::int=1 then ' (ok)' else ' (FAIL)' end);

  -- Most recent event requiring an acknowledgement wins; an event that does not require one is ignored.
  r := public.create_notification_event(o,'test','Active SOS eMNS: [TEST] x.',array[g],null,false,null,'rc-2'); ev2 := (r->>'event_id')::uuid;
  update notification_deliveries set status='sent' where event_id=ev2;
  select id into pid from people where organization_id=o and full_name='P090';
  r := public.record_acknowledgement(o, pid, 'SAFE', 'late', 'SM90');
  out := array_append(out, '8 reply skips the newer no-ack event and attaches to the older ack event: '||case when (r->>'event_id')::uuid=ev1 then 'ev1 (ok)' else 'WRONG (FAIL)' end);
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] y.',array[g],null,true,null,'rc-3'); ev3 := (r->>'event_id')::uuid;
  update notification_deliveries set status='sent' where event_id=ev3;
  select id into pid from people where organization_id=o and full_name='P091';
  r := public.record_acknowledgement(o, pid, 'SAFE', 'now', 'SM91');
  out := array_append(out, '9 with two open ack events the most recent is chosen: '||case when (r->>'event_id')::uuid=ev3 then 'ev3 (ok)' else 'WRONG (FAIL)' end);

  -- Not sent / not targeted / too old: no match.
  update notification_deliveries set status='queued' where event_id in (ev1,ev3) and person_id = (select id from people where organization_id=o and full_name='P095');
  select id into pid from people where organization_id=o and full_name='P095';
  update notification_deliveries set status='skipped' where event_id=ev1 and person_id=pid;
  update notification_events set created_at = now() - interval '5 days' where id = ev1;
  r := public.record_acknowledgement(o, pid, 'SAFE', 'x', 'SM95');
  out := array_append(out, '10 a person whose text was not sent gets no match: '||(r->>'matched')||case when (r->>'matched')='false' then ' (ok)' else ' (FAIL)' end);
  select id into pid from people where organization_id=o and full_name='NoConsent';
  r := public.record_acknowledgement(o, pid, 'SAFE', 'x', 'SM-nc');
  out := array_append(out, '11 a person never texted gets no match: '||(r->>'matched')||case when (r->>'matched')='false' then ' (ok)' else ' (FAIL)' end);
  select id into pid from people where organization_id=o and full_name='P005';
  update notification_deliveries set status='sent' where event_id=ev1 and person_id=pid;
  r := public.record_acknowledgement(o, pid, 'SAFE', 'x', 'SM5-old');
  out := array_append(out, '12 event older than the window (72h) is not matched; falls to the newer one: '||case when (r->>'event_id')::uuid=ev3 or (r->>'matched')='false' then 'ok (ok)' else 'WRONG (FAIL)' end);
  begin perform public.record_acknowledgement(o, pid, 'BOGUS', 'x', null); out := array_append(out, '13 bad response accepted (FAIL)');
  exception when others then out := array_append(out, '13 invalid response value rejected (ok)'); end;

  -- Organization isolation of the roll-call.
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
  set local role authenticated;
  out := array_append(out, '14 another organization cannot see this roll-call: '||coalesce((public.event_roll_call(ev3))::text,'null')||case when public.event_roll_call(ev3) is null then ' (ok)' else ' (FAIL)' end);
  begin perform public.record_acknowledgement(o, pid, 'SAFE', 'x', null); out := array_append(out, '15 signed-in user can call record_acknowledgement (FAIL)');
  exception when others then out := array_append(out, '15 record_acknowledgement is service-role only (ok)'); end;
  reset role;
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  out := array_append(out, '16 own organization can read it: '||case when public.event_roll_call(ev3) is not null then 'yes (ok)' else 'no (FAIL)' end);
  reset role;

  raise exception E'REPLIES / ROLL-CALL TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
