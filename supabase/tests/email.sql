-- P9 email channel test. Run AFTER migration 20261016001200_email_channel.sql. Everything is rolled back (it ends with a deliberate error).
-- Every line should end "(ok)".
do $$
declare
  o uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  g uuid; g2 uuid; g3 uuid; op uuid; r jsonb; ev1 uuid; ev2 uuid; ev3 uuid; ev4 uuid; ev5 uuid; ev6 uuid; rc jsonb;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid; p8 uuid; p9 uuid; p10 uuid;
  n int; s text; out text[] := '{}'; did uuid; ok boolean;
begin
  insert into auth.users (id,email) values (u,'em-a@test.invalid');
  insert into organizations (id,name,slug) values (o,'EM A','em-a-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into groups (organization_id,name) values (o,'Solo') returning id into g2;
  insert into groups (organization_id,name) values (o,'Gate') returning id into g3;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P1','+15550000001','p1@test.invalid','consented') returning id into p1;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P2','+15550000002',null,'consented') returning id into p2;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status,email_opted_out) values (o,'P3','+15550000003','p3@test.invalid','consented',true) returning id into p3;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status,email_bounced_at) values (o,'P4','+15550000004','p4@test.invalid','consented',now()) returning id into p4;
  insert into people (organization_id,full_name,mobile_phone,email) values (o,'P5','+15550000005','p5@test.invalid') returning id into p5;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P6','+15550000006','p6@test.invalid','consented') returning id into p6;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P7','+15550000007','p7@test.invalid','consented') returning id into p7;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P8','+15550000008','p8@test.invalid','consented') returning id into p8;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P9','+15550000009','p9@test.invalid','consented') returning id into p9;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status) values (o,'P10','+15550000010','p10@test.invalid','consented') returning id into p10;
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o and full_name in ('P1','P2','P3','P4','P5','P6','P7','P8');
  insert into group_members (group_id,person_id) values (g2,p9),(g3,p10);

  -- 1. Together: text + email at once
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] x. Reply SAFE.',array[g],op,true,null,'em-1',array['sms','email'],'together','Drill: test','Email body text');
  ev1 := (r->>'event_id')::uuid;
  out := array_append(out, '1 together: 12 queued (7 text + 5 email), nothing held: '||(r->>'queued')||'/'||(r->>'held')||' '||(r->'by_channel')::text
    ||case when (r->>'queued')::int=12 and (r->>'held')::int=0 and (r->'by_channel'->'sms'->>'queued')::int=7 and (r->'by_channel'->'email'->>'queued')::int=5 then ' (ok)' else ' (FAIL)' end);
  select string_agg(pn||':'||ec, ',' order by pn) into s from (select p.full_name pn, d.error_code ec from public.notification_deliveries d join public.people p on p.id=d.person_id
        where d.event_id=ev1 and d.channel='email' and d.status='skipped') t;
  out := array_append(out, '2 email skip reasons: '||coalesce(s,'none')||case when s='P2:no_email,P3:opted_out,P4:bounced' then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from public.notification_deliveries where event_id=ev1 and channel='sms' and status='skipped' and error_code='no_consent';
  out := array_append(out, '3 text consent rules unchanged (P5 has no text consent, still gets email): '||n||case when n=1 and exists (select 1 from public.notification_deliveries where event_id=ev1 and person_id=p5 and channel='email' and status='queued') then ' (ok)' else ' (FAIL)' end);

  -- 2. Fallback: email first, text held
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] y. Reply SAFE.',array[g],op,true,null,'em-2',array['email','sms'],'fallback','Drill: y','Email body y');
  ev2 := (r->>'event_id')::uuid;
  out := array_append(out, '4 fallback: 8 queued, 4 held: '||(r->>'queued')||'/'||(r->>'held')||case when (r->>'queued')::int=8 and (r->>'held')::int=4 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '5 people with no usable email go straight to text (P2): '||coalesce((select status from public.notification_deliveries where event_id=ev2 and person_id=p2 and channel='sms'),'none')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=p2 and channel='sms')='queued' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '6 people with email: text is held behind it (P1): '||coalesce((select status from public.notification_deliveries where event_id=ev2 and person_id=p1 and channel='sms'),'none')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=p1 and channel='sms')='held' then ' (ok)' else ' (FAIL)' end);

  -- 3. Claiming hands each channel its own destination, subject and body
  create temp table claimed on commit drop as select * from public.claim_deliveries('w1', 500, 120);
  select count(*) into n from claimed;
  out := array_append(out, '7 worker claims 20 rows (12 + 8), held rows are not claimed: '||n||case when n=20 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from claimed where event_id=ev2 and channel='email' and to_email is not null and to_number is null and subject='Drill: y' and body='Email body y';
  out := array_append(out, '8 email rows carry address, subject and email body (expect 5): '||n||case when n=5 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from claimed where event_id=ev2 and channel='sms' and to_number is not null and to_email is null and subject is null and body like 'Active SOS eMNS: [DRILL] y.%';
  out := array_append(out, '9 text rows carry number and the text body (expect 3): '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);

  -- 4. Worker results, bounces and fall-through
  select delivery_id into did from claimed where event_id=ev2 and person_id=p1 and channel='email'; ok := public.record_delivery_result(did,'w1','sent','E1');
  select delivery_id into did from claimed where event_id=ev2 and person_id=p5 and channel='email'; ok := public.record_delivery_result(did,'w1','sent','E5');
  select delivery_id into did from claimed where event_id=ev2 and person_id=p7 and channel='email'; ok := public.record_delivery_result(did,'w1','sent','E7');
  select delivery_id into did from claimed where event_id=ev2 and person_id=p8 and channel='email'; ok := public.record_delivery_result(did,'w1','sent','E8');
  select delivery_id into did from claimed where event_id=ev2 and person_id=p6 and channel='email'; ok := public.record_delivery_result(did,'w1','failed',null,'invalid_email','bad address');
  for did in select delivery_id from claimed where event_id=ev2 and channel='sms' loop ok := public.record_delivery_result(did,'w1','sent','S'||left(did::text,6)); end loop;
  out := array_append(out, '10 an email that fails outright releases that person''s text (P6 text queued): '||coalesce((select status from public.notification_deliveries where event_id=ev2 and person_id=p6 and channel='sms'),'none')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=p6 and channel='sms')='queued' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '11 a sent email keeps the text held (P1): '||coalesce((select status from public.notification_deliveries where event_id=ev2 and person_id=p1 and channel='sms'),'none')
    ||case when (select status from public.notification_deliveries where event_id=ev2 and person_id=p1 and channel='sms')='held' then ' (ok)' else ' (FAIL)' end);

  ok := public.record_email_event('E8','email.delivered');
  out := array_append(out, '12 delivered receipt marks email delivered with a time (P8): '||(select status from public.notification_deliveries where provider_sid='E8')
    ||case when (select status='delivered' and delivered_at is not null from public.notification_deliveries where provider_sid='E8') then ' (ok)' else ' (FAIL)' end);
  ok := public.apply_delivery_status('E8','sent');
  out := array_append(out, '13 a late "sent" cannot undo delivered: '||(select status from public.notification_deliveries where provider_sid='E8')||case when not ok and (select status from public.notification_deliveries where provider_sid='E8')='delivered' then ' (ok)' else ' (FAIL)' end);
  ok := public.record_email_event('E7','email.bounced','Permanent');
  out := array_append(out, '14 a hard bounce fails the email, suppresses the address and releases the text (P7): '
    ||(select status from public.notification_deliveries where provider_sid='E7')||'/'||coalesce((select status from public.notification_deliveries where event_id=ev2 and person_id=p7 and channel='sms'),'none')
    ||case when ok and (select status from public.notification_deliveries where provider_sid='E7')='failed' and (select status from public.notification_deliveries where event_id=ev2 and person_id=p7 and channel='sms')='queued'
                and (select email_bounced_at is not null from public.people where id=p7) then ' (ok)' else ' (FAIL)' end);
  ok := public.record_email_event('E1','email.complained');
  out := array_append(out, '15 a spam complaint opts the person out of email (P1): '||(select email_opted_out from public.people where id=p1)::text
    ||case when ok and (select email_opted_out from public.people where id=p1) then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '16 unknown message id is ignored: '||public.record_email_event('nope','email.delivered')::text||case when not public.record_email_event('nope','email.delivered') then ' (ok)' else ' (FAIL)' end);

  -- 5. Roll-call across channels (as the signed-in admin)
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  rc := public.event_roll_call(ev2);
  out := array_append(out, '17 audience preview counts usable email addresses (P5,P6,P8 now): '||(public.preview_email_audience(array[g]))::text
    ||case when (public.preview_email_audience(array[g])->>'will_receive')::int=3 then ' (ok)' else ' (FAIL)' end);
  reset role;
  if rc is null then raise exception 'roll-call came back empty'; end if;
  out := array_append(out, '18 roll-call counts across channels: '||(rc->'counts')::text
    ||case when (rc->'counts'->>'targeted')::int=8 and (rc->'counts'->>'pending')::int=2 and (rc->'counts'->>'unaccounted')::int=6 and (rc->'counts'->>'delivered')::int=6 then ' (ok)' else ' (FAIL)' end);
  select x->>'delivery_channel' into s from jsonb_array_elements(rc->'people') x where x->>'full_name'='P8';
  out := array_append(out, '19 P8 is shown by the email that reached them: '||coalesce(s,'none')||case when s='email' then ' (ok)' else ' (FAIL)' end);

  -- 6. Released texts go out; a failing text ends the chain
  create temp table claimed2 on commit drop as select * from public.claim_deliveries('w2', 500, 120);
  select count(*) into n from claimed2 where event_id=ev2 and channel='sms' and person_id in (p6,p7) and to_number is not null;
  out := array_append(out, '20 the released texts are claimed (expect 2): '||n||case when n=2 then ' (ok)' else ' (FAIL)' end);
  select delivery_id into did from claimed2 where event_id=ev2 and person_id=p6 and channel='sms'; ok := public.record_delivery_result(did,'w2','failed',null,'30003','unreachable');
  select delivery_id into did from claimed2 where event_id=ev2 and person_id=p7 and channel='sms'; ok := public.record_delivery_result(did,'w2','sent','S7');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated; rc := public.event_roll_call(ev2); reset role;
  out := array_append(out, '21 both channels failed for P6: counted undeliverable (expect 1): '||(rc->'counts'->>'undeliverable')||case when (rc->'counts'->>'undeliverable')::int=1 and (rc->'counts'->>'pending')::int=0 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '22 the event completes once nothing is queued: '||(select status from public.notification_events where id=ev2)||case when (select status from public.notification_events where id=ev2)='complete' then ' (ok)' else ' (FAIL)' end);

  -- 7. A bounce after the event completed reopens it and sends the text
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] z.',array[g2],op,true,null,'em-5',array['email','sms'],'fallback','Drill: z',null);
  ev5 := (r->>'event_id')::uuid;
  create temp table claimed3 on commit drop as select * from public.claim_deliveries('w3', 500, 120);
  select delivery_id into did from claimed3 where event_id=ev5 and channel='email'; ok := public.record_delivery_result(did,'w3','sent','E9');
  out := array_append(out, '23 email sent, text held, event complete: '||(select status from public.notification_events where id=ev5)||case when (select status from public.notification_events where id=ev5)='complete' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '24 email body falls back to the main message when no email body given: '||coalesce((select body from claimed3 where event_id=ev5 and channel='email'),'none')
    ||case when (select body from claimed3 where event_id=ev5 and channel='email')='Active SOS eMNS: [DRILL] z.' then ' (ok)' else ' (FAIL)' end);
  ok := public.record_email_event('E9','email.bounced','Permanent');
  out := array_append(out, '25 late bounce reopens the event and queues the text: '||(select status from public.notification_events where id=ev5)||'/'||coalesce((select status from public.notification_deliveries where event_id=ev5 and channel='sms'),'none')
    ||case when (select status from public.notification_events where id=ev5)='sending' and (select status from public.notification_deliveries where event_id=ev5 and channel='sms')='queued' then ' (ok)' else ' (FAIL)' end);

  -- 8. Opt-out between creating the event and sending: email skipped, text released in the same claim
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] w.',array[g3],op,true,null,'em-4',array['email','sms'],'fallback','Drill: w','w body');
  ev4 := (r->>'event_id')::uuid;
  update public.people set email_opted_out = true where id = p10;
  create temp table claimed4 on commit drop as select * from public.claim_deliveries('w4', 500, 120);
  select count(*) into n from claimed4 where event_id=ev4 and channel='sms' and person_id=p10;
  out := array_append(out, '26 email opt-out at send time: email skipped (opted_out), text sent instead: '||coalesce((select error_code from public.notification_deliveries where event_id=ev4 and channel='email'),'none')||'/'||n
    ||case when n=1 and (select status||error_code from public.notification_deliveries where event_id=ev4 and channel='email')='skippedopted_out' then ' (ok)' else ' (FAIL)' end);

  -- 9. Text-only default and email-only suppression
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] t.',array[g],op,true,null,'em-3');
  ev3 := (r->>'event_id')::uuid;
  select count(*) into n from public.notification_deliveries where event_id=ev3 and channel='email';
  out := array_append(out, '27 default call is text-only (7 queued, no email rows): '||(r->>'queued')||'/'||n||case when (r->>'queued')::int=7 and n=0 then ' (ok)' else ' (FAIL)' end);
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] e.',array[g],op,true,null,'em-6',array['email'],'together','Drill: e',null);
  ev6 := (r->>'event_id')::uuid;
  select string_agg(p.full_name||':'||d.error_code, ',' order by p.full_name) into s from public.notification_deliveries d join public.people p on p.id=d.person_id where d.event_id=ev6 and d.status='skipped';
  out := array_append(out, '28 email-only: bounced, opted-out and missing addresses are skipped (3 queued): '||(r->>'queued')||' '||coalesce(s,'none')
    ||case when (r->>'queued')::int=3 and s='P1:opted_out,P2:no_email,P3:opted_out,P4:bounced,P7:bounced' then ' (ok)' else ' (FAIL)' end);

  -- 10. Validation and permissions
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['voice'],'together',null,null); out := array_append(out, '29 unknown channel accepted (FAIL)');
  exception when others then out := array_append(out, '29 unknown channel rejected (ok)'); end;
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['email'],'together',null,null); out := array_append(out, '30 email without subject accepted (FAIL)');
  exception when others then out := array_append(out, '30 email without a subject rejected (ok)'); end;
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['sms'],'sideways',null,null); out := array_append(out, '31 bad mode accepted (FAIL)');
  exception when others then out := array_append(out, '31 bad mode rejected (ok)'); end;
  set local role authenticated;
  begin perform public.claim_deliveries('x', 1, 1); out := array_append(out, '32 signed-in user can claim deliveries (FAIL)');
  exception when others then out := array_append(out, '32 signed-in users cannot run the queue functions (ok)'); end;
  begin perform public.record_email_event('E1','email.delivered'); out := array_append(out, '33 signed-in user can record email events (FAIL)');
  exception when others then out := array_append(out, '33 signed-in users cannot record email events (ok)'); end;
  reset role;

  raise exception '%', 'EMAIL CHANNEL TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
