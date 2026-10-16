# Baseline schema needed for the new Supabase project

`supabase/migrations/` only contains `20261001_two_way_messaging.sql`, which is purely additive.
The original tables (organizations, staff_users, enrolled_people, alerts, alert_messages, tier_rules,
escalation_log, consent_log, recovery_activity_log, activity_ai_summaries, resource_directory,
alert_templates) were created outside the repo, so the new project has nothing to apply the
migration to. Before P2 we need a baseline migration, reviewed as SQL, including RLS policies.
Options: (a) read-only export of the live schema, (b) rebuild from the dev notes.
