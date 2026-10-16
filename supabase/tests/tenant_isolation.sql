-- Tenant isolation test. Run against a dev project with the SQL editor / execute_sql.
-- Builds two orgs and four users inside one transaction, checks what each role can see and do,
-- then RAISES an exception so everything is rolled back. Expected output lines are in the labels.
do $$
declare
  oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); up uuid := gen_random_uuid();
  pa uuid; pb uuid; ia uuid; ib uuid; res text[] := '{}'; n int;
begin
  insert into auth.users (id, email) values (ua,'a-admin@test.invalid'),(ub,'b-admin@test.invalid'),(uv,'a-viewer@test.invalid'),(up,'platform@test.invalid');
  insert into organizations (id,name,slug) values (oa,'Org A','org-a-test'),(ob,'Org B','org-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (ua,oa,'A admin','admin'),(ub,ob,'B admin','admin'),(uv,oa,'A viewer','viewer');
  insert into operators (user_id,organization_id,full_name,role,is_platform_admin) values (up,null,'Platform','admin',true);
  insert into people (organization_id,full_name,mobile_phone) values (oa,'Person A','+15550000001') returning id into pa;
  insert into people (organization_id,full_name,mobile_phone) values (ob,'Person B','+15550000002') returning id into pb;
  insert into inbox_items (organization_id,person_id,tier) values (oa,pa,1) returning id into ia;
  insert into inbox_items (organization_id,person_id,tier) values (ob,pb,3) returning id into ib;

  perform set_config('request.jwt.claim.sub', ua::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from people; res := array_append(res, '1 A admin sees people (expect 1): '||n);
  select count(*) into n from people where organization_id = ob; res := array_append(res, '2 A admin sees B people (expect 0): '||n);
  select count(*) into n from inbox_items; res := array_append(res, '3 A admin sees inbox items (expect 1): '||n);
  select count(*) into n from organizations; res := array_append(res, '4 A admin sees organizations (expect 1): '||n);
  with u as (update inbox_items set status='resolved' where id = ib returning 1) select count(*) into n from u;
  res := array_append(res, '5 A admin updates B inbox item (expect 0 rows): '||n);
  begin insert into people (organization_id,full_name,mobile_phone) values (ob,'Intruder','+15550000009');
    res := array_append(res, '6 A admin inserts into org B: ALLOWED (FAIL)');
  exception when others then res := array_append(res, '6 A admin inserts into org B: blocked (ok)'); end;
  reset role;

  perform set_config('request.jwt.claim.sub', uv::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',uv,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from people; res := array_append(res, '7 A viewer reads people (expect 1): '||n);
  begin insert into people (organization_id,full_name,mobile_phone) values (oa,'Viewer write','+15550000010');
    res := array_append(res, '8 viewer inserts person: ALLOWED (FAIL)');
  exception when others then res := array_append(res, '8 viewer inserts person: blocked (ok)'); end;
  with u as (update inbox_items set status='acknowledged' where id = ia returning 1) select count(*) into n from u;
  res := array_append(res, '9 viewer updates inbox item (expect 0 rows): '||n);
  reset role;

  perform set_config('request.jwt.claim.sub', up::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',up,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from people where organization_id in (oa,ob); res := array_append(res, '10 platform admin sees both orgs (expect 2): '||n);
  reset role;

  set local role anon;
  begin select count(*) into n from people; res := array_append(res, '11 anon reads people: ALLOWED (FAIL)');
  exception when others then res := array_append(res, '11 anon reads people: blocked (ok)'); end;
  reset role;

  raise exception E'ISOLATION TEST RESULTS (rolled back)\n%', array_to_string(res, E'\n');
end $$;
