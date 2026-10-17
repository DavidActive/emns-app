-- P10 voice channel test. Run AFTER migration 20261016001300_voice_channel.sql. Everything is rolled back (it ends with a deliberate error).
-- Every line should end "(ok)".
do $$
declare
  o uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  g uuid; g2 uuid; g3 uuid; op uuid; r jsonb; ev1 uuid; ev2 uuid; ev3 uuid; rc jsonb;
  v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; v6 uuid; v7 uuid; f1 uuid; f2 uuid; g1p uuid;
  n int; s text; out text[] := '{}'; did uuid; ok boolean; k jsonb; t timestamptz;
begin
  insert into auth.users (id,email) values (u,'vo-a@test.invalid');
  insert into organizations (id,name,slug) values (o,'VO A','vo-a-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into groups (organization_id,name) values (o,'Pair') returning id into g2;
  insert into groups (organization_id,name) values (o,'Gate') returning id into g3;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'V1','+15551000001','consented','consented') returning id into v1;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'V2','+15551000002','consented','consented') returning id into v2;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_opted_out,voice_consent_status) values (o,'V3','+15551000003','consented',true,'consented') returning id into v3;
  insert into people (organization_id,full_name,mobile_phone) values (o,'V4','+15551000004') returning id into v4;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'V5','+15551000005','consented','consented') returning id into v5;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'V6','+15551000006','consented','consented') returning id into v6;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'V7','+15551000007','consented','consented') returning id into v7;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'F1','+15551000011','consented','consented') returning id into f1;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'F2','+15551000012','consented','consented') returning id into f2;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'G1','+15551000021','consented','consented') returning id into g1p;
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o and full_name like 'V%';
  insert into group_members (group_id,person_id) values (g2,f1),(g2,f2),(g3,g1p);

  -- 1. Voice-only event
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] v.',array[g],op,true,null,'vo-1',array['voice'],'together',null,null,'This is a drill from VO A. No action is needed.',2,60);
  ev1 := (r->>'event_id')::uuid;
  select string_agg(p.full_name||':'||d.error_code, ',' order by p.full_name) into s from public.notification_deliveries d join public.people p on p.id=d.person_id where d.event_id=ev1 and d.status='skipped';
  out := array_append(out, '1 voice event: 5 queued; skipped '||coalesce(s,'none')||': '||(r->>'queued')
    ||case when (r->>'queued')::int=5 and s='V3:opted_out,V4:no_consent' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '2 retry rules are stored on the event: '||(select voice_max_attempts||'/'||voice_retry_seconds from public.notification_events where id=ev1)
    ||case when (select voice_max_attempts=2 and voice_retry_seconds=60 and voice_text like 'This is a drill%' from public.notification_events where id=ev1) then ' (ok)' else ' (FAIL)' end);

  -- 2. Concurrency cap: only 3 calls may be in flight
  create temp table c1 on commit drop as select * from public.claim_deliveries('w1', 50, 120, 3);
  select count(*) into n from c1;
  out := array_append(out, '3 cap of 3 calls in flight: first claim returns 3 of the 5: '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from c1 where channel='voice' and to_number like '+1555100%' and to_email is null and body like 'This is a drill from VO A%';
  out := array_append(out, '4 call rows carry the phone number and the voice text: '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.claim_deliveries('w1', 50, 120, 3);
  out := array_append(out, '5 while 3 are in flight nothing more is released: '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);

  -- place the three calls (sid CA1..CA3 by person order)
  select delivery_id into did from c1 where person_id=v1; ok := public.record_delivery_result(did,'w1','sent','CA1');
  select delivery_id into did from c1 where person_id=v2; ok := public.record_delivery_result(did,'w1','sent','CA2');
  select delivery_id into did from c1 where person_id=v5; ok := public.record_delivery_result(did,'w1','sent','CA5');
  select count(*) into n from public.claim_deliveries('w1', 50, 120, 3);
  out := array_append(out, '6 placed calls with no result yet still count as in flight (nothing released): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '7 each placed call counts one attempt: '||(select string_agg(call_attempts::text,',') from public.notification_deliveries where event_id=ev1 and status='sent')
    ||case when (select count(*) from public.notification_deliveries where event_id=ev1 and status='sent' and call_attempts=1)=3 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.claim_deliveries('w1', 50, 120, 4);
  out := array_append(out, '8 raising the cap to 4 releases exactly 1 more: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.claim_deliveries('w1', 50, 120, 0);
  out := array_append(out, '9 cap 0 means no cap (the last queued call is released): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  -- 3. Call results
  ok := public.apply_call_status('CA1','completed','human',31,null);
  out := array_append(out, '10 answered by a person: delivered, outcome answered, duration kept (V1): '||(select status||'/'||call_outcome||'/'||call_duration_seconds from public.notification_deliveries where provider_sid='CA1')
    ||case when ok and (select status='delivered' and call_outcome='answered' and call_duration_seconds=31 and delivered_at is not null from public.notification_deliveries where provider_sid='CA1') then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CA2','completed','machine_end_beep',22,null);
  out := array_append(out, '11 answering machine: delivered, outcome voicemail (V2): '||(select status||'/'||call_outcome from public.notification_deliveries where provider_sid='CA2')
    ||case when ok and (select status='delivered' and call_outcome='voicemail' and answered_by='machine_end_beep' from public.notification_deliveries where provider_sid='CA2') then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CA1','ringing');
  out := array_append(out, '12 in-progress states change nothing: '||ok::text||case when not ok then ' (ok)' else ' (FAIL)' end);

  -- V6 / V7 are the 4th and 5th claimed calls: place them and test no-answer retry
  select d.id into did from public.notification_deliveries d where d.event_id=ev1 and d.person_id=v6; ok := public.record_delivery_result(did,'w1','sent','CA6');
  select d.id into did from public.notification_deliveries d where d.event_id=ev1 and d.person_id=v7; ok := public.record_delivery_result(did,'w1','sent','CA7');
  t := now();
  ok := public.apply_call_status('CA6','no-answer',null,0,null);
  out := array_append(out, '13 no answer with attempts left: re-queued about 60 s out, outcome recorded (V6): '||(select status||'/'||call_outcome from public.notification_deliveries where provider_sid='CA6')
    ||case when ok and (select status='queued' and call_outcome='no_answer' and next_attempt_at >= t + interval '55 seconds' and next_attempt_at <= t + interval '70 seconds' from public.notification_deliveries where provider_sid='CA6') then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '14 a duplicate callback does not schedule a second retry: '||public.apply_call_status('CA6','no-answer',null,0,null)::text
    ||case when not public.apply_call_status('CA6','no-answer',null,0,null) then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.claim_deliveries('w1', 50, 120, 0);
  out := array_append(out, '15 the retry waits for its time (nothing claimed yet): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  update public.notification_deliveries set next_attempt_at = now() where provider_sid='CA6';
  create temp table c2 on commit drop as select * from public.claim_deliveries('w2', 50, 120, 0);
  select d.id into did from public.notification_deliveries d where d.event_id=ev1 and d.person_id=v6;
  ok := public.record_delivery_result(did,'w2','sent','CA6b');
  out := array_append(out, '16 the second call is the 2nd attempt: '||(select call_attempts from public.notification_deliveries where id=did)||case when (select call_attempts from public.notification_deliveries where id=did)=2 then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CA6b','no-answer',null,0,null);
  out := array_append(out, '17 out of attempts: undelivered, reason no_answer (V6): '||(select status||'/'||error_code from public.notification_deliveries where id=did)
    ||case when ok and (select status='undelivered' and error_code='no_answer' and call_attempts=2 from public.notification_deliveries where id=did) then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CA7','failed',null,null,'13224');
  out := array_append(out, '18 a call that cannot be placed fails with the carrier code, no retry (V7): '||(select status||'/'||error_code from public.notification_deliveries where provider_sid='CA7')
    ||case when ok and (select status='failed' and error_code='13224' and call_outcome='failed' from public.notification_deliveries where provider_sid='CA7') then ' (ok)' else ' (FAIL)' end);

  -- 4. Keypad
  k := public.record_keypad_ack((select id from public.notification_deliveries where provider_sid='CA1'),'1','CA1');
  out := array_append(out, '19 keypad 1 records SAFE (V1): '||k::text
    ||case when (k->>'ok')='true' and (k->>'response')='SAFE' and (select count(*) from public.acknowledgements where event_id=ev1 and person_id=v1 and response='SAFE' and reply_text='Keypad 1')=1 then ' (ok)' else ' (FAIL)' end);
  k := public.record_keypad_ack((select id from public.notification_deliveries where provider_sid='CA1'),'1','CA1');
  out := array_append(out, '20 the same key press again is not double counted: '||k::text
    ||case when (k->>'duplicate')='true' and (select count(*) from public.acknowledgements where event_id=ev1 and person_id=v1)=1 then ' (ok)' else ' (FAIL)' end);
  k := public.record_keypad_ack((select id from public.notification_deliveries where provider_sid='CA5'),'2','CA5');
  out := array_append(out, '21 keypad 2 records SOS and opens a critical inbox item (V5): '||k::text
    ||case when (k->>'response')='SOS' and (select count(*) from public.inbox_items where organization_id=o and person_id=v5 and tier=3 and item_type='SOS' and status='open')=1
                and (select count(*) from public.inbox_messages m join public.inbox_items i on i.id=m.item_id where i.person_id=v5)=1 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '22 a key press before the carrier callback still marks the call answered (V5): '||(select status||'/'||call_outcome from public.notification_deliveries where provider_sid='CA5')
    ||case when (select status='delivered' and call_outcome='answered' from public.notification_deliveries where provider_sid='CA5') then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CA5','completed','human',45,null);
  out := array_append(out, '23 the late callback is ignored but fills in the duration: '||ok::text||'/'||(select call_duration_seconds from public.notification_deliveries where provider_sid='CA5')
    ||case when not ok and (select call_duration_seconds=45 from public.notification_deliveries where provider_sid='CA5') then ' (ok)' else ' (FAIL)' end);
  k := public.record_keypad_ack((select id from public.notification_deliveries where provider_sid='CA2'),'5','CA2');
  out := array_append(out, '24 any other key is ignored: '||k::text||case when (k->>'ok')='false' and (k->>'reason')='invalid_digit' then ' (ok)' else ' (FAIL)' end);
  k := public.record_keypad_ack((select id from public.notification_deliveries where provider_sid='CA2'),'9','CA2');
  out := array_append(out, '25 keypad 9 stops voice calls for that person (V2): '||(select voice_opted_out from public.people where id=v2)::text
    ||case when (k->>'action')='opt_out' and (select voice_opted_out from public.people where id=v2) then ' (ok)' else ' (FAIL)' end);
  k := public.record_keypad_ack(gen_random_uuid(),'1','x');
  out := array_append(out, '26 unknown call is refused: '||k::text||case when (k->>'ok')='false' and (k->>'reason')='not_found' then ' (ok)' else ' (FAIL)' end);

  -- 5. Roll-call (as the signed-in admin)
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  rc := public.event_roll_call(ev1);
  out := array_append(out, '27 audience preview for calls: '||(public.preview_voice_audience(array[g]))::text
    ||case when (public.preview_voice_audience(array[g])->>'will_receive')::int=4 and (public.preview_voice_audience(array[g])->>'no_consent')::int=1 and (public.preview_voice_audience(array[g])->>'opted_out')::int=2 then ' (ok)' else ' (FAIL)' end);
  reset role;
  if rc is null then raise exception 'roll-call came back empty'; end if;
  select string_agg((x->>'full_name')||'='||(x->>'status'), ',' order by x->>'full_name') into s from jsonb_array_elements(rc->'people') x;
  out := array_append(out, '28 roll-call across voice: '||s
    ||case when s='V1=safe,V2=unaccounted,V3=not_contacted,V4=not_contacted,V5=sos,V6=unaccounted,V7=unaccounted' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '29 undeliverable counts the failed and no-answer calls (expect 2): '||(rc->'counts'->>'undeliverable')||case when (rc->'counts'->>'undeliverable')::int=2 then ' (ok)' else ' (FAIL)' end);

  -- 6. Fall-through: call first, text only if the call fails
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] f.',array[g2],op,true,null,'vo-2',array['voice','sms'],'fallback',null,null,'Fallback drill voice text.',1,30);
  ev2 := (r->>'event_id')::uuid;
  out := array_append(out, '30 voice first, text held: '||(r->>'queued')||'/'||(r->>'held')||case when (r->>'queued')::int=2 and (r->>'held')::int=2 then ' (ok)' else ' (FAIL)' end);
  create temp table c3 on commit drop as select * from public.claim_deliveries('w3', 50, 120, 0);
  select delivery_id into did from c3 where event_id=ev2 and person_id=f1 and channel='voice'; ok := public.record_delivery_result(did,'w3','sent','CF1');
  select delivery_id into did from c3 where event_id=ev2 and person_id=f2 and channel='voice'; ok := public.record_delivery_result(did,'w3','sent','CF2');
  ok := public.apply_call_status('CF2','completed','human',20,null);
  out := array_append(out, '31 an answered call leaves the text held (F2): '||(select status from public.notification_deliveries where event_id=ev2 and person_id=f2 and channel='sms')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=f2 and channel='sms')='held' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '32 a placed call that is still ringing keeps the text held (F1): '||(select status from public.notification_deliveries where event_id=ev2 and person_id=f1 and channel='sms')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=f1 and channel='sms')='held' then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_call_status('CF1','busy',null,0,null);
  out := array_append(out, '33 busy with a single attempt: call undelivered and the text is released (F1): '||(select status from public.notification_deliveries where provider_sid='CF1')||'/'||(select status from public.notification_deliveries where event_id=ev2 and person_id=f1 and channel='sms')
    ||case when ok and (select status from public.notification_deliveries where provider_sid='CF1')='undelivered' and (select status from public.notification_deliveries where event_id=ev2 and person_id=f1 and channel='sms')='queued' then ' (ok)' else ' (FAIL)' end);

  -- 7. Opt-out between creating the event and calling
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] g.',array[g3],op,true,null,'vo-3',array['voice'],'together',null,null,'Gate voice text.',1,30);
  ev3 := (r->>'event_id')::uuid;
  update public.people set voice_opted_out = true where id = g1p;
  select count(*) into n from public.claim_deliveries('w4', 50, 120, 0) c where c.event_id = ev3;
  out := array_append(out, '34 voice opt-out at call time: skipped, not called: '||n||'/'||coalesce((select status||'.'||error_code from public.notification_deliveries where event_id=ev3),'none')
    ||case when n=0 and (select status||error_code from public.notification_deliveries where event_id=ev3)='skippedopted_out' then ' (ok)' else ' (FAIL)' end);

  -- 8. Validation and permissions
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['voice'],'together',null,null,null,2,60); out := array_append(out, '35 voice without text accepted (FAIL)');
  exception when others then out := array_append(out, '35 voice without a message rejected (ok)'); end;
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['voice'],'together',null,null,'t',6,60); out := array_append(out, '36 6 attempts accepted (FAIL)');
  exception when others then out := array_append(out, '36 more than 5 attempts rejected (ok)'); end;
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['voice'],'together',null,null,'t',2,10); out := array_append(out, '37 10 second wait accepted (FAIL)');
  exception when others then out := array_append(out, '37 retry wait under 30 seconds rejected (ok)'); end;
  set local role authenticated;
  begin perform public.apply_call_status('CA1','completed'); out := array_append(out, '38 signed-in user can post call results (FAIL)');
  exception when others then out := array_append(out, '38 signed-in users cannot post call results (ok)'); end;
  begin perform public.record_keypad_ack(gen_random_uuid(),'1',null); out := array_append(out, '39 signed-in user can record keypad answers (FAIL)');
  exception when others then out := array_append(out, '39 signed-in users cannot record keypad answers (ok)'); end;
  reset role;

  raise exception '%', 'VOICE CHANNEL TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
