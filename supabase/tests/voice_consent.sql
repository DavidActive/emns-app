-- Voice consent test. Run AFTER migration 20261016001900_voice_consent.sql. Everything is rolled back (it ends with a deliberate error).
-- Every line should end "(ok)".
do $$
declare
  o uuid := gen_random_uuid(); g uuid; r jsonb; ev jsonb; ids uuid[]; n int; s text; out text[] := '{}';
  pa uuid; pb uuid; pc uuid; pd uuid; pe uuid;
begin
  insert into organizations (id,name,slug) values (o,'Voice Consent Org','voice-consent-test');
  insert into groups (organization_id,name) values (o,'All') returning id into g;
  insert into people (organization_id,full_name,mobile_phone) values (o,'Pending Pat','+15553000001') returning id into pa;
  insert into people (organization_id,full_name,mobile_phone,consent_status) values (o,'Text Only Tom','+15553000002','consented') returning id into pb;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status) values (o,'Both Bea','+15553000003','consented','consented') returning id into pc;
  insert into people (organization_id,full_name,mobile_phone,consent_status,voice_consent_status,voice_opted_out) values (o,'Pressed Nine Nina','+15553000004','consented','withdrawn',true) returning id into pd;
  insert into people (organization_id,full_name,mobile_phone,voice_consent_status) values (o,'Calls Only Cal','+15553000005','consented') returning id into pe;
  insert into group_members (group_id,person_id) select g, id from people where organization_id = o;

  out := array_append(out, '1 new people default to voice pending: '||(select voice_consent_status from people where id=pa)
    ||case when (select voice_consent_status from people where id=pa)='pending' then ' (ok)' else ' (FAIL)' end);

  -- Calls are queued only for people who agreed to calls (Bea, Cal); Tom (texts only), Pat and Nina are skipped.
  ev := public.create_notification_event(o,'drill','Active SOS eMNS: [DRILL] v.',array[g],null,true,null,'vc-1',array['voice'],'together',null,null,'This is a drill. No action is needed.',2,60);
  select string_agg(p.full_name||':'||coalesce(d.error_code,'queued'), ',' order by p.full_name) into s
    from public.notification_deliveries d join public.people p on p.id=d.person_id where d.event_id=(ev->>'event_id')::uuid;
  out := array_append(out, '2 only people who agreed to calls are queued: '||s
    ||case when s='Both Bea:queued,Calls Only Cal:queued,Pending Pat:no_consent,Pressed Nine Nina:opted_out,Text Only Tom:no_consent' then ' (ok)' else ' (FAIL)' end);

  -- Texts are unaffected: Tom, Bea and Nina agreed to texts.
  ev := public.create_notification_event(o,'drill','x. Reply STOP to opt out.',array[g],null,true,null,'vc-2',array['sms'],'together');
  out := array_append(out, '3 texts still go to everyone who agreed to texts (expect 3): '||(ev->>'queued')||case when (ev->>'queued')::int=3 then ' (ok)' else ' (FAIL)' end);

  -- Withdraw after queueing: the claim step must not place the call.
  update people set voice_consent_status='withdrawn' where id = pc;
  select count(*) into n from public.claim_deliveries('vc-worker', 50, 120, 0) c where c.person_id = pc and c.channel = 'voice';
  out := array_append(out, '4 a person who withdrew call consent after queueing is never called (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);
  update people set voice_consent_status='consented' where id = pc;

  -- Invites: people who still lack either agreement can be invited; fully agreed people cannot.
  ids := public.create_enrollment_invites(o, jsonb_build_array(
    jsonb_build_object('person_id',pa,'token_hash','vhA'), jsonb_build_object('person_id',pb,'token_hash','vhB'),
    jsonb_build_object('person_id',pc,'token_hash','vhC'), jsonb_build_object('person_id',pd,'token_hash','vhD')), null, 30);
  out := array_append(out, '5 links for anyone missing text or call consent, none for fully agreed Bea (expect 3): '||cardinality(ids)
    ||case when cardinality(ids)=3 and not (pc = any(ids)) then ' (ok)' else ' (FAIL)' end);
  r := public.get_enrollment_invite('vhB');
  out := array_append(out, '6 invite shows text agreed and calls not agreed: '||(r->>'already_consented')||'/'||(r->>'voice_consented')
    ||case when r->>'already_consented'='true' and r->>'voice_consented'='false' and not (r ? 'phone') then ' (ok)' else ' (FAIL)' end);

  -- Voice-only agreement from Tom: calls recorded with their own text and version; text consent untouched.
  r := public.record_web_consent('vhB', null, null, true, 'I also agree to calls.', 'voice-v-test');
  out := array_append(out, '7 voice-only agreement recorded, text not re-recorded: '||(r->>'ok')||'/'||(r->>'text_recorded')||'/'||(r->>'voice_recorded')
    ||case when r->>'ok'='true' and r->>'text_recorded'='false' and r->>'voice_recorded'='true' then ' (ok)' else ' (FAIL)' end);
  out := array_append(out, '8 Tom is now call-consented by web form: '||(select voice_consent_status||'/'||voice_consent_method from people where id=pb)
    ||case when (select voice_consent_status='consented' and voice_consent_method='web_form' and voice_consented_at is not null from people where id=pb) then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from consent_events where person_id=pb and event='voice_opt_in' and consent_text='I also agree to calls.' and text_version='voice-v-test';
  out := array_append(out, '9 the exact call wording and version are stored (expect 1): '||n||case when n=1 then ' (ok)' else ' (FAIL)' end);
  select count(*) into n from consent_events where person_id=pb and event='opt_in';
  out := array_append(out, '10 no new text opt_in was written for Tom (expect 0): '||n||case when n=0 then ' (ok)' else ' (FAIL)' end);

  -- Both agreements from Pat in one submission.
  r := public.record_web_consent('vhA', 'I agree to texts.', 'v-test', true, 'I also agree to calls.', 'voice-v-test');
  out := array_append(out, '11 Pat agrees to both: '||(select consent_status||'/'||voice_consent_status from people where id=pa)
    ||case when (select consent_status='consented' and voice_consent_status='consented' from people where id=pa) then ' (ok)' else ' (FAIL)' end);

  -- Texts-only agreement leaves calls pending (calls are never bundled).
  update people set voice_consent_status='pending' where id = pa; update people set consent_status='pending' where id = pa;
  ids := public.create_enrollment_invites(o, jsonb_build_array(jsonb_build_object('person_id',pa,'token_hash','vhA2')), null, 30);
  r := public.record_web_consent('vhA2', 'I agree to texts.', 'v-test');
  out := array_append(out, '12 agreeing to texts alone does not agree to calls: '||(select consent_status||'/'||voice_consent_status from people where id=pa)
    ||case when (select consent_status='consented' and voice_consent_status='pending' from people where id=pa) then ' (ok)' else ' (FAIL)' end);

  -- Pressing 9 earlier, then agreeing again on a new link turns calls back on.
  ids := public.create_enrollment_invites(o, jsonb_build_array(jsonb_build_object('person_id',pd,'token_hash','vhD2')), null, 30);
  r := public.record_web_consent('vhD2', null, null, true, 'I also agree to calls.', 'voice-v-test');
  out := array_append(out, '13 agreeing again after pressing 9 clears the call opt-out: '||(select voice_opted_out::text||'/'||voice_consent_status from people where id=pd)
    ||case when (select not voice_opted_out and voice_consent_status='consented' from people where id=pd) then ' (ok)' else ' (FAIL)' end);

  -- Rules of the function.
  begin perform public.record_web_consent('vhC', null, null, false, null, null); out := array_append(out, '14 nothing selected accepted (FAIL)');
  exception when others then out := array_append(out, '14 nothing selected is refused: '||sqlerrm||' (ok)'); end;
  begin perform public.record_web_consent('vhC', null, null, true, '', 'v'); out := array_append(out, '15 empty call wording accepted (FAIL)');
  exception when others then out := array_append(out, '15 empty call wording is refused: '||sqlerrm||' (ok)'); end;

  -- A changed mobile number sends both agreements back to pending.
  r := public.self_update_contact(pe, '+15553009999', null, 'test');
  out := array_append(out, '16 a new number resets call consent: '||(select voice_consent_status from people where id=pe)
    ||case when (select voice_consent_status='pending' and voice_consented_at is null and voice_consent_method is null from people where id=pe) and (r->>'consent_reset')='true' then ' (ok)' else ' (FAIL)' end);
  r := public.self_update_contact(pb, '+15553008888', null, 'test');
  out := array_append(out, '17 a new number resets text and call consent together: '||(select consent_status||'/'||voice_consent_status from people where id=pb)
    ||case when (select consent_status='pending' and voice_consent_status='pending' from people where id=pb) then ' (ok)' else ' (FAIL)' end);

  raise exception E'VOICE CONSENT TEST (rolled back)\n%', array_to_string(out, E'\n');
end $$;
