# eMNS Module (working name)

Outbound emergency mass notification, forked from `vetprotect-app` (Active SOS).
Pilot uses test data only. See `CLAUDE.md` for the rules every session follows and
`Deliverables/eMNS_Design_Document_and_Build_Playbook.docx` for the design.

## Stack
React 18 + Vite + TypeScript SPA; Supabase (Postgres, Auth, RLS); Netlify Functions; Twilio.
Vendor access goes through `src/server/providers/`.

## Local dev
```bash
npm install
cp .env.example .env.local     # fill with the NEW emns Supabase project values
npm run dev
npm test                       # node:test suite, uses the mock provider
npm run check:ids              # fails if a live VetProtect identifier is present
```

## Safety defaults
- Message provider defaults to `mock`. Real sends need `EMNS_MESSAGE_PROVIDER=twilio` AND `EMNS_ALLOW_REAL_SEND=true`.
- Twilio signature enforcement is ON unless `TWILIO_ENFORCE_SIGNATURE=false`.
- Do not point this repo at the live VetProtect Supabase project or Twilio number.

## Status
P0 (clean fork), P1 (provider interfaces) and the schema rename are done in code. Migrations in supabase/migrations/ are written but NOT yet applied: the emns Supabase project still has to be created. See docs/SCHEMA_RENAME_MAP.md.
