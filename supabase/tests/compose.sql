-- Compose / scenarios test (P6). One transaction, rolled back at the end. Expected: every line ends with (ok).
do $$
declare
  oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); us uuid := gen_random_uuid(); uv uuid := gen_random_uuid();
  g uuid; gb uuid; n int; r jsonb; out text[] := '{}'; failed boolean;
begin
  insert into auth.users (id,email) values (ua,'cmp-admin@test.invalid'),(us,'cmp-sender@test.invalid'),(uv,'cmp-viewer@test.invalid');
  insert into organizations (id,name,slug) values (oa,'Cmp A','cmp-a-test'),(ob,'Cmp B','cmp-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (ua,oa,'A admin','admin'),(us,oa,'A sender','sender'),(uv,oa,'A viewer','viewer');
  insert into groups (organization_id,name) values (oa,'G') returning id into g;
  insert into groups (organization_id,name) values (ob,'GB') returning id into gb;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values
    (oa,'C1','+15550003001','consented'),(oa,'C2','+15550003002','consented'),(oa,'P1','+15550003003','pending'),
    (ob,'Other','+15550003999','consented');
  insert into people (organization_id,full_name,mobile_phone,consent_status,sms_opted_out) values (oa,'S1','+15550003004','withdrawn',true);
  insert into group_members (group_id,person_id) select g, id from people where organization_id = oa;
  insert into group_members (group_id,person_id) select gb, id from people where organization_id = ob;

  perform set_config('request.jwt.claim.sub', us::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',us,'role','authenticated')::text, true);
  set local role authenticated;

  r := public.preview_event_audience(array[g]);
  out := array_append(out, '1 preview counts: '||r::text||case when (r->>'total')::int=4 and (r->>'will_receive')::int=2 and (r->>'no_consent')::int=1 and (r->>'opted_out')::int=1 then ' (ok)' else ' (FAIL)' end);
  r := public.preview_event_audience(array[gb]);
  out := array_append(out, '2 preview cannot see another org (expect total 0): '||(r->>'total')||case when (r->>'total')::int=0 then ' (ok)' else ' (FAIL)' end);

  insert into notification_scenarios (organization_id,name,kind,bodies) values (oa,'Sender scenario','drill','{"sms":"hi"}');
  select count(*) into n from notification_scenarios where organization_id = oa;
  out := array_append(out, '3 sender can create a scenario (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  begin
    insert into notification_scenarios (organization_id,name,kind) values (ob,'Cross org','drill'); failed := false;
  exception when others then failed := true; end;
  out := array_append(out, '4 sender cannot create a scenario in another org: '||case when failed then 'blocked (ok)' else 'ALLOWED (FAIL)' end);
  begin
    insert into notification_scenarios (organization_id,name,kind) values (oa,'','drill'); failed := false;
  exception when others then failed := true; end;
  out := array_append(out, '5 empty scenario name rejected: '||case when failed then 'blocked (ok)' else 'ALLOWED (FAIL)' end);

  reset role;
  perform set_config('request.jwt.claim.sub', uv::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',uv,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into notification_scenarios (organization_id,name,kind) values (oa,'Viewer try','drill'); failed := false;
  exception when others then failed := true; end;
  out := array_append(out, '6 viewer cannot create a scenario: '||case when failed then 'blocked (ok)' else 'ALLOWED (FAIL)' end);
  select count(*) into n from notification_scenarios;
  out := array_append(out, '7 viewer can read their org scenarios (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  reset role;
  insert into notification_events (organization_id,kind,status,body,group_ids,recipient_count) values (oa,'drill','complete','x',array[g],0);
  insert into notification_events (organization_id,kind,status,body,group_ids,recipient_count) values (ob,'drill','complete','x',array[gb],0);
  set local role authenticated;
  select count(*) into n from public.list_recent_events(50);
  out := array_append(out, '8 recent events show only my org (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  raise exception E'COMPOSE TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
