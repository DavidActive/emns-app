-- P16 desktop agent test. Run AFTER migration 20261016001700_desktop_agent.sql. Everything is rolled back (it ends with a deliberate error).
-- Paste the WHOLE file (it ends with: end $$;). Expected: an error starting "DESKTOP AGENT TEST (rolled back)" then lines that each end "(ok)".
create or replace function pg_temp.ck(n int, d text, ok boolean) returns text language sql as $f$
  select n || ' ' || d || case when ok then ' (ok)' else ' (FAIL)' end
$f$;

do $$
declare
  o uuid := gen_random_uuid(); u uuid := gen_random_uuid(); op uuid; g uuid; ev uuid; ev2 uuid; r jsonb; n int; s text; b boolean;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; d1 uuid; d3a uuid; d3b uuid; d4 uuid; did uuid; did3 uuid; did4 uuid;
  out text[] := '{}';
begin
  insert into auth.users (id,email) values (u,'da-a@test.invalid');
  insert into organizations (id,name,slug) values (o,'DA A','da-a-test');
  insert into operators (user_id,organization_id,full_name,role) values (u,o,'A admin','admin') returning id into op;
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P1','+15556000001','consented') returning id into p1;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P2 no agent','+15556000002','consented') returning id into p2;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P3 two PCs','+15556000003','consented') returning id into p3;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'P4 offline PC','+15556000004','consented') returning id into p4;
  insert into group_members (group_id,person_id) values (g,p1),(g,p2),(g,p3),(g,p4);

  -- 1. Pairing and enrollment
  r := public.create_agent_pairing(p1, 'code-p1');
  out := out || pg_temp.ck(1, 'pairing code created', (r->>'ok')::boolean);
  r := public.enroll_agent_device('code-p1', 'tok-1', 'WS-1', 'windows', '0.1.0');
  out := out || pg_temp.ck(2, 'code enrolls a computer for the right person: ' || coalesce(r->>'person_name','none'), (r->>'ok')::boolean and r->>'person_name' = 'P1');
  select id into d1 from agent_devices where token_hash = 'tok-1';
  r := public.enroll_agent_device('code-p1', 'tok-1b', 'WS-X', 'windows', null);
  out := out || pg_temp.ck(3, 'the same code cannot be used twice', not (r->>'ok')::boolean);
  insert into agent_pairing_codes (organization_id, person_id, code_hash, expires_at) values (o, p1, 'old-code', now() - interval '1 minute');
  r := public.enroll_agent_device('old-code', 'tok-old', 'WS-old', 'windows', null);
  out := out || pg_temp.ck(4, 'an expired code is refused', not (r->>'ok')::boolean);
  perform public.create_agent_pairing(p3, 'code-p3a'); perform public.enroll_agent_device('code-p3a', 'tok-3a', 'WS-3A', 'windows', null);
  perform public.create_agent_pairing(p3, 'code-p3b'); perform public.enroll_agent_device('code-p3b', 'tok-3b', 'WS-3B', 'windows', null);
  select id into d3a from agent_devices where token_hash = 'tok-3a'; select id into d3b from agent_devices where token_hash = 'tok-3b';
  perform public.create_agent_pairing(p4, 'code-p4'); perform public.enroll_agent_device('code-p4', 'tok-4', 'WS-4', 'windows', null);
  select id into d4 from agent_devices where token_hash = 'tok-4';
  select count(*) into n from public.audit_log where organization_id = o and action = 'agent.enrolled';
  out := out || pg_temp.ck(5, 'every enrollment is in the audit log: ' || n, n = 4);
  select count(*) into n from agent_pairing_codes where code_hash = 'code-p1';
  out := out || pg_temp.ck(6, 'only hashes are stored (code row present, token hash present)', n = 1 and d1 is not null);

  -- 2. An event with the desktop channel first, text second ("in this order")
  r := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] x.',array[g],op,true,null,'da-1',array['desktop','sms'],'fallback',null,null,null,2,120,'[DRILL] DA A: walk to the north exit');
  ev := (r->>'event_id')::uuid;
  select count(*) into n from notification_deliveries where event_id = ev and channel = 'desktop' and status = 'queued';
  out := out || pg_temp.ck(7, 'desktop queued for the 3 people with a computer: ' || n, n = 3);
  select error_code into s from notification_deliveries where event_id = ev and channel = 'desktop' and person_id = p2;
  out := out || pg_temp.ck(8, 'a person with no computer is skipped for desktop (' || coalesce(s,'none') || ')', s = 'no_agent');
  select count(*) into n from notification_deliveries where event_id = ev and channel = 'sms' and status = 'held';
  out := out || pg_temp.ck(9, 'text is held for those 3 and queued at once for the one skipped: held ' || n, n = 3
        and (select status from notification_deliveries where event_id = ev and channel = 'sms' and person_id = p2) = 'queued');
  begin perform public.create_notification_event(o,'drill','x',array[g],op,true,null,null,array['desktop'],'together',null,null,null,2,120,null);
    out := out || pg_temp.ck(10, 'a desktop alert with no text is refused', false);
  exception when others then out := out || pg_temp.ck(10, 'a desktop alert with no text is refused', true); end;

  -- 3. The send worker never takes desktop rows
  select count(*) into n from public.claim_deliveries('w1', 100, 120, 0) where channel = 'desktop';
  out := out || pg_temp.ck(11, 'the send worker claims no desktop rows: ' || n, n = 0);
  select count(*) into n from notification_deliveries where event_id = ev and channel = 'desktop' and status = 'queued';
  out := out || pg_temp.ck(12, 'they are still waiting for the agents: ' || n, n = 3);

  -- 4. The agent collects its alert
  r := public.agent_claim('tok-1', '0.1.0');
  did := (r->'alerts'->0->>'delivery_id')::uuid;
  out := out || pg_temp.ck(13, 'agent receives the alert with the desktop wording: ' || coalesce(r->'alerts'->0->>'body','none'),
        jsonb_array_length(r->'alerts') = 1 and r->'alerts'->0->>'body' = '[DRILL] DA A: walk to the north exit' and (r->'alerts'->0->>'requires_ack')::boolean);
  select status into s from notification_deliveries where id = did;
  out := out || pg_temp.ck(14, 'handing it over marks it sent: ' || s, s = 'sent');
  r := public.agent_claim('tok-1', '0.1.0');
  out := out || pg_temp.ck(15, 'asking again returns nothing new', jsonb_array_length(r->'alerts') = 0);
  select last_seen_at is not null into b from agent_devices where id = d1;
  out := out || pg_temp.ck(16, 'the computer is marked as seen', b);
  r := public.agent_claim('tok-3a'); did3 := (r->'alerts'->0->>'delivery_id')::uuid;
  n := jsonb_array_length(r->'alerts') + jsonb_array_length(public.agent_claim('tok-3b')->'alerts');
  out := out || pg_temp.ck(17, 'both of a person''s computers get the alert: ' || n, n = 2);

  -- 5. Shown, then answered
  r := public.agent_report('tok-1', did, 'shown');
  select status into s from notification_deliveries where id = did;
  out := out || pg_temp.ck(18, 'on screen = delivered: ' || s, (r->>'ok')::boolean and s = 'delivered');
  r := public.agent_report('tok-1', did, 'ack', 'SAFE');
  select count(*) into n from acknowledgements where event_id = ev and person_id = p1 and response = 'SAFE';
  out := out || pg_temp.ck(19, 'I''m safe is counted like a text reply: ' || n, (r->>'ok')::boolean and n = 1);
  r := public.agent_report('tok-1', did, 'ack', 'SAFE');
  select count(*) into n from acknowledgements where event_id = ev and person_id = p1;
  out := out || pg_temp.ck(20, 'clicking twice does not count twice', (r->>'duplicate')::boolean and n = 1);
  select status || '/' || coalesce(error_code,'') into s from notification_deliveries where event_id = ev and person_id = p1 and channel = 'sms';
  out := out || pg_temp.ck(21, 'the answer cancels the held text: ' || s, s = 'skipped/acknowledged');
  r := public.agent_report('tok-1', did3, 'ack', 'SAFE');
  out := out || pg_temp.ck(22, 'one person''s computer cannot answer for another person: ' || coalesce(r->>'reason','none'), not (r->>'ok')::boolean and r->>'reason' = 'not_found');
  r := public.agent_report('tok-1', did, 'ack', 'MAYBE');
  out := out || pg_temp.ck(23, 'only SAFE or SOS are accepted', not (r->>'ok')::boolean);

  -- 6. Help request, answered on one computer, closed on the other
  perform public.agent_report('tok-3a', did3, 'shown');
  r := public.agent_report('tok-3a', did3, 'ack', 'SOS');
  select count(*) into n from inbox_items where organization_id = o and person_id = p3 and item_type = 'SOS' and tier = 3;
  out := out || pg_temp.ck(24, 'I need help opens a critical inbox item: ' || n, (r->>'ok')::boolean and n = 1);
  r := public.agent_claim('tok-3b');
  out := out || pg_temp.ck(25, 'the other computer is told to close the alert', r->'dismiss' @> to_jsonb(array[did3::text]) and jsonb_array_length(r->'alerts') = 0);

  -- 7. Nobody collects it: expiry hands over to the next channel, and a late computer still gets it
  update notification_deliveries set next_attempt_at = now() - interval '5 minutes' where event_id = ev and channel = 'desktop' and person_id = p4;
  n := public.expire_desktop_deliveries(120);
  select status || '/' || coalesce(error_code,'') into s from notification_deliveries where event_id = ev and channel = 'desktop' and person_id = p4;
  out := out || pg_temp.ck(26, 'an uncollected alert becomes undelivered: ' || s || ' (' || n || ' expired)', s = 'undelivered/agent_offline' and n = 1);
  select status into s from notification_deliveries where event_id = ev and channel = 'sms' and person_id = p4;
  out := out || pg_temp.ck(27, 'and the next channel is released: ' || s, s = 'queued');
  r := public.agent_claim('tok-4');
  select status into s from notification_deliveries where event_id = ev and channel = 'desktop' and person_id = p4;
  out := out || pg_temp.ck(28, 'a computer that comes back late still gets it: ' || s, jsonb_array_length(r->'alerts') = 1 and s = 'sent');
  n := public.expire_desktop_deliveries(120);
  out := out || pg_temp.ck(29, 'expiry does nothing twice: ' || n, n = 0);
  select count(*) into n from event_timeline where event_id = ev and channel = 'desktop' and kind in ('queued','sent','delivered','undelivered');
  out := out || pg_temp.ck(30, 'the timeline records the desktop steps: ' || n, n >= 8);

  -- 8. Removing a computer
  b := public.revoke_agent_device_for_person(p1, d1);
  r := public.agent_claim('tok-1');
  out := out || pg_temp.ck(31, 'a removed computer is refused', b and not (r->>'ok')::boolean and r->>'reason' = 'revoked');
  out := out || pg_temp.ck(32, 'removing someone else''s computer does nothing', not public.revoke_agent_device_for_person(p1, d3a));
  r := public.agent_report('tok-1', did, 'shown');
  out := out || pg_temp.ck(33, 'a removed computer cannot report either', r->>'reason' = 'revoked');
  r := public.agent_claim('not-a-real-token');
  out := out || pg_temp.ck(34, 'an unknown token is refused', not (r->>'ok')::boolean);

  -- 9. What signed-in staff can and cannot do (P1's only computer was removed above, so P1 and P2 now have no computer)
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agent_devices;
  out := out || pg_temp.ck(35, 'staff can see their organization''s computers: ' || n, n = 4);
  begin perform token_hash from public.agent_devices limit 1; out := out || pg_temp.ck(36, 'staff can read token hashes', false);
  exception when others then out := out || pg_temp.ck(36, 'staff cannot read token hashes', true); end;
  begin perform 1 from public.agent_pairing_codes limit 1; out := out || pg_temp.ck(37, 'staff can read pairing codes', false);
  exception when others then out := out || pg_temp.ck(37, 'staff cannot read pairing codes', true); end;
  begin perform 1 from public.desktop_receipts limit 1; out := out || pg_temp.ck(38, 'staff can read receipts', false);
  exception when others then out := out || pg_temp.ck(38, 'staff cannot read receipts', true); end;
  begin perform public.agent_claim('tok-3a'); out := out || pg_temp.ck(39, 'staff can call the agent function', false);
  exception when others then out := out || pg_temp.ck(39, 'staff cannot call the agent functions', true); end;
  begin update public.agent_devices set device_name = 'renamed' where id = d3a; out := out || pg_temp.ck(40, 'staff can edit a device', false);
  exception when others then out := out || pg_temp.ck(40, 'staff cannot change anything but "removed"', true); end;
  r := public.preview_desktop_audience(array[g]);
  out := out || pg_temp.ck(41, 'preview counts: ' || r::text, (r->>'total')::int = 4 and (r->>'will_receive')::int = 2 and (r->>'no_agent')::int = 2 and (r->>'online')::int = 2);
  update public.agent_devices set revoked_at = now() where id = d3b;
  get diagnostics n = row_count;
  out := out || pg_temp.ck(42, 'an admin can remove a computer: ' || n, n = 1);
  reset role;
  select count(*) into n from public.audit_log where organization_id = o and action = 'agent.revoked';
  out := out || pg_temp.ck(43, 'both removals are in the audit log: ' || n || case when n = 2 then '' else ' -> ' || (select string_agg(entity_id || ' by=' || coalesce(actor::text,'null') || ' ' || coalesce(details::text,''), ' | ') from public.audit_log where organization_id = o and action = 'agent.revoked') end
        || ' [old_rpc=' || (position('''by'', ''employee''' in pg_get_functiondef('public.revoke_agent_device_for_person(uuid,uuid)'::regprocedure)) > 0)::text || ']', n = 2);
  r := public.agent_claim('tok-3b');
  out := out || pg_temp.ck(44, 'the computer an admin removed is refused', r->>'reason' = 'revoked');

  raise exception '%', 'DESKTOP AGENT TEST (rolled back)' || chr(10) || array_to_string(out, chr(10));
end $$;
