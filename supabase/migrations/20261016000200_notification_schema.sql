-- eMNS notification structures (design doc section 5). Additive to the core schema. Review before applying.
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table public.group_members (
  group_id uuid not null references groups(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  source text not null default 'manual' check (source in ('manual','import')),
  added_at timestamptz not null default now(),
  primary key (group_id, person_id)
);
create index group_members_person_idx on public.group_members (person_id);

create table public.person_contacts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  channel text not null check (channel in ('sms','voice','email','desktop')),
  value text not null,
  priority smallint not null default 1,
  verified boolean not null default false,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  unique (person_id, channel, value)
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  filename text,
  uploaded_by uuid references operators(id) on delete set null,
  mode text not null default 'merge' check (mode in ('merge','replace')),
  rows_added int not null default 0, rows_updated int not null default 0, rows_skipped int not null default 0,
  created_at timestamptz not null default now()
);

create table public.notification_scenarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind text not null default 'alert' check (kind in ('alert','drill','test')),
  plain_language_code text,
  bodies jsonb not null default '{}'::jsonb,         -- per-channel text: {"sms": "...", "voice": "...", "email": {...}}
  default_group_ids uuid[] not null default '{}',
  fallback_plan jsonb not null default '[]'::jsonb,
  requires_ack boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  scenario_id uuid references notification_scenarios(id) on delete set null,
  kind text not null check (kind in ('alert','drill','test')),
  status text not null default 'queued' check (status in ('queued','sending','complete','cancelled')),
  requires_ack boolean not null default true,
  created_by uuid references operators(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table public.notification_deliveries (            -- also the job queue
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references notification_events(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  contact_id uuid references person_contacts(id) on delete set null,
  channel text not null check (channel in ('sms','voice','email','desktop')),
  status text not null default 'queued' check (status in ('queued','sending','sent','delivered','undelivered','failed','skipped')),
  provider_sid text,
  error_code text,
  attempt int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_by text, locked_at timestamptz,
  updated_at timestamptz not null default now()
);
create index deliveries_queue_idx on public.notification_deliveries (status, next_attempt_at) where status in ('queued','sending');
create index deliveries_event_idx on public.notification_deliveries (event_id);
create index deliveries_sid_idx on public.notification_deliveries (provider_sid);

create table public.acknowledgements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references notification_events(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  response text not null,                                -- SAFE | SOS | free text
  lat double precision, lng double precision,
  received_at timestamptz not null default now(),
  unique (event_id, person_id, received_at)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid references organizations(id) on delete cascade,
  actor uuid references operators(id) on delete set null,
  action text not null,
  entity text, entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

-- RLS: same shape as the core schema
do $$
declare t text;
begin
  foreach t in array array['groups','import_batches','notification_scenarios','notification_events','notification_deliveries','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (organization_id = public.current_org_id() or public.is_platform_admin())', t||'_read', t);
  end loop;
end $$;
alter table public.group_members enable row level security;
alter table public.person_contacts enable row level security;
alter table public.acknowledgements enable row level security;
create policy group_members_read on public.group_members for select to authenticated
  using (exists (select 1 from public.groups g where g.id = group_id and (g.organization_id = public.current_org_id() or public.is_platform_admin())));
create policy person_contacts_read on public.person_contacts for select to authenticated
  using (exists (select 1 from public.people p where p.id = person_id and (p.organization_id = public.current_org_id() or public.is_platform_admin())));
create policy acknowledgements_read on public.acknowledgements for select to authenticated
  using (exists (select 1 from public.notification_events e where e.id = event_id and (e.organization_id = public.current_org_id() or public.is_platform_admin())));
-- Writes for these tables go through server functions (service role) in later prompts; no client write policies yet.
-- audit_log is append-only: no update/delete policies exist for any client role.
