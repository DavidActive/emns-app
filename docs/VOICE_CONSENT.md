# Voice call consent (P18)

Automated voice calls need their own agreement. Agreeing to texts never allows calls, and agreeing to calls is never required for texts.

## What changed
- `people.voice_consent_status` (`pending` | `consented` | `withdrawn`), `voice_consented_at`, `voice_consent_method`. Migration `20261016001900_voice_consent.sql`.
- Everyone starts `pending`, **including people who already agreed to texts**. Nobody is called until they agree on the enrollment form.
- A call is queued, and again claimed, only when `voice_consent_status = 'consented'` and the person has not pressed 9 (`voice_opted_out`).
- Enrollment form: a second unchecked box with its own wording (`voiceConsentText` in `src/server/consent/consentText.cjs`, version `VOICE_TEXT_VERSION`). The exact wording and version are stored in `consent_events` as `voice_opt_in`.
- Either box can be given alone. People who already agreed to texts get a link that shows only the call box.
- A changed mobile number sends both agreements back to `pending`.
- Pressing 9 on a call still stops calls. Agreeing again on a new link turns them back on.

## For staff
- People list: new "Call consent" column and "Download call-consent links" (people who agreed to texts but not to calls; people who pressed 9 are left out of the bulk list).
- Person page: shows call consent, and "Create enrollment link" works for a person who still lacks either agreement.
- Not built: recording a signed paper call-consent form. Until it is, calls go only to people who agreed on the web form.

## Must match the website
The call statement on `emns-sms-consent.html` must stay identical to `voiceConsentText`. Change both together and bump `VOICE_TEXT_VERSION`.

## Apply and check
1. Apply `supabase/migrations/20261016001900_voice_consent.sql` (after `...1800_app_alert_rollcall.sql`).
2. Run `supabase/tests/voice_consent.sql` (17 lines, each must end "(ok)") and re-run `supabase/tests/voice.sql` (its test people now carry voice consent).
3. Keep `EMNS_VOICE_PROVIDER=mock` until people have agreed to calls and a controlled call test has passed.

Calls are not recorded. If an owner later asks for recording, the consent wording and the privacy policy must change first.
