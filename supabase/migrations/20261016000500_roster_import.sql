-- P2/P3: roster write access, E.164 phone check, audit hardening, and the merge-safe import function.

-- 1. Phone numbers are stored in E.164 form only (+15551234567).
alter table public.people drop constraint if exists people_mobile_phone_e164;
alter table public.people add constraint people_mobile_phone_e164 check (mobile_phone ~ '^\+[1-9][0-9]{7,14}$');
create index if not exists people_org_name_idx on public.people (organization_id, lower(full_name));
create index if not exists person_contacts_person_idx on public.person_contacts (person_id);

-- 2. Explicit grants: authenticated may write roster tables; RLS policies below decide who and which rows.
revoke all on public.groups, public.group_members, public.person_contacts, public.import_batches, public.audit_log from authenticated;
grant select, insert, update, delete on public.groups, public.group_members, public.person_contacts to authenticated;
grant select, insert on public.import_batches, public.audit_log to authenticated;  -- audit_log is append-only for clients

-- 3. Write policies: admin and sender roles, own organization only (platform admin always).
create policy groups_write on public.groups for all to authenticated
  using (organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin())
  with check (organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin());

create policy group_members_write on public.group_members for all to authenticated
  using (exists (select 1 from public.groups g where g.id = group_id
    and (g.organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin())))
  with check (exists (select 1 from public.groups g where g.id = group_id
    and (g.organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin())));

create policy person_contacts_write on public.person_contacts for all to authenticated
  using (exists (select 1 from public.people p where p.id = person_id
    and (p.organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin())))
  with check (exists (select 1 from public.people p where p.id = person_id
    and (p.organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender') or private.is_platform_admin())));

create policy import_batches_insert on public.import_batches for insert to authenticated
  with check (organization_id = private.current_org_id() and private.current_op_role() in ('admin','sender'));

create policy audit_log_insert on public.audit_log for insert to authenticated
  with check (organization_id = private.current_org_id()
    and (actor is null or exists (select 1 from public.operators o where o.id = actor and o.user_id = auth.uid())));

-- 4. Merge-safe roster import. SECURITY INVOKER: row-level security applies to every statement inside.
-- Rules (never destructive):
--   * match on employee_id first, then mobile phone; two different people matched => conflict, row skipped
--   * blank cells never erase existing data; opt-out status is never touched
--   * people missing from the file are never deleted or deactivated; group memberships are only added
--   * duplicate keys inside the file => later row skipped as a conflict
-- p_dry_run = true previews every row without writing anything.
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
          act := 'add'; msg := 'New person';
          if not p_dry_run then
            insert into public.people (organization_id, employee_id, full_name, mobile_phone, email, is_active)
            values (v_org, v_emp, v_name, v_phone, v_email, true) returning id into v_person;
            insert into public.consent_events (person_id, event, method) values (v_person, 'opt_in', 'roster_import');
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
