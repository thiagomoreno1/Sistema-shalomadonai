# Shalom Adonai — Operations

Private operations workspace for the owner of Shalom Adonai. The application is a separate product from the commercial proposal site.

## Local setup

Requirements: Node.js 24 LTS (or a newer supported LTS release), npm, and Docker for the local Supabase stack.

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `apps/web/.env.local`. These values identify the Supabase project and are intentionally public browser configuration. Never add a service-role key, secret key, database password, or provider credential to a `VITE_` variable or browser bundle.

The app does not provide public registration. Create the owner account through the Supabase project’s trusted admin setup, disable public sign-ups in Auth settings, and configure the allowed redirect URLs for local and production environments. Include the exact `/redefinir-senha` path for each hostname in the Supabase Auth redirect allowlist; the local CLI config already includes both localhost forms. Password recovery also depends on working email delivery for the Supabase project.

## Database

The SQL migrations in `supabase/migrations/` are the versioned source for the database schema. Install the current Supabase CLI, then run:

```bash
npx supabase start
npx supabase db reset
```

These commands use only the local development stack. Do not run `db push`, `db reset --linked`, or other remote database commands until the correct non-production or production project has been identified and explicitly configured.

For a fresh project, provision the owner's Auth account first. Then, in the trusted Supabase SQL Editor, create the initial business and owner membership with the Auth user UUID:

```sql
insert into public.businesses (name, timezone, currency, created_by)
values ('Shalom Adonai', 'America/Sao_Paulo', 'BRL', '<owner-auth-user-uuid>')
returning id;
```

Run this through the trusted Supabase SQL Editor after replacing the placeholder with the owner's real Auth UUID. The migration creates the matching owner membership automatically in the same transaction. No client records, stock, or financial data are seeded by this repository.

## Commands

```bash
npm run dev
npm run lint
npm run build
npm run preview
```

## Current setup status

The repository now includes the application/auth foundation, owner-managed customer and product records, manual call history, follow-up queue, orders and receivables, stock tracking, physical purchase receipts, combo component snapshots, delivery assignments, explicit customer pickup, paid outflows and managerial reports. The owner dashboard surfaces follow-ups, due and overdue installment balances, delivery work due for attention, and stock below configured minimums or with a negative balance. The finance area also has a manual bank-movement and reconciliation foundation: accounts, signed movements, exact one-to-one matching, duplicate flags, and correction history. Bank movements must be transcribed from a source; this does not connect to Open Finance or import statement files. Only orders marked for delivery enter the delivery queue; customer pickup is confirmed from the order and deducts tracked stock at handoff. A live Shalom Adonai Supabase project, owner identity, email delivery, production hostname, hosting account, bank/fiscal/WhatsApp providers, and historical source records still need to be supplied or confirmed before those workflows can be completed. The latest migrations have not been replayed against PostgreSQL, and the interface must not be treated as production-ready until the acceptance checks in `docs/technical-plan.md` are verified end to end.
