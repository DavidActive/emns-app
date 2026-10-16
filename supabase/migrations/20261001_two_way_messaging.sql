-- Two-way messaging: portal -> veteran replies, delivery tracking, opt-out, unread flag.
-- Purely additive (nullable / defaulted columns): safe to apply while the live app runs.

alter table public.alert_messages
  add column if not exists twilio_sid text,
  add column if not exists delivery_status text,   -- queued | sent | delivered | undelivered | failed
  add column if not exists error_code text,
  add column if not exists template_id uuid references public.alert_templates(id) on delete set null;

create index if not exists alert_messages_twilio_sid_idx on public.alert_messages (twilio_sid);
create index if not exists alert_messages_alert_created_idx on public.alert_messages (alert_id, created_at);

alter table public.enrolled_people
  add column if not exists sms_opted_out boolean not null default false,
  add column if not exists sms_opted_out_at timestamptz;

-- Set when a veteran replies on an open thread; cleared when staff open/answer it.
alter table public.alerts
  add column if not exists unread_reply boolean not null default false,
  add column if not exists last_inbound_at timestamptz;

-- Let the portal receive live thread updates.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'alert_messages') then
    alter publication supabase_realtime add table public.alert_messages;
  end if;
end $$;
