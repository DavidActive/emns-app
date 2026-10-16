-- Consent tracking. A person is texted only after THEY agreed: on the enrollment web form, on a signed form
-- the organization keeps, or by texting START. Being added to a roster (by hand or by CSV import) never counts as consent.
-- Run in the Supabase SQL Editor, then run supabase/tests/consent.sql to verify. Safe to run once.

-- 1. Consent state on each person
alter table public.people
  add column if not exists consent_status text not null default 'pending',
  add column if not exists consented_at timestamptz,
  add column if not exists consent_method text;
alter table public.people drop constraint if exists people_consent_status_check;
alter table public.people add constraint people_consent_status_check check (consent_status in ('pending','consented','withdrawn'));
create index if not exists people_org_consent_idx on public.people (organization_id, consent_status);

-- Proof of what was agreed to: the exact text shown and its version.
alter table public.consent_events
  add column if not exists consent_text text,
  add column if not exists text_version text;

-- Existing rows: only a real keyword opt-in counts. Everything else starts pending. Opted-out people are withdrawn.
update public.people p set consent_status = 'consented', consented_at = ce.created_at, consent_method = ce.method
  from (select distinct on (person_id) person_id, event, method, created_at from public.consent_events
         where method in ('sms_keyword_start','web_form') order by person_id, created_at desc) ce
 where ce.person_id = p.id and ce.event = 'opt_in' and p.consent_status = 'pending' and not p.sms_opted_out;
update public.people set consent_status = 'withdrawn' where sms_opted_out and consent_status <> 'withdrawn';

-- 2. One-time enrollment links. Only a hash of the token is stored; the link itself is shown once.
create table if not exists public.enrollment_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.operators(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists enrollment_invites_person_idx on public.enrollment_invites (person_id);
create index if not exists enrollment_invites_org_idx on public.enrollment_invites (organization_id);
alter table public.enrollment_invites enable row level security;   -- no policies: only the service role (Netlify functions) can touch it
revoke all on table public.enrollment_invites from anon, authenticated;
grant all on table public.enrollment_invites to service_role;

-- 3. Invite functions (service role only)
create or replace function public.create_enrollment_invites(p_org uuid, p_invites jsonb, p_created_by uuid, p_ttl_days int default 30)
returns uuid[] language plpgsql security invoker set search_path = public, pg_temp as $$
declare r jsonb; v_person uuid; v_done uuid[] := '{}';
begin
  if p_invites is null or jsonb_typeof(p_invites) <> 'array' then raise exception 'invites must be a JSON array'; end if;
  if jsonb_array_length(p_invites) > 5000 then raise exception 'at most 5000 invites per call'; end if;
  for r in select * from jsonb_array_elements(p_invites) loop
    v_person := (r->>'person_id')::uuid;
    continue when not exists (select 1 from public.people where id = v_person and organization_id = p_org and is_active and consent_status <> 'consented');
    delete from public.enrollment_invites where person_id = v_person and used_at is null;   -- a new link replaces any unused one
    insert into public.enrollment_invites (organization_id, person_id, token_hash, expires_at, created_by)
    values (p_org, v_person, r->>'token_hash', now() + make_interval(days => greatest(1, least(p_ttl_days, 90))), p_created_by);
    v_done := array_append(v_done, v_person);
  end loop;
  insert into public.audit_log (organization_id, actor, action, entity, details)
  values (p_org, p_created_by, 'invites_created', 'enrollment_invites', jsonb_build_object('count', coalesce(array_length(v_done,1),0)));
  return v_done;
end $$;

create or replace function public.get_enrollment_invite(p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.enrollment_invites%rowtype; p public.people%rowtype; o public.organizations%rowtype; st text;
begin
  select * into i from public.enrollment_invites where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into p from public.people where id = i.person_id;
  select * into o from public.organizations where id = i.organization_id;
  st := case when i.used_at is not null then 'used' when i.expires_at < now() then 'expired' else 'valid' end;
  return jsonb_build_object('status', st, 'org_name', o.name, 'first_name', split_part(coalesce(p.full_name, ''), ' ', 1),
    'phone_last4', right(p.mobile_phone, 4), 'already_consented', p.consent_status = 'consented', 'opted_out', p.sms_opted_out);
end $$;

-- Atomic: validates the link, records consent with the exact text shown, and burns the link.
create or replace function public.record_web_consent(p_token_hash text, p_text text, p_text_version text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.enrollment_invites%rowtype; p public.people%rowtype; o public.organizations%rowtype; was_consented boolean;
begin
  if p_text is null or btrim(p_text) = '' then raise exception 'consent text is required'; end if;
  select * into i from public.enrollment_invites where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if i.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into p from public.people where id = i.person_id for update;
  select * into o from public.organizations where id = i.organization_id;
  was_consented := p.consent_status = 'consented';
  -- A person who replied STOP stays opted out here: the carrier keeps blocking them until they text START.
  update public.people set consent_status = 'consented', consented_at = now(), consent_method = 'web_form', updated_at = now() where id = p.id;
  update public.enrollment_invites set used_at = now() where id = i.id;
  insert into public.consent_events (person_id, event, method, consent_text, text_version) values (p.id, 'opt_in', 'web_form', p_text, p_text_version);
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (i.organization_id, null, 'consent_recorded', 'people', p.id::text, jsonb_build_object('method', 'web_form', 'text_version', p_text_version));
  return jsonb_build_object('ok', true, 'org_name', o.name, 'person_id', p.id, 'to', p.mobile_phone,
                            'opted_out', p.sms_opted_out, 'already_consented', was_consented);
end $$;

-- 4. Sending is gated on consent (and opt-out), both when an event is created and again when a worker claims a message.
create or replace function public.create_notification_event(
  p_org uuid, p_kind text, p_body text, p_group_ids uuid[], p_created_by uuid,
  p_requires_ack boolean default true, p_scenario uuid default null, p_idempotency_key text default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_event uuid; v_queued int; v_opted int; v_nocons int; v_found int;
begin
  if p_kind not in ('alert','drill','test') then raise exception 'invalid kind'; end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 1600 then raise exception 'body must be 1-1600 characters'; end if;
  if p_group_ids is null or coalesce(array_length(p_group_ids,1),0) = 0 then raise exception 'select at least one group'; end if;
  select count(*) into v_found from public.groups where organization_id = p_org and id = any(p_group_ids);
  if v_found <> cardinality(p_group_ids) then raise exception 'one or more groups do not belong to this organization'; end if;

  if p_idempotency_key is not null then
    select id into v_event from public.notification_events where organization_id = p_org and idempotency_key = p_idempotency_key;
    if v_event is not null then return jsonb_build_object('event_id', v_event, 'deduplicated', true); end if;
  end if;

  insert into public.notification_events (organization_id, scenario_id, kind, status, requires_ack, created_by, body, group_ids, idempotency_key)
  values (p_org, p_scenario, p_kind, 'sending', p_requires_ack, p_created_by, p_body, p_group_ids, p_idempotency_key)
  returning id into v_event;

  insert into public.notification_deliveries (event_id, organization_id, person_id, channel, status, error_code)
  select v_event, p_org, p.id, 'sms',
         case when p.sms_opted_out or p.consent_status <> 'consented' then 'skipped' else 'queued' end,
         case when p.sms_opted_out then 'opted_out' when p.consent_status <> 'consented' then 'no_consent' end
  from public.people p
  where p.organization_id = p_org and p.is_active
    and exists (select 1 from public.group_members gm where gm.person_id = p.id and gm.group_id = any(p_group_ids))
  on conflict (event_id, person_id, channel) do nothing;

  select count(*) filter (where status = 'queued'),
         count(*) filter (where error_code = 'opted_out'),
         count(*) filter (where error_code = 'no_consent')
    into v_queued, v_opted, v_nocons from public.notification_deliveries where event_id = v_event;
  update public.notification_events set recipient_count = v_queued + v_opted + v_nocons,
         status = case when v_queued = 0 then 'complete' else 'sending' end, sent_at = now() where id = v_event;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p_org, p_created_by, 'event_created', 'notification_events', v_event::text,
          jsonb_build_object('kind', p_kind, 'groups', p_group_ids, 'queued', v_queued, 'skipped_opted_out', v_opted, 'skipped_no_consent', v_nocons));
  return jsonb_build_object('event_id', v_event, 'deduplicated', false, 'queued', v_queued,
                            'skipped', v_opted + v_nocons, 'skipped_opted_out', v_opted, 'skipped_no_consent', v_nocons);
end $$;

create or replace function public.claim_deliveries(p_worker text, p_limit int default 50, p_lease_seconds int default 120)
returns table (delivery_id uuid, event_id uuid, organization_id uuid, person_id uuid, to_number text, body text, attempt int)
language plpgsql security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_events uuid[];
begin
  -- Anyone who opted out or lost consent since the event was created is skipped, never texted.
  with gone as (
    update public.notification_deliveries d
       set status = 'skipped', locked_by = null, updated_at = now(),
           error_code = case when p.sms_opted_out then 'opted_out' else 'no_consent' end
      from public.people p
     where p.id = d.person_id and (p.sms_opted_out or p.consent_status <> 'consented')
       and ((d.status = 'queued' and d.next_attempt_at <= now())
         or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds)))
    returning d.event_id)
  select array_agg(distinct gone.event_id) into v_events from gone;
  if v_events is not null then
    perform public.refresh_event_status(e) from unnest(v_events) e;
  end if;

  return query
  with picked as (
    select d.id from public.notification_deliveries d
    where (d.status = 'queued' and d.next_attempt_at <= now())
       or (d.status = 'sending' and d.locked_at < now() - make_interval(secs => p_lease_seconds))
    order by d.next_attempt_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked),
  upd as (
    update public.notification_deliveries d
       set status = 'sending', locked_by = p_worker, locked_at = now(), attempt = d.attempt + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.event_id, d.organization_id, d.person_id, d.attempt)
  select upd.id, upd.event_id, upd.organization_id, upd.person_id, pp.mobile_phone, e.body, upd.attempt
  from upd join public.people pp on pp.id = upd.person_id join public.notification_events e on e.id = upd.event_id;
end $$;

revoke all on function public.create_enrollment_invites(uuid,jsonb,uuid,int), public.get_enrollment_invite(text),
  public.record_web_consent(text,text,text), public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text),
  public.claim_deliveries(text,int,int) from public, anon, authenticated;
grant execute on function public.create_enrollment_invites(uuid,jsonb,uuid,int), public.get_enrollment_invite(text),
  public.record_web_consent(text,text,text), public.create_notification_event(uuid,text,text,uuid[],uuid,boolean,uuid,text),
  public.claim_deliveries(text,int,int) to service_role;

-- 5. The roster import no longer records consent. New people are pending until they enroll.
create or replace function public.apply_roster_import(p_rows jsonb, p_filename text default null, p_dry_run boolean default true)
returns jsonb
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := private.current_org_id();
  v_role text := private.current_op_role();
  r jsonb;
  n int := 0;
  v_emp text; v_name text; v_phone text; v_email text; v_groups text;
  a_emp public.people%rowtype;
  a_phone public.people%rowtype;
  tgt public.people%rowtype;
  v_out jsonb := '[]'::jsonb;
  c_added int := 0; c_updated int := 0; c_unchanged int := 0; c_conflict int := 0; c_invalid int := 0;
  seen_emp text[] := '{}';
  seen_phone text[] := '{}';
  act text; msg text;
  changed text[];
  gn text; gname text; gid uuid; g_added int; v_person uuid; v_operator uuid;
begin
  if v_org is null or v_role is null or v_role not in ('admin','sender') then
    raise exception 'Not authorized to import people';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Import is limited to 5000 rows per file';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    v_emp := nullif(btrim(coalesce(r->>'employee_id','')), '');
    v_name := nullif(btrim(coalesce(r->>'full_name','')), '');
    v_phone := nullif(btrim(coalesce(r->>'mobile_phone','')), '');
    v_email := nullif(lower(btrim(coalesce(r->>'email',''))), '');
    v_groups := coalesce(r->>'groups','');
    act := null; msg := null; g_added := 0; changed := '{}';
    a_emp := null; a_phone := null; tgt := null; v_person := null;

    if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
      act := 'invalid'; msg := 'Missing or invalid mobile phone (use a format like +15555550123)';
    elsif v_name is null then
      act := 'invalid'; msg := 'Missing full name';
    elsif v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      act := 'invalid'; msg := 'Invalid email address';
    elsif (v_emp is not null and v_emp = any(seen_emp)) or v_phone = any(seen_phone) then
      act := 'conflict'; msg := 'Duplicate of an earlier row in this file; skipped';
    else
      if v_emp is not null then
        select * into a_emp from public.people where organization_id = v_org and employee_id = v_emp;
      end if;
      select * into a_phone from public.people where organization_id = v_org and mobile_phone = v_phone;

      if a_emp.id is not null and a_phone.id is not null and a_emp.id <> a_phone.id then
        act := 'conflict';
        msg := 'Employee ID and phone number belong to two different existing people; resolve manually';
      elsif a_emp.id is null and v_emp is not null and a_phone.id is not null
            and a_phone.employee_id is not null and a_phone.employee_id <> v_emp then
        act := 'conflict';
        msg := 'Phone number already belongs to a person with a different employee ID; resolve manually';
      else
        if a_emp.id is not null then tgt := a_emp; elsif a_phone.id is not null then tgt := a_phone; end if;

        if tgt.id is null then
          act := 'add'; msg := 'New person (texts start after they enroll)';
          if not p_dry_run then
            insert into public.people (organization_id, employee_id, full_name, mobile_phone, email, is_active)
            values (v_org, v_emp, v_name, v_phone, v_email, true) returning id into v_person;
          end if;
        else
          v_person := tgt.id;
          if v_name is distinct from tgt.full_name then changed := array_append(changed, 'name'); end if;
          if v_phone is distinct from tgt.mobile_phone then changed := array_append(changed, 'phone'); end if;
          if v_email is not null and v_email is distinct from tgt.email then changed := array_append(changed, 'email'); end if;
          if v_emp is not null and tgt.employee_id is null then changed := array_append(changed, 'employee ID'); end if;
          if coalesce(array_length(changed, 1), 0) > 0 then
            act := 'update'; msg := 'Updates: ' || array_to_string(changed, ', ');
            if not p_dry_run then
              update public.people set
                full_name = v_name,
                mobile_phone = v_phone,
                email = coalesce(v_email, email),
                employee_id = coalesce(employee_id, v_emp),
                updated_at = now()
              where id = tgt.id;
            end if;
          else
            act := 'unchanged'; msg := 'No changes';
          end if;
        end if;

        -- group memberships (additive only)
        for gn in select distinct btrim(x) from unnest(string_to_array(v_groups, ';')) x where btrim(x) <> '' loop
          gname := left(gn, 80);
          select id into gid from public.groups where organization_id = v_org and lower(name) = lower(gname);
          if gid is null then
            g_added := g_added + 1;
            if not p_dry_run then
              insert into public.groups (organization_id, name) values (v_org, gname) returning id into gid;
            end if;
          elsif v_person is null or not exists (select 1 from public.group_members where group_id = gid and person_id = v_person) then
            g_added := g_added + 1;
          end if;
          if not p_dry_run and gid is not null and v_person is not null then
            insert into public.group_members (group_id, person_id, source) values (gid, v_person, 'import') on conflict do nothing;
          end if;
          gid := null;
        end loop;
        if g_added > 0 then
          msg := msg || '; adds ' || g_added || ' group membership(s)';
          if act = 'unchanged' then act := 'update'; end if;
        end if;
      end if;
    end if;

    if act in ('add','update','unchanged','conflict') then
      if v_emp is not null then seen_emp := array_append(seen_emp, v_emp); end if;
      seen_phone := array_append(seen_phone, v_phone);
    end if;
    case act
      when 'add' then c_added := c_added + 1;
      when 'update' then c_updated := c_updated + 1;
      when 'unchanged' then c_unchanged := c_unchanged + 1;
      when 'conflict' then c_conflict := c_conflict + 1;
      else c_invalid := c_invalid + 1;
    end case;
    v_out := v_out || jsonb_build_object('row', n, 'action', act, 'message', msg,
      'employee_id', v_emp, 'full_name', v_name, 'mobile_phone', v_phone);
  end loop;

  if not p_dry_run then
    select id into v_operator from public.operators where user_id = auth.uid();
    insert into public.import_batches (organization_id, filename, uploaded_by, mode, rows_added, rows_updated, rows_skipped)
    values (v_org, left(p_filename, 255), v_operator, 'merge', c_added, c_updated, c_unchanged + c_conflict + c_invalid);
    insert into public.audit_log (organization_id, actor, action, entity, details)
    values (v_org, v_operator, 'roster_import', 'people', jsonb_build_object('filename', p_filename,
      'added', c_added, 'updated', c_updated, 'unchanged', c_unchanged, 'conflicts', c_conflict, 'invalid', c_invalid));
  end if;

  return jsonb_build_object('dry_run', p_dry_run,
    'counts', jsonb_build_object('added', c_added, 'updated', c_updated, 'unchanged', c_unchanged,
                                 'conflicts', c_conflict, 'invalid', c_invalid, 'total', n),
    'rows', v_out);
end $$;

revoke all on function public.apply_roster_import(jsonb, text, boolean) from public, anon;
grant execute on function public.apply_roster_import(jsonb, text, boolean) to authenticated;
