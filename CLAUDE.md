# eMNS Module (working name)
Outbound emergency mass notification, forked from vetprotect-app. Pilot uses test data only.

## Stack
React 18 + Vite + TypeScript SPA; Supabase Postgres/Auth/RLS; Netlify Functions (esbuild); Twilio.
Default branch: main.

Supabase project: emns, ref idysicueuqwuogouikdd, us-east-1 (migrations 0001-0004 applied; isolation test in supabase/tests/).

## Hard rules
- NEVER use the live VetProtect Supabase project or Twilio number. `npm run check:ids` enforces the known IDs.
- All vendor access goes through interfaces in src/server/providers/ (DataStore, MessageProvider, later AuthProvider,
  JobQueue, ReportProvider). No direct vendor calls elsewhere.
- Every table has organization_id and RLS. Migrations are additive and idempotent. Show SQL for review before applying.
- Recipients are resolved server-side. Never accept phone numbers from request bodies.
- Twilio signature enforcement is ON by default.
- No secrets in code or in .env.example values. Use placeholders.
- Default MessageProvider in dev/test is "mock". Real sends need EMNS_MESSAGE_PROVIDER=twilio AND EMNS_ALLOW_REAL_SEND=true.
- Veteran-specific behavior (988 hand-off) is a per-tenant setting, default off.

## Workflow
Plan first, then implement. Run `npm run build`, `npm test`, `npm run check:ids` before saying done.
Summarize changes, list files touched, and list anything left unverified.
