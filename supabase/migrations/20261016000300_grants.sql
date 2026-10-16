-- Explicit grants. The emns project was created with "Automatically expose new tables" OFF,
-- so nothing is reachable through the API until granted here. Row-level security still decides which rows.
-- anon gets nothing: every screen requires sign-in.
revoke all on all tables in schema public from anon;

-- server functions (service role)
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- signed-in users: only what the policies allow
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.organizations, public.operators, public.people,
  public.message_templates, public.priority_rules to authenticated;
grant select, update, delete on public.inbox_items to authenticated;
grant select on public.inbox_messages to authenticated;
grant select, insert on public.consent_events, public.escalations to authenticated;
grant select on public.groups, public.group_members, public.person_contacts, public.import_batches,
  public.notification_scenarios, public.notification_events, public.notification_deliveries,
  public.acknowledgements, public.audit_log to authenticated;
