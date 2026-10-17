-- P12 self-service test. Run AFTER migration 20261016001500_self_service.sql. Rolled back at the end (deliberate error).
-- Every line should end "(ok)".
do $$
declare
  oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid();
  ea uuid := gen_random_uuid(); eb uuid := gen_random_uuid(); ua uuid := gen_random_uuid();
  pa uuid; pb uuid; r jsonb; n int; s text; out text[] := '{}';
begin
  insert into auth.users (id,email) values (ea,'emp-a@test.invalid'),(eb,'emp-b@test.invalid'),(ua,'adm@test.invalid');
  insert into organizations (id,name,slug) values (oa,'SS A','ss-a-test'),(ob,'SS B','ss-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (ua,oa,'A admin','admin');
  insert into people (organization_id,full_name,mobile_phone,email,consent_status,consented_at,consent_method,user_id) values (oa,'Emp A','+15553000001','a@test.invalid','consented',now(),'web_form',ea) returning id into pa;
  insert into people (organization_id,full_name,mobile_phone,email,consent_status,user_id) values (oa,'Emp B','+15553000002','b@test.invalid','consented',eb) returning id into pb;

  -- 1. Employees hold no table access
  perform set_config('request.jwt.claim.sub', ea::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',ea,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from people; out := array_append(out, '1 employee A reads people directly (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  with u as (update people set email='hacked@test.invalid' where id in (pa,pb) returning 1) select count(*) into n from u;
  out := array_append(out, '2 employee A updates people directly (expect 0 rows): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from audit_log; out := array_append(out, '3 employee A reads audit log (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  begin perform public.self_update_contact(pa,'+15553000009',null,'x'); out := array_append(out, '4 employee calls the update function directly (FAIL)');
  exception when others then out := array_append(out, '4 employee cannot call the update function directly (ok)'); end;
  reset role;

  -- 2. Self update through the service path
  r := public.self_update_contact(pa, null, 'new-a@test.invalid', 'user:'||ea);
  out := array_append(out, '5 email change keeps consent: '||(select consent_status from people where id=pa)
    ||case when (select consent_status='consented' and email='new-a@test.invalid' from people where id=pa) and not (r->>'consent_reset')::boolean then ' (ok)' else ' (FAIL)' end);
  r := public.self_update_contact(pa, '+15553000011', null, 'user:'||ea);
  out := array_append(out, '6 mobile change resets consent to pending: '||(select consent_status||'/'||mobile_phone from people where id=pa)
    ||case when (select consent_status='pending' and consented_at is null and consent_method is null from people where id=pa) and (r->>'consent_reset')::boolean then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '7 the other employee is untouched: '||(select email||'/'||mobile_phone||'/'||consent_status from people where id=pb)
    ||case when (select email='b@test.invalid' and mobile_phone='+15553000002' and consent_status='consented' from people where id=pb) then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from audit_log where action='person.self_update' and entity_id=pa::text and details->>'by'='user:'||ea::text;
  out := array_append(out, '8 both changes are in the audit log: '||n||case when n=2 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from audit_log where action='person.self_update' and entity_id=pb::text;
  out := array_append(out, '9 nothing logged for the other employee: '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  r := public.self_update_contact(pa, '+15553000011', null, 'user:'||ea);
  out := array_append(out, '10 saving with no change logs nothing new: '||(select count(*) from audit_log where action='person.self_update' and entity_id=pa::text)
    ||case when (select count(*) from audit_log where action='person.self_update' and entity_id=pa::text)=2 then ' (ok)' else ' (FAIL)' end);

  -- 3. Validation and collisions
  begin perform public.self_update_contact(pa,'555-1212',null,'x'); out := array_append(out, '11 bad number accepted (FAIL)');
  exception when others then out := array_append(out, '11 non-E.164 number rejected (ok)'); end;
  begin perform public.self_update_contact(pa,null,'not-an-email','x'); out := array_append(out, '12 bad email accepted (FAIL)');
  exception when others then out := array_append(out, '12 bad email rejected (ok)'); end;
  begin perform public.self_update_contact(pa,'+15553000002',null,'x'); out := array_append(out, '13 taking a colleague number accepted (FAIL)');
  exception when others then out := array_append(out, '13 taking a colleague number rejected with a generic message (ok)'); end;

  -- 4. Linking
  perform public.link_person_identity(oa, pb, null, null, 'https://idp.test|sub-b');
  out := array_append(out, '14 OIDC subject linked: '||(select coalesce(idp_subject,'-')||'/'||coalesce(user_id::text,'null') from people where id=pb)
    ||case when (select idp_subject='https://idp.test|sub-b' and user_id is null from people where id=pb) then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '15 linking from another organization changes nothing: '||public.link_person_identity(ob, pa, null, null, 'x')::text
    ||case when not public.link_person_identity(ob, pa, null, null, 'x') then ' (ok)' else ' (FAIL)' end);

  raise exception '%', 'SELF-SERVICE TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
