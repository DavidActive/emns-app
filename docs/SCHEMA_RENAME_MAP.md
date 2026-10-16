# VetProtect -> eMNS naming map

| VetProtect | eMNS | Notes |
|---|---|---|
| organizations | organizations | `sponsor_text`, `symbol_url` dropped; `settings jsonb` added |
| staff_users | operators | roles: viewer, operator, sender, admin (was admin/staff/viewer/support); `is_global_admin` -> `is_platform_admin` |
| enrolled_people | people | `phone_number` -> `mobile_phone`; `enrolled` -> `is_active`; added `employee_id`; veteran fields dropped |
| alerts | inbox_items | `alert_type` -> `item_type`; `enrolled_person_id` -> `person_id`; `tier` kept (1 routine, 2 elevated, 3 critical) |
| alert_messages | inbox_messages | `alert_id` -> `item_id` |
| alert_templates | message_templates | |
| tier_rules | priority_rules | unique (organization_id, keyword) |
| consent_log | consent_events | `enrolled_person_id` -> `person_id` |
| escalation_log | escalations | `alert_id` -> `item_id` |
| recovery_activity_log, activity_ai_summaries, resource_directory | removed | veteran/recovery specific |

Removed from the app: AI activity/population report functions and Reports page (replaced by P8 after-action reports),
Veterans pages (now People), Veterans Crisis Line escalation text (now generic escalation notice).

Routes: /triage -> /inbox, /alerts -> /history, /veterans -> /people, /reports removed.

New tables (migration 20261016000200): groups, group_members, person_contacts, import_batches,
notification_scenarios, notification_events, notification_deliveries, acknowledgements, audit_log.
