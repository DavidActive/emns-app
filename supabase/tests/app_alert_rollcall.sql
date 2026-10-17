-- P17 test: Active SOS app alerts count in the roll-call with their location. Run AFTER migration 20261016001800_app_alert_rollcall.sql.
-- Everything is rolled back (it ends with a deliberate error). Paste the WHOLE file (it ends with: end $$;).
-- Expected: an error starting "APP ALERT ROLL-CALL TEST (rolled back)" then lines that each end "(ok)".
create or replace function pg_temp.ck(n int, d text, ok boolean) returns text language sql as $f$
  select n || ' ' || d || case when ok then ' (ok)' else ' (FAIL)' end
$f$;

do $$
declare
  o uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); u uuid := gen_random_uuid(); op uuid; g uuid; ev uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; r jsonb; n int; s text; b boolean; x numeric;
  out text[] := '{}';
begin
  insert into auth.users (id,email) values (u,'app-a@test.invalid');
  insert into organizations (id,name,slug) values (o,'APP A','app-a-test'),(o2,'APP B','app-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P1 safe from app','+15557000001','consented') returning id into p1;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P2 sos from app','+15557000002','consented') returning id into p2;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P3 silent','+15557000003','consented') returning id into p3;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P4 no consent','+15557000004','pending') returning id into p4;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P5 bad coordinates','+15557000005','consented') returning id into p5;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o2,'P6 other org','+15557000006','consented') returning id into p6;
  insert into group_members (group_id,person_id) values (g,p1),(g,p2),(g,p3),(g,p4),(g,p5);

  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] x.',array[g],op,true,null,'app-1',array['sms'],'together',null,null,null,2,120,null);
  ev := (r->>'event_id')::uuid;

  -- 1. Safe from the app
  r := public.record_app_alert_ack(o, p1, 'SAFE', 'Safe alert', 'SMA1', 35.4576, -97.5953, 'https://www.google.com/maps?q=35.4576%2C-97.5953');
  out := out || pg_temp.ck(1, 'an app SAFE alert is matched to the open event', (r->>'matched')::boolean and not (r->>'duplicate')::boolean and (r->>'has_location')::boolean);
  select count(*) into n from acknowledgements where event_id = ev and person_id = p1 and response = 'SAFE' and source = 'app' and lat = 35.4576 and lng = -97.5953;
  out := out || pg_temp.ck(2, 'it is stored as SAFE with its coordinates and marked as from the app: ' || n, n = 1);
  r := public.record_app_alert_ack(o, p1, 'SAFE', 'Safe alert', 'SMA1', 35.4576, -97.5953, null);
  select count(*) into n from acknowledgements where event_id = ev and person_id = p1;
  out := out || pg_temp.ck(3, 'the same message arriving twice is counted once: ' || n, (r->>'duplicate')::boolean and n = 1);

  -- 2. SOS from the app
  r := public.record_app_alert_ack(o, p2, 'SOS', 'SOS Alert', 'SMA2', 35.5, -97.6, 'https://www.google.com/maps?q=35.5%2C-97.6');
  select count(*) into n from audit_log where organization_id = o and action = 'sos_app_alert';
  out := out || pg_temp.ck(4, 'an app SOS alert is recorded and written to the audit log: ' || n, (r->>'matched')::boolean and n = 1);

  -- 3. Not part of the event, or not contacted
  r := public.record_app_alert_ack(o2, p6, 'SAFE', 'x', 'SMA6', 1, 1, null);
  out := out || pg_temp.ck(5, 'another organization''s person is not matched', not (r->>'matched')::boolean);
  r := public.record_app_alert_ack(o, p4, 'SAFE', 'x', 'SMA4', 1, 1, null);
  out := out || pg_temp.ck(6, 'a person who was never contacted (no consent) is not matched', not (r->>'matched')::boolean);
  r := public.record_app_alert_ack(o, p3, 'SAFE', 'x', 'SMA3', 35.0, -97.0, null, 1);
  out := out || pg_temp.ck(7, 'a person in the event is matched within the time window', (r->>'matched')::boolean);
  delete from acknowledgements where event_id = ev and person_id = p3;
  update notification_events set created_at = now() - interval '5 days' where id = ev;
  r := public.record_app_alert_ack(o, p3, 'SAFE', 'late', 'SMA3b', 35.0, -97.0, null);
  out := out || pg_temp.ck(8, 'an event older than the 72 hour window is not matched', not (r->>'matched')::boolean);
  update notification_events set created_at = now() where id = ev;

  -- 4. Bad input
  r := public.record_app_alert_ack(o, p5, 'SAFE', 'bad coords', 'SMA5', 999, 5, 'https://x.test');
  select count(*) into n from acknowledgements where event_id = ev and person_id = p5 and lat is null and lng is null and gps_url is null;
  out := out || pg_temp.ck(9, 'impossible coordinates are dropped but the answer still counts: ' || n, (r->>'matched')::boolean and n = 1);
  begin perform public.record_app_alert_ack(o, p3, 'TEXT', 'x', 'SMA3c', null, null, null);
    out := out || pg_temp.ck(10, 'only SAFE or SOS are accepted', false);
  exception when others then out := out || pg_temp.ck(10, 'only SAFE or SOS are accepted', true); end;

  -- 5. Roll-call, read as the signed-in admin (the silent person's text has been sent, so they are unaccounted for rather than still sending)
  update notification_deliveries set status = 'sent' where event_id = ev and person_id = p3;
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  r := public.event_roll_call(ev);
  out := out || pg_temp.ck(11, 'roll-call counts: ' || (r->'counts')::text,
        (r->'counts'->>'safe')::int = 2 and (r->'counts'->>'sos')::int = 1 and (r->'counts'->>'located')::int = 2
        and (r->'counts'->>'not_contacted')::int = 1 and (r->'counts'->>'unaccounted')::int = 1);
  select (e->>'lat')::numeric into x from jsonb_array_elements(r->'people') e where e->>'person_id' = p2::text;
  out := out || pg_temp.ck(12, 'the SOS person carries their latitude: ' || coalesce(x::text,'none'), x = 35.5);
  select e->>'status' into s from jsonb_array_elements(r->'people') e where e->>'person_id' = p1::text;
  out := out || pg_temp.ck(13, 'the safe person shows as safe: ' || coalesce(s,'none'), s = 'safe');
  select e->>'last_source' into s from jsonb_array_elements(r->'people') e where e->>'person_id' = p2::text;
  out := out || pg_temp.ck(14, 'the roll-call says the answer came from the app: ' || coalesce(s,'none'), s = 'app');
  select e->>'status' into s from jsonb_array_elements(r->'people') e where e->>'person_id' = p3::text;
  out := out || pg_temp.ck(15, 'the person who did not answer is unaccounted for: ' || coalesce(s,'none'), s = 'unaccounted');
  select e->>'status' into s from jsonb_array_elements(r->'people') e where e->>'person_id' = p4::text;
  out := out || pg_temp.ck(16, 'the person who was not contacted stays not contacted: ' || coalesce(s,'none'), s = 'not_contacted');
  begin perform public.record_app_alert_ack(o, p3, 'SAFE', 'x', 'SMA9', null, null, null);
    out := out || pg_temp.ck(17, 'signed-in staff can call the recorder', false);
  exception when others then out := out || pg_temp.ck(17, 'the recorder is service-role only', true); end;
  reset role;

  -- 6. An app answer also stops the held channels (fallback) like any other answer
  select count(*) into n from event_timeline where event_id = ev and person_id = p1 and kind = 'acknowledged';
  out := out || pg_temp.ck(18, 'the timeline records the acknowledgement: ' || n, n = 1);

  raise exception '%', 'APP ALERT ROLL-CALL TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
