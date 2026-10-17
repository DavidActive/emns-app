# eMNS security checklist (P14)

Status as of the P14 build. Re-run the commands before each release. Items marked **Open** need an owner decision or a later phase.

## Automated checks (run before every release)
| Check | Command | Expected |
|---|---|---|
| Unit and integration tests | `npm test` | all pass |
| Type check and build | `npm run build` | no errors |
| No live VetProtect IDs | `npm run check:ids` | clean |
| Dependency audit | `npm audit` | 0 vulnerabilities (last run: 0 after upgrading react-router-dom 7.18, vite 7.3, plugin-react 5) |
| Database tests (run in the Supabase SQL editor, each ends in a deliberate rollback error; every line must say "(ok)") | `supabase/tests/*.sql`, including `audit_hardening.sql`, `self_service.sql`, `fallback.sql`, `voice.sql`, `email.sql` | all "(ok)" |

## Audit log
- [x] Append-only: no update, delete or truncate for any role; a trigger blocks it even for the service role. Only the foreign key clearing "actor" when a staff member is removed is allowed.
- [x] Sends (create_notification_event), roster imports (apply_roster_import), consent changes, enrollment links, replies, voice keypad answers: logged by their database functions.
- [x] Role and staff changes (added, role changed, removed), organization setting changes, person and group deletions: logged by triggers, whichever screen made the change.
- [x] Employee self-service edits and identity links: logged with the verified identity.
- [x] Exports (after-action CSV, enrollment-links CSV): logged before the file is handed over; if logging fails the export does not happen.
- [ ] **Residual:** a signed-in staff member can still append their own-organization audit entries attributed to themselves (needed by invoker-mode functions). They cannot edit, delete or attribute entries to someone else. Closing this means moving those functions to a definer-mode logger.
- [ ] **Open:** removing a whole organization needs `SET LOCAL emns.allow_audit_purge = 'on'` in that transaction. Define the retention and purge procedure with the customer.

## Endpoint protection
- [x] Twilio signature checking on sms-webhook, sms-status, voice-twiml, voice-gather, voice-status: on by default, cannot be switched off when `CONTEXT=production`; tested that unsigned requests get 403.
- [x] Resend (email) webhook: Svix signature, fails closed with no secret.
- [x] Staff functions verify the caller server-side (AuthProvider or requireOperator) and take recipients from the database, never from the request.
- [x] Rate limits (database-backed, per caller, fails open so an outage cannot block an alert): send-event 20/min, create-invites 30/min, send-sms 60/min, link-employee 20/min, invite-staff 10/min, my-contact 30 per 10 min, public enroll 10 POST / 60 GET per minute per address.
- [ ] **Open:** Twilio webhook endpoints are protected by signature, not rate limit. Consider a Netlify/edge rate rule if abuse appears.
- [ ] **Open:** add an edge or WAF rate rule on the whole site once it moves to emns.activesos.com (P15 infrastructure).

## Routes and functions inventory (reviewed, nothing unused found)
Functions: create-invites, email-webhook, enroll (public, token-gated), invite-staff (platform admin), link-employee (admin), my-contact (employee), send-event, send-sms, send-sweeper (scheduled), send-worker-background (secret-gated), sms-status, sms-webhook, voice-gather, voice-status, voice-twiml. Every one is called by the app, Twilio, Resend or the scheduler.
App routes: login, set-password, enroll/:token, me (employees), and the staff pages under `/`. No debug or test routes exist.

## Secrets and configuration
- [x] No secrets in code; `.env.example` holds placeholders only.
- [x] Mock providers by default; real sends need both the provider setting and `EMNS_ALLOW_REAL_SEND=true`.
- [ ] **Open (yours):** rotate the temporary password, confirm `TWILIO_WEBHOOK_BASE_URL` after the domain move, set Supabase Site URL and SMTP.
- [ ] **Open:** before real employee data, set up Supabase backups and confirm the data-residency and retention requirements.
