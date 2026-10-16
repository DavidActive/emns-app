-- Consent tracking test. Runs in one transaction and raises at the end so everything is rolled back.
-- Run as the project owner (postgres) in the SQL editor. Expected: every line ends with (ok).
do $$
declare
  o uuid := gen_random_uuid(); g uuid; ev jsonb; r jsonb; ids uuid[]; n int; v text;
  pa uuid; pb uuid; pc uuid; pd uuid; out text[] := '{}';
begin
  insert into organizations (id,name,slug) values (o,'Consent Test Org','consent-test');
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone) values (o,'Pending Pat','+15550002001') returning id into pa;
  insert into people (organization_id,full_name,mobile_phone,consent_status,consented_at,consent_method) values (o,'Agreed Alex','+15550002002','consented',now(),'web_form') returning id into pb;
  insert into people (organization_id,full_name,mobile_phone,consent_status,sms_opted_out) values (o,'Stopped Sam','+15550002003','withdrawn',true) returning id into pc;
  insert into people (organization_id,full_name,mobile_phone) values (o,'Expired Eve','+15550002004') returning id into pd;
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o;

  out := array_append(out, '1 new people default to pending: '||(select consent_status from people where id=pa)||case when (select consent_status from people where id=pa)='pending' then ' (ok)' else ' (FAIL)' end);

  ids := public.create_enrollment_invites(o, jsonb_build_array(
    jsonb_build_object('person_id',pa,'token_hash','hashA'), jsonb_build_object('person_id',pb,'token_hash','hashB'),
    jsonb_build_object('person_id',pc,'token_hash','hashC'), jsonb_build_object('person_id',pd,'token_hash','hashD')), null, 30);
  out := array_append(out, '2 links created for pending/withdrawn only, not for already-consented (expect 3): '||cardinality(ids)||case when cardinality(ids)=3 and not (pb = any(ids)) then ' (ok)' else ' (FAIL)' end);

  update enrollment_invites set expires_at = now() - interval '1 day' where token_hash = 'hashD';
  out := array_append(out, '3 expired link reported: '||(public.get_enrollment_invite('hashD')->>'status')||case when public.get_enrollment_invite('hashD')->>'status'='expired' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '4 unknown link reported: '||(public.get_enrollment_invite('nope')->>'status')||case when public.get_enrollment_invite('nope')->>'status'='invalid' then ' (ok)' else ' (FAIL)' end);
  r := public.get_enrollment_invite('hashA');
  out := array_append(out, '5 valid link shows org and last4 only: '||(r->>'org_name')||' '||(r->>'phone_last4')||case when r->>'status'='valid' and r->>'phone_last4'='2001' and not (r ? 'phone') then ' (ok)' else ' (FAIL)' end);

  ev := public.create_notification_event(o,'drill','x. Reply STOP to opt out.',array[g],null,true,null,null);
  out := array_append(out, '6 only the consenting, not-opted-out person is queued (expect queued 1, no_consent 2... got '||(ev->>'queued')||'/'||(ev->>'skipped_no_consent')||'/'||(ev->>'skipped_opted_out')||')'
    ||case when (ev->>'queued')::int=1 and (ev->>'skipped_no_consent')::int=2 and (ev->>'skipped_opted_out')::int=1 then ' (ok)' else ' (FAIL)' end);

  r := public.record_web_consent('hashA','I agree to receive alerts.','v-test');
  out := array_append(out, '7 web consent recorded: '||(r->>'ok')||case when r->>'ok'='true' and r->>'already_consented'='false' then ' (ok)' else ' (FAIL)' end);
  select consent_status into v from people where id = pa;
  out := array_append(out, '8 person is now consented: '||v||case when v='consented' then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from consent_events where person_id = pa and event='opt_in' and method='web_form' and consent_text='I agree to receive alerts.' and text_version='v-test';
  out := array_append(out, '9 consent event stores the exact text and version (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  r := public.record_web_consent('hashA','again','v-test');
  out := array_append(out, '10 link cannot be used twice: '||coalesce(r->>'reason','?')||case when r->>'ok'='false' and r->>'reason'='used' then ' (ok)' else ' (FAIL)' end);
  r := public.record_web_consent('hashD','x','v');
  out := array_append(out, '11 expired link records nothing: '||coalesce(r->>'reason','?')||case when r->>'reason'='expired' and (select consent_status from people where id=pd)='pending' then ' (ok)' else ' (FAIL)' end);

  r := public.record_web_consent('hashC','I agree.','v-test');
  out := array_append(out, '12 web consent does not clear an STOP opt-out (still opted out): '||(select sms_opted_out::text from people where id=pc)||case when (select sms_opted_out from people where id=pc) and (r->>'opted_out')='true' then ' (ok)' else ' (FAIL)' end);

  ev := public.create_notification_event(o,'drill','y. Reply STOP to opt out.',array[g],null,true,null,null);
  out := array_append(out, '13 after enrolling, the new person is queued too (expect 2): '||(ev->>'queued')||case when (ev->>'queued')::int=2 then ' (ok)' else ' (FAIL)' end);

  -- withdraw after queueing: the claim step must not hand the message to a worker
  update people set consent_status='withdrawn', sms_opted_out=true where id = pb;
  select count(*) into n from public.claim_deliveries('test-worker', 50, 120) c where c.person_id = pb;
  out := array_append(out, '14 a person who withdrew after queueing is never claimed (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from notification_deliveries where person_id = pb and status='skipped' and event_id = (ev->>'event_id')::uuid;
  out := array_append(out, '15 their pending message was marked skipped (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  raise exception E'CONSENT TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
