# Running eMNS outside Netlify (P15)

The same code runs two ways: on Netlify + Supabase (the pilot), or as containers against any PostgreSQL (the "authorized profile").
Every vendor call goes through the provider layer (`src/server/providers`, `src/server/auth`): data access (DataStore), sign-in (AuthProvider), text, email and voice. A test fails the build if a function calls a hosted vendor directly.

## What runs
| Container | What it is |
|---|---|
| `db` | PostgreSQL 16 (on AWS: RDS) |
| `bootstrap` (once) | creates the API roles, the `auth` schema and default privileges (`docker/bootstrap.sql`) |
| `auth` | GoTrue, the open-source sign-in service (staff and employee accounts, invitation emails) |
| `rest` | PostgREST, the open-source data API with row-level security |
| `migrate` (once) | applies `supabase/migrations` in order, once each (`scripts/db-local.cjs migrate`) |
| `app` | `server/main.cjs`: serves the built app and runs the functions on the same `/.netlify/functions/<name>` paths |
| `worker` | `server/worker.cjs`: the scheduler that Netlify's once-a-minute schedule provides (timed fallback, wakes the send worker) |
| `gateway` | nginx: one address for the app, `/rest/v1` and `/auth/v1` (no cross-site settings) |
| `seed` (once) | creates a demo organization and an admin login |
| `mailpit` | catches invitation emails at http://localhost:8025 (local only) |

Real sending is off: the compose file sets the text, email and voice providers to `mock` and `EMNS_ALLOW_REAL_SEND=false`.

## Run it locally
```
node scripts/gen-env.cjs                       # once: .env.docker with fresh random secrets and keys
docker compose --env-file .env.docker up --build
```
Open http://localhost:8080 and sign in as `admin@emns.local` with `SEED_ADMIN_PASSWORD` from `.env.docker`.
Stop with `docker compose down`; add `-v` to also delete the database.

## Settings that differ from Netlify
`EMNS_BASE_URL` (public address), `EMNS_INTERNAL_URL` (how the scheduler reaches the app), `EMNS_ENV=production` (locks safety switches), `EMNS_PUBLIC_SUPABASE_URL` / `EMNS_PUBLIC_SUPABASE_KEY` (browser settings served at `/config.js`). Everything else is the same variable list as `.env.example`.

## AWS
`infra/aws` (Terraform) builds one Fargate service running the same containers, RDS, an HTTPS load balancer with a web firewall (per-address rate rule plus AWS managed rules), Secrets Manager and logs. See `infra/aws/README.md`.

## Software bill of materials
`npm run sbom` writes `docs/sbom.cdx.json` (CycloneDX 1.5: every production package, exact version, package URL, hash). Regenerate it whenever `package-lock.json` changes. Add `--all` to include development tools.

## Known limits and what is NOT verified
- **Not run end to end here.** The build environment for this work had no Docker, so `docker compose up`, the images and the Terraform have not been executed. Server, scheduler, scripts and SQL bootstrap were tested in code; run the steps above and report anything that fails. The image tags (`postgrest/postgrest:v12.2.12`, `supabase/gotrue:v2.174.0`, `axllent/mailpit:v1.21`) should be checked against what is current; override them in `.env.docker`.
- **Live inbox updates.** The Inbox uses Supabase Realtime for instant refresh. The container profile does not run a Realtime service, so the inbox updates on reload there. Adding the open-source Realtime server is a separate step.
- **Staff sign-in** uses the built-in account service in both profiles. `EMNS_AUTH_PROVIDER=oidc` applies to employee self-service.
- **Terraform** is a draft: it parses, but has not been planned or applied. Review it in a non-production account first.
