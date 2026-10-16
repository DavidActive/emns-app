-- P8 after-action report test. One transaction, rolled back at the end. Run as the project owner (postgres).
-- Expected: every line ends with (ok). Uses the same scripted run as P7: 100 people texted, 80 reply, 20 do not.
do $$
declare
  o uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  g uuid; op uuid; ev uuid; t0 timestamptz; r jsonb; rc jsonb; ar jsonb; n int; i int; out text[] := '{}';
  expected uuid[]; got uuid[]; pid uuid;
begin
  insert into auth.users (id,email) values (u,'aa-a@test.invalid'),(u2,'aa-b@test.invalid');
  insert into organizations (id,name,slug) values (o,'AA A','aa-a-test'),(o2,'AA B','aa-b-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into operators (user_id,organization_id,full_name,role) values (u2,o2,'B admin','admin');
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone,consent_status)
    select o, 'P'||lpad(gs.n::text,3,'0'), '+1555'||lpad(gs.n::text,7,'0'), 'consented' from generate_series(1,100) as gs(n);
  insert into people (organization_id,full_name,mobile_phone) values (o,'NoConsent','+15550009001');
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o;

  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] x. Reply SAFE.',array[g],op,true,null,'aa-1');
  ev := (r->>'event_id')::uuid;
  select created_at into t0 from notification_events where id = ev;
  update notification_deliveries set status='sent', sent_at = t0 + interval '2 seconds' where event_id = ev and status = 'queued';

  -- 80 people reply (P007 = SOS, every 10th = free text, the rest SAFE). Reply times are scripted: person n replies n*8 seconds after t0.
  for i in 1..80 loop
    select id into pid from people where organization_id=o and full_name='P'||lpad(i::text,3,'0');
    r := public.record_acknowledgement(o, pid, case when i=7 then 'SOS' when i%10=0 then 'TEXT' else 'SAFE' end, 'reply '||i, 'SM'||i);
    if (r->>'matched') <> 'true' then raise exception 'reply % did not match', i; end if;
  end loop;
  update acknowledgements a set received_at = t0 + (substring(p.full_name from 2)::int * 8) * interval '1 second'
    from people p where p.id = a.person_id and a.event_id = ev;

  -- Carrier receipts are scripted: person n (1..97) delivered n*6 seconds after t0. P098 failed, P099 sent but no receipt, P100 undelivered.
  update notification_deliveries d set status='delivered', delivered_at = t0 + (substring(p.full_name from 2)::int * 6) * interval '1 second'
    from people p where p.id = d.person_id and d.event_id = ev
     and case when p.full_name ~ '^P[0-9]{3}$' then substring(p.full_name from 2)::int <= 97 else false end;
  update notification_deliveries d set status='failed', error_code='30003' from people p where p.id=d.person_id and d.event_id=ev and p.full_name='P098';
  update notification_deliveries d set status='undelivered', error_code='30005' from people p where p.id=d.person_id and d.event_id=ev and p.full_name='P100';

  -- Read the report the way the app does: as a signed-in member of the organization.
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  rc := public.event_roll_call(ev);
  ar := public.event_after_action(ev);
  reset role;
  if rc is null or ar is null then raise exception 'roll-call or report came back empty for a member of the organization'; end if;

  out := array_append(out, '1 headline counts are identical to the roll-call: '||(ar->'counts')::text||case when ar->'counts' = rc->'counts' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '2 the P7 numbers: 100 texted, 80 accounted for, 20 unaccounted, 1 SOS, 2 undeliverable: '
        ||case when (ar->'counts'->>'targeted')::int=100 and (ar->'counts'->>'responded')::int=80 and (ar->'counts'->>'unaccounted')::int=20
                and (ar->'counts'->>'sos')::int=1 and (ar->'counts'->>'undeliverable')::int=2 then 'yes (ok)' else 'no (FAIL)' end);
  out := array_append(out, '3 people list has the same rows as the roll-call ('||jsonb_array_length(rc->'people')||'): '
        ||case when jsonb_array_length(ar->'people') = jsonb_array_length(rc->'people') and jsonb_array_length(ar->'people') = 101 then 'yes (ok)' else 'no (FAIL)' end);
  out := array_append(out, '4 delivery-time distribution: '||(ar->'delivery'->'buckets')::text
        ||case when ar->'delivery'->'buckets' = '{"lt_1m":9,"m1_2":10,"m2_5":30,"m5_10":48,"gt_10m":0,"no_receipt":1,"failed":2,"pending":0}'::jsonb then ' (ok)' else ' (FAIL)' end);
  select coalesce(sum(v::int),0) into n from jsonb_each_text(ar->'delivery'->'buckets') as e(k,v);
  out := array_append(out, '5 delivery buckets add up to the number texted (expect 100): '||n||case when n=(ar->'counts'->>'targeted')::int then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '6 delivery seconds p50/p90/max (expect 294/524.4/582): '||(ar->'delivery'->'seconds')::text
        ||case when (ar->'delivery'->'seconds'->>'p50')::numeric=294 and (ar->'delivery'->'seconds'->>'p90')::numeric=524.4 and (ar->'delivery'->'seconds'->>'max')::numeric=582 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '7 acknowledgement-time distribution: '||(ar->'acknowledgement'->'buckets')::text
        ||case when ar->'acknowledgement'->'buckets' = '{"lt_1m":7,"m1_2":7,"m2_5":23,"m5_10":37,"gt_10m":6}'::jsonb then ' (ok)' else ' (FAIL)' end);
  select coalesce(sum(v::int),0) into n from jsonb_each_text(ar->'acknowledgement'->'buckets') as e(k,v);
  out := array_append(out, '8 acknowledgement buckets add up to the number accounted for (expect 80): '||n||case when n=(ar->'counts'->>'responded')::int then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '9 acknowledgement seconds p50/p90/max (expect 324/576.8/640): '||(ar->'acknowledgement'->'seconds')::text
        ||case when (ar->'acknowledgement'->'seconds'->>'p50')::numeric=324 and (ar->'acknowledgement'->'seconds'->>'p90')::numeric=576.8 and (ar->'acknowledgement'->'seconds'->>'max')::numeric=640 then ' (ok)' else ' (FAIL)' end);

  select array_agg(id) into expected from people where organization_id=o and full_name between 'P081' and 'P100';
  select array_agg((x->>'person_id')::uuid) into got from jsonb_array_elements(ar->'people') x where x->>'status'='unaccounted';
  out := array_append(out, '10 the unaccounted list is exactly P081..P100 (20 people): '||case when got @> expected and expected @> got and cardinality(got)=20 then 'match (ok)' else 'MISMATCH (FAIL)' end);
  select count(*) into n from jsonb_array_elements(ar->'people') x where x->>'status'='unaccounted' and x->>'first_reply_at' is not null;
  out := array_append(out, '11 nobody on the unaccounted list has a reply time (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);

  select x into r from jsonb_array_elements(ar->'people') x where x->>'full_name'='P010';
  out := array_append(out, '12 P010 timing (expect 60 s to deliver, 80 s to first reply): '||(r->>'seconds_to_deliver')||'/'||(r->>'seconds_to_first_reply')
        ||case when (r->>'seconds_to_deliver')::numeric=60 and (r->>'seconds_to_first_reply')::numeric=80 then ' (ok)' else ' (FAIL)' end);
  select x into r from jsonb_array_elements(ar->'people') x where x->>'full_name'='P099';
  out := array_append(out, '13 P099 (sent, no receipt) has no delivery time: '||coalesce(r->>'seconds_to_deliver','none')||case when r->>'seconds_to_deliver' is null and r->>'delivered_at' is null then ' (ok)' else ' (FAIL)' end);

  out := array_append(out, '14 timeline offsets from the send (expect first sent 2, first delivered 6, last delivered 582, first reply 8, last reply 640, first SOS 56): '
        ||extract(epoch from ((ar->'timeline'->>'first_sent_at')::timestamptz - t0))::int||'/'
        ||extract(epoch from ((ar->'timeline'->>'first_delivered_at')::timestamptz - t0))::int||'/'
        ||extract(epoch from ((ar->'timeline'->>'last_delivered_at')::timestamptz - t0))::int||'/'
        ||extract(epoch from ((ar->'timeline'->>'first_reply_at')::timestamptz - t0))::int||'/'
        ||extract(epoch from ((ar->'timeline'->>'last_reply_at')::timestamptz - t0))::int||'/'
        ||extract(epoch from ((ar->'timeline'->>'first_sos_at')::timestamptz - t0))::int
        ||case when extract(epoch from ((ar->'timeline'->>'first_sent_at')::timestamptz - t0))::int=2
                and extract(epoch from ((ar->'timeline'->>'first_delivered_at')::timestamptz - t0))::int=6
                and extract(epoch from ((ar->'timeline'->>'last_delivered_at')::timestamptz - t0))::int=582
                and extract(epoch from ((ar->'timeline'->>'first_reply_at')::timestamptz - t0))::int=8
                and extract(epoch from ((ar->'timeline'->>'last_reply_at')::timestamptz - t0))::int=640
                and extract(epoch from ((ar->'timeline'->>'first_sos_at')::timestamptz - t0))::int=56 then ' (ok)' else ' (FAIL)' end);

  select coalesce(sum((x->>'count')::int),0) into n from jsonb_array_elements(ar->'channels') x;
  out := array_append(out, '15 channel results add up to every delivery row (expect 101) and show 97 delivered: '||n||'/'
        ||(select coalesce(sum((x->>'count')::int),0) from jsonb_array_elements(ar->'channels') x where x->>'channel'='sms' and x->>'status'='delivered')
        ||case when n=101 and (select coalesce(sum((x->>'count')::int),0) from jsonb_array_elements(ar->'channels') x where x->>'channel'='sms' and x->>'status'='delivered')=97 then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '16 sender and groups are named: '||coalesce(ar->'event'->>'sent_by','none')||' / '||(ar->'event'->'groups')::text
        ||case when ar->'event'->>'sent_by'='A admin' and ar->'event'->'groups' = '["All"]'::jsonb then ' (ok)' else ' (FAIL)' end);

  -- Access control.
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
  set local role authenticated;
  out := array_append(out, '17 another organization cannot see this report: '||case when public.event_after_action(ev) is null then 'null (ok)' else 'LEAK (FAIL)' end);
  reset role;
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  out := array_append(out, '18 own organization can read it, counts unchanged: '
        ||case when public.event_after_action(ev) is not null and public.event_after_action(ev)->'counts' = rc->'counts' then 'yes (ok)' else 'no (FAIL)' end);
  reset role;
  set local role anon;
  begin perform public.event_after_action(ev); out := array_append(out, '19 signed-out caller can run it (FAIL)');
  exception when others then out := array_append(out, '19 signed-out callers are refused (ok)'); end;
  reset role;

  raise exception '%', 'AFTER-ACTION TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
