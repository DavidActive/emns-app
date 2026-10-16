-- eMNS core schema (clean baseline; NOT a copy of VetProtect). Review before applying.
-- Naming: operators = portal staff; people = notified population; inbox_* = inbound replies/triage.
create extension if not exists pgcrypto;

-- ============ tables ============
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  twilio_number text unique,
  logo_url text,
  settings jsonb not null default '{}'::jsonb,   -- per-tenant flags, e.g. {"veteran_features": false}
  created_at timestamptz not null default now()
);

create table public.operators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  organization_id uuid references organizations(id) on delete cascade,
  full_name text,
  title text,
  cell_phone text,
  role text not null default 'operator' check (role in ('viewer','operator','sender','admin')),
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index operators_org_idx on public.operators (organization_id);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id text,
  full_name text,
  mobile_phone text not null,
  email text,
  notes text,
  is_active boolean not null default true,
  sms_opted_out boolean not null default false,
  sms_opted_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, mobile_phone)
);
create unique index people_org_employee_idx on public.people (organization_id, employee_id) where employee_id is not null;

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  tier smallint not null check (tier between 1 and 3),                      -- 1 routine, 2 elevated, 3 critical
  item_type text not null default 'UNKNOWN' check (item_type in ('SOS','SAFE','FREEFORM','UNKNOWN')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  message_body text,
  gps_url text, lat double precision, lng double precision,
  acknowledged_by uuid references operators(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  unread_reply boolean not null default false,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now()
);
create index inbox_items_org_status_idx on public.inbox_items (organization_id, status, created_at desc);
create index inbox_items_person_idx on public.inbox_items (person_id);

create table public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references inbox_items(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null,
  sent_by uuid references operators(id) on delete set null,
  twilio_sid text,
  delivery_status text,                          -- queued | sent | delivered | undelivered | failed
  error_code text,
  template_id uuid,
  created_at timestamptz not null default now()
);
create index inbox_messages_item_created_idx on public.inbox_messages (item_id, created_at);
create index inbox_messages_sid_idx on public.inbox_messages (twilio_sid);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  tier smallint check (tier between 1 and 3),
  name text not null,
  message text not null,
  created_at timestamptz not null default now()
);
alter table public.inbox_messages add constraint inbox_messages_template_fk
  foreign key (template_id) references message_templates(id) on delete set null;

create table public.priority_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  keyword text not null,
  tier smallint not null check (tier between 1 and 3),
  notes text,
  created_at timestamptz not null default now(),
  unique (organization_id, keyword)
);

create table public.consent_events (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  event text not null,                           -- opt_in | opt_out
  method text,
  created_at timestamptz not null default now()
);

create table public.escalations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references inbox_items(id) on delete cascade,
  escalated_to text not null,
  escalated_by uuid references operators(id) on delete set null,
  outcome text,
  notes text,
  created_at timestamptz not null default now()
);

-- ============ helper functions (RLS) ============
create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select organization_id from public.operators where user_id = auth.uid() limit 1 $$;

create or replace function public.current_op_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.operators where user_id = auth.uid() limit 1 $$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select is_platform_admin from public.operators where user_id = auth.uid() limit 1), false) $$;

revoke all on function public.current_org_id(), public.current_op_role(), public.is_platform_admin() from public, anon;
grant execute on function public.current_org_id(), public.current_op_role(), public.is_platform_admin() to authenticated;

-- ============ RLS ============
alter table public.organizations   enable row level security;
alter table public.operators       enable row level security;
alter table public.people          enable row level security;
alter table public.inbox_items     enable row level security;
alter table public.inbox_messages  enable row level security;
alter table public.message_templates enable row level security;
alter table public.priority_rules  enable row level security;
alter table public.consent_events  enable row level security;
alter table public.escalations     enable row level security;

-- organizations: members read their own; admins edit their own; platform admins everything
create policy org_read   on public.organizations for select to authenticated
  using (id = public.current_org_id() or public.is_platform_admin());
create policy org_update on public.organizations for update to authenticated
  using ((id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin())
  with check ((id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin());
create policy org_admin_all on public.organizations for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- operators: read within org; manage only by org admin or platform admin
create policy operators_read on public.operators for select to authenticated
  using (organization_id = public.current_org_id() or user_id = auth.uid() or public.is_platform_admin());
create policy operators_write on public.operators for all to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin())
  with check ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin());

-- people: read in org; write by admin/sender
create policy people_read on public.people for select to authenticated
  using (organization_id = public.current_org_id() or public.is_platform_admin());
create policy people_write on public.people for all to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() in ('admin','sender')) or public.is_platform_admin())
  with check ((organization_id = public.current_org_id() and public.current_op_role() in ('admin','sender')) or public.is_platform_admin());

-- inbox_items: read in org; operators/senders/admins can update (ack/resolve); admins can delete
create policy inbox_items_read on public.inbox_items for select to authenticated
  using (organization_id = public.current_org_id() or public.is_platform_admin());
create policy inbox_items_update on public.inbox_items for update to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() in ('operator','sender','admin')) or public.is_platform_admin())
  with check ((organization_id = public.current_org_id() and public.current_op_role() in ('operator','sender','admin')) or public.is_platform_admin());
create policy inbox_items_delete on public.inbox_items for delete to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin());

-- inbox_messages / escalations: via parent item's org
create policy inbox_messages_read on public.inbox_messages for select to authenticated
  using (exists (select 1 from public.inbox_items i where i.id = item_id and (i.organization_id = public.current_org_id() or public.is_platform_admin())));
create policy escalations_read on public.escalations for select to authenticated
  using (exists (select 1 from public.inbox_items i where i.id = item_id and (i.organization_id = public.current_org_id() or public.is_platform_admin())));
create policy escalations_insert on public.escalations for insert to authenticated
  with check (exists (select 1 from public.inbox_items i where i.id = item_id and i.organization_id = public.current_org_id() and public.current_op_role() in ('operator','sender','admin')));

-- templates and rules: read in org; admin manages
create policy templates_read on public.message_templates for select to authenticated
  using (organization_id = public.current_org_id() or public.is_platform_admin());
create policy templates_write on public.message_templates for all to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin())
  with check ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin());
create policy rules_read on public.priority_rules for select to authenticated
  using (organization_id = public.current_org_id() or public.is_platform_admin());
create policy rules_write on public.priority_rules for all to authenticated
  using ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin())
  with check ((organization_id = public.current_org_id() and public.current_op_role() = 'admin') or public.is_platform_admin());

-- consent_events: read via person's org; insert by admin/sender
create policy consent_read on public.consent_events for select to authenticated
  using (exists (select 1 from public.people p where p.id = person_id and (p.organization_id = public.current_org_id() or public.is_platform_admin())));
create policy consent_insert on public.consent_events for insert to authenticated
  with check (exists (select 1 from public.people p where p.id = person_id and p.organization_id = public.current_org_id() and public.current_op_role() in ('admin','sender')));

-- realtime for the live inbox
alter publication supabase_realtime add table public.inbox_items, public.inbox_messages;
