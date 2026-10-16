-- Roster import test (P3). Runs in one transaction and raises at the end so everything is rolled back.
-- Expected: every line ends with (ok).
do $$
declare
  oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); uv uuid := gen_random_uuid();
  res jsonb; res2 jsonb; out text[] := '{}'; n int; v text;
begin
  insert into auth.users (id, email) values (ua,'imp-admin@test.invalid'),(uv,'imp-viewer@test.invalid');
  insert into organizations (id,name,slug) values (oa,'Imp A','imp-a-test'),(ob,'Imp B','imp-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (ua,oa,'A admin','admin'),(uv,oa,'A viewer','viewer');
  insert into people (organization_id,full_name,mobile_phone,employee_id,email) values
    (oa,'Existing One','+15550001001','E1','old@example.com'),
    (oa,'Existing Two','+15550001002','E2',null),
    (oa,'No Emp','+15550001003',null,null),
    (ob,'Other Org','+15550009999','X9',null);

  perform set_config('request.jwt.claim.sub', ua::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;

  res := public.apply_roster_import($j$[
    {"employee_id":"E1","full_name":"Existing One","mobile_phone":"+15550001001","email":"","groups":"Alpha;Bravo"},
    {"employee_id":"E3","full_name":"Brand New","mobile_phone":"+15550001004","email":"new@example.com","groups":"Alpha"},
    {"employee_id":"E1","full_name":"Dup in file","mobile_phone":"+15550001777"},
    {"employee_id":"E2","full_name":"Mismatch","mobile_phone":"+15550001001"},
    {"employee_id":"","full_name":"No Emp Updated","mobile_phone":"+15550001003"},
    {"employee_id":"E5","full_name":"Phone clash emp","mobile_phone":"+15550001002"},
    {"employee_id":"E6","full_name":"Bad phone","mobile_phone":"555"},
    {"employee_id":"X9","full_name":"Other org id","mobile_phone":"+15550009999"}
  ]$j$::jsonb, 'test.csv', true);
  v := (res->'counts')::text;
  out := array_append(out, 'dry run counts '||v);
  select count(*) into n from people where organization_id = oa;
  out := array_append(out, '1 dry run wrote nothing (expect 3 people): '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from groups where organization_id = oa;
  out := array_append(out, '2 dry run created no groups (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '3 row1 action: '||(res->'rows'->0->>'action')||case when res->'rows'->0->>'action'='update' then ' (ok: group adds only)' else ' (FAIL)' end);
  out := array_append(out, '4 row2 action: '||(res->'rows'->1->>'action')||case when res->'rows'->1->>'action'='add' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '5 row3 action: '||(res->'rows'->2->>'action')||case when res->'rows'->2->>'action'='conflict' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '6 row4 action: '||(res->'rows'->3->>'action')||case when res->'rows'->3->>'action'='conflict' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '7 row5 action: '||(res->'rows'->4->>'action')||case when res->'rows'->4->>'action'='update' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '8 row6 action: '||(res->'rows'->5->>'action')||case when res->'rows'->5->>'action'='conflict' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '9 row7 action: '||(res->'rows'->6->>'action')||case when res->'rows'->6->>'action'='invalid' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '10 row8 (other org id) is a new add, not a match: '||(res->'rows'->7->>'action')||case when res->'rows'->7->>'action'='add' then ' (ok)' else ' (FAIL)' end);

  res2 := public.apply_roster_import($j$[
    {"employee_id":"E1","full_name":"Existing One","mobile_phone":"+15550001001","email":"","groups":"Alpha;Bravo"},
    {"employee_id":"E3","full_name":"Brand New","mobile_phone":"+15550001004","email":"new@example.com","groups":"Alpha"},
    {"employee_id":"","full_name":"No Emp Updated","mobile_phone":"+15550001003"}
  ]$j$::jsonb, 'apply.csv', false);
  select count(*) into n from people where organization_id = oa;
  out := array_append(out, '11 apply added exactly one person (expect 4): '||n||case when n=4 then ' (ok)' else ' (FAIL)' end);
  select email into v from people where organization_id = oa and employee_id = 'E1';
  out := array_append(out, '12 blank email did not erase existing: '||coalesce(v,'NULL')||case when v='old@example.com' then ' (ok)' else ' (FAIL)' end);
  select full_name into v from people where organization_id = oa and mobile_phone = '+15550001003';
  out := array_append(out, '13 matched by phone and renamed: '||v||case when v='No Emp Updated' then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from group_members gm join groups g on g.id = gm.group_id where g.organization_id = oa;
  out := array_append(out, '14 memberships created (expect 3): '||n||case when n=3 then ' (ok)' else ' (FAIL)' end);

  res2 := public.apply_roster_import($j$[{"employee_id":"E1","full_name":"Existing One","mobile_phone":"+15550001001","groups":"Alpha;Bravo"}]$j$::jsonb, 'again.csv', false);
  out := array_append(out, '15 re-import is idempotent: '||(res2->'rows'->0->>'action')||case when res2->'rows'->0->>'action'='unchanged' then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from import_batches where organization_id = oa;
  out := array_append(out, '16 batches logged (expect 2): '||n||case when n=2 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from audit_log where organization_id = oa and action = 'roster_import';
  out := array_append(out, '17 audit rows (expect 2): '||n||case when n=2 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from people where organization_id = ob;
  out := array_append(out, '18 org B rows invisible to org A admin (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  begin
    update audit_log set action = 'tamper' where organization_id = oa;
    get diagnostics n = row_count;
    out := array_append(out, '19 audit_log update rows (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  exception when others then out := array_append(out, '19 audit_log update blocked (ok)'); end;
  reset role;

  perform set_config('request.jwt.claim.sub', uv::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',uv,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.apply_roster_import('[]'::jsonb, 'v.csv', true);
    out := array_append(out, '20 viewer can import: ALLOWED (FAIL)');
  exception when others then out := array_append(out, '20 viewer import blocked (ok)'); end;
  begin
    insert into groups (organization_id, name) values (oa, 'Viewer group');
    out := array_append(out, '21 viewer creates group: ALLOWED (FAIL)');
  exception when others then out := array_append(out, '21 viewer create group blocked (ok)'); end;
  reset role;

  raise exception E'ROSTER IMPORT TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
