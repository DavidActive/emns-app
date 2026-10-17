-- P12: employee self-service. Additive. Review before applying. Apply AFTER 20261016001400_fallback_sequencing.sql.
-- * An employee (person) can be linked to a sign-in identity: a Supabase Auth user (user_id) or an external OIDC identity (idp_subject).
-- * Employees have NO table access: they hold no operators row, so every RLS policy returns nothing for them.
--   They reach only their own record through the my-contact function, which finds the record from the verified identity (never from the request).
-- * Changing the mobile number moves a consented person back to "pending" (consent covered the old number) and is written to audit_log.
-- * Both functions below are service-role only.

alter table public.people
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists idp_subject text;
create unique index if not exists people_user_id_idx on public.people (user_id) where user_id is not null;
create unique index if not exists people_idp_subject_idx on public.people (idp_subject) where idp_subject is not null;

-- Link (or unlink) a person to a sign-in identity. Audited.
create or replace function public.link_person_identity(p_org uuid, p_person uuid, p_actor uuid, p_user_id uuid, p_idp_subject text)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.people set user_id = p_user_id, idp_subject = p_idp_subject, updated_at = now()
   where id = p_person and organization_id = p_org;
  if not found then return false; end if;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p_org, p_actor, 'person.link_identity', 'person', p_person::text,
          jsonb_build_object('provider', case when p_user_id is not null then 'supabase' when p_idp_subject is not null then 'oidc' else 'none' end));
  return true;
end $$;

-- The only way an employee changes their own record. p_mobile / p_email null = leave unchanged.
create or replace function public.self_update_contact(p_person uuid, p_mobile text, p_email text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare p public.people%rowtype; v_changed text[] := '{}'; v_mobile text; v_email text; v_consent_reset boolean := false;
begin
  select * into p from public.people where id = p_person and is_active for update;
  if not found then raise exception 'person not found'; end if;
  v_mobile := coalesce(nullif(btrim(p_mobile), ''), p.mobile_phone);
  v_email  := case when p_email is null then p.email else nullif(btrim(p_email), '') end;
  if v_mobile !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid mobile number'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email address'; end if;
  if v_mobile is distinct from p.mobile_phone then v_changed := array_append(v_changed, 'mobile_phone'::text); end if;
  if v_email is distinct from p.email then v_changed := array_append(v_changed, 'email'::text); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('changed', '[]'::jsonb, 'consent_reset', false); end if;
  v_consent_reset := 'mobile_phone' = any(v_changed) and p.consent_status = 'consented';
  begin
    update public.people set
      mobile_phone = v_mobile,
      email = v_email,
      email_bounced_at = case when 'email' = any(v_changed) then null else email_bounced_at end,
      consent_status = case when v_consent_reset then 'pending' else consent_status end,
      consented_at = case when v_consent_reset then null else consented_at end,
      consent_method = case when v_consent_reset then null else consent_method end,
      updated_at = now()
     where id = p_person;
  exception when unique_violation then
    raise exception 'that number could not be used';
  end;
  insert into public.audit_log (organization_id, actor, action, entity, entity_id, details)
  values (p.organization_id, null, 'person.self_update', 'person', p_person::text,
          jsonb_build_object('by', p_actor, 'changed', to_jsonb(v_changed), 'consent_reset', v_consent_reset,
                             'mobile_from_last4', right(p.mobile_phone, 4), 'mobile_to_last4', right(v_mobile, 4),
                             'email_from', p.email, 'email_to', v_email));
  return jsonb_build_object('changed', to_jsonb(v_changed), 'consent_reset', v_consent_reset);
end $$;

revoke all on function public.link_person_identity(uuid,uuid,uuid,uuid,text), public.self_update_contact(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.link_person_identity(uuid,uuid,uuid,uuid,text), public.self_update_contact(uuid,text,text,text) to service_role;
