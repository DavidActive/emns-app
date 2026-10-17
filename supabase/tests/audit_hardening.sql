-- P14 audit and hardening test. Run AFTER migration 20261016001600_audit_hardening.sql. Rolled back at the end (deliberate error).
-- Every line should end "(ok)".
do $$
declare
  oa uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); ue uuid := gen_random_uuid();
  opa uuid; opv uuid; pa uuid; ga uuid; n int; r jsonb; out text[] := '{}'; s text;
begin
  insert into auth.users (id,email) values (ua,'aud-a@test.invalid'),(uv,'aud-v@test.invalid'),(ue,'aud-e@test.invalid');
  insert into organizations (id,name,slug) values (oa,'AU A','au-a-test');
  insert into operators (user_id,organization_id,full_name,role) values (ua,oa,'A admin','admin') returning id into opa;
  insert into people (organization_id,full_name,mobile_phone) values (oa,'Gone','+15554000001') returning id into pa;
  insert into groups (organization_id,name) values (oa,'Doomed') returning id into ga;

  -- 1. Append-only, even for the table owner / service role path
  begin update public.audit_log set action = 'x' where organization_id = oa; out := array_append(out, '1 audit row updated (FAIL)');
  exception when others then out := array_append(out, '1 audit rows cannot be updated (ok)'); end;
  begin delete from public.audit_log where organization_id = oa; out := array_append(out, '2 audit rows deleted (FAIL)');
  exception when others then out := array_append(out, '2 audit rows cannot be deleted (ok)'); end;
  begin truncate public.audit_log; out := array_append(out, '3 audit table truncated (FAIL)');
  exception when others then out := array_append(out, '3 audit table cannot be truncated (ok)'); end;
  select count(*) into n from public.audit_log where organization_id = oa and action = 'staff.added';
  out := array_append(out, '4 adding staff is logged automatically: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  -- 2. Role change and removal
  insert into operators (user_id,organization_id,full_name,role) values (uv,oa,'A viewer','viewer') returning id into opv;
  update operators set role = 'sender' where id = opv;
  select details->>'role_from'||'>'||(details->>'role_to') into s from public.audit_log where action='staff.role_changed' and entity_id = opv::text;
  out := array_append(out, '5 role change logged with before and after: '||coalesce(s,'none')||case when s='viewer>sender' then ' (ok)' else ' (FAIL)' end);
  delete from operators where id = opv;
  select count(*) into n from public.audit_log where action='staff.removed' and entity_id = opv::text;
  out := array_append(out, '6 removing staff is logged (and the old log rows survive): '||n||case when n=1 and (select count(*) from public.audit_log where entity_id=opv::text)=3 then ' (ok)' else ' (FAIL)' end);

  -- 3. Other automatic entries
  update organizations set name = 'AU A renamed' where id = oa;
  select count(*) into n from public.audit_log where action='org.settings_changed' and entity_id = oa::text;
  out := array_append(out, '7 organization change logged: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  delete from people where id = pa;
  select details->>'mobile_last4' into s from public.audit_log where action='person.deleted' and entity_id = pa::text;
  out := array_append(out, '8 person deletion logged with last four digits only: '||coalesce(s,'none')||case when s='0001' then ' (ok)' else ' (FAIL)' end);
  delete from groups where id = ga;
  select count(*) into n from public.audit_log where action='group.deleted' and entity_id = ga::text;
  out := array_append(out, '9 group deletion logged: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);

  -- 4. Exports, as a signed-in admin and as an outsider
  perform set_config('request.jwt.claim.sub', ua::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  perform public.log_export('after_action_csv', 12, 'evt-1');
  begin perform public.log_export('everything', 1, null); out := array_append(out, '10 unknown export kind accepted (FAIL)');
  exception when others then out := array_append(out, '10 unknown export kind rejected (ok)'); end;
  reset role;
  select count(*) into n from public.audit_log where action='export.after_action_csv' and organization_id = oa and actor = opa and (details->>'rows')::int = 12;
  out := array_append(out, '11 export logged against the signed-in staff member: '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  perform set_config('request.jwt.claim.sub', ue::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',ue,'role','authenticated')::text, true);
  set local role authenticated;
  begin perform public.log_export('after_action_csv', 1, null); out := array_append(out, '12 non-staff user logged an export (FAIL)');
  exception when others then out := array_append(out, '12 non-staff users cannot log exports (ok)'); end;
  begin perform public.check_rate_limit('k', 1, 60); out := array_append(out, '13 signed-in user can use the limiter (FAIL)');
  exception when others then out := array_append(out, '13 signed-in users cannot call the limiter (ok)'); end;
  select count(*) into n from public.rate_limits; out := array_append(out, '14 signed-in user cannot read limiter state: '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  reset role;

  -- 5. Rate limiter
  r := public.check_rate_limit('t:1', 2, 3600);
  out := array_append(out, '15 first hit allowed: '||(r->>'ok')||case when (r->>'ok')='true' then ' (ok)' else ' (FAIL)' end);
  r := public.check_rate_limit('t:1', 2, 3600);
  out := array_append(out, '16 second hit allowed: '||(r->>'ok')||case when (r->>'ok')='true' then ' (ok)' else ' (FAIL)' end);
  r := public.check_rate_limit('t:1', 2, 3600);
  out := array_append(out, '17 third hit refused with a wait time: '||(r->>'ok')||'/'||coalesce(r->>'retry_after','-')||case when (r->>'ok')='false' and (r->>'retry_after')::int between 1 and 3600 then ' (ok)' else ' (FAIL)' end);
  r := public.check_rate_limit('t:2', 2, 3600);
  out := array_append(out, '18 another key is unaffected: '||(r->>'ok')||case when (r->>'ok')='true' then ' (ok)' else ' (FAIL)' end);

  raise exception '%', 'AUDIT HARDENING TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
