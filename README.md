# Shalom Adonai — Operations

Private operations workspace for Shalom Adonai. Team accounts can be created by email and password; a new account receives business access only after the owner approves its request.

## Local setup

Requirements: Node.js 24 LTS (or a newer supported LTS release), npm, and Docker or Podman for the local Supabase stack.

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
```

After copying the example, replace its URL and publishable-key placeholders in `apps/web/.env.local` with real values for the database you intend to use before starting Vite. Only a publishable/legacy `anon` key belongs in the browser; never place a service-role key, secret key, database password, or provider credential in a `VITE_` variable.

```bash
npm run dev
```

The canonical local app URL is `http://127.0.0.1:3000`. `http://localhost:3000` is a different browser origin; password-recovery allowlists must include the exact origin and `/redefinir-senha` path that you use. The local CLI configuration allows both origins.

**On this development machine, the current `apps/web/.env.local` points to the hosted Shalom Adonai Supabase project.** This ignored, unversioned file may differ on another machine. Opening the interface at `http://127.0.0.1:3000` runs the web app locally but does not make its database local: reads and writes still go to whichever URL is in `.env.local`. The `supabase/config.toml` file configures only the local Supabase CLI stack; its `project_id` does not connect the CLI or app to the hosted project. Keep local and hosted URLs/keys distinct when testing data changes.

The application supports email/password sign-up. Each new account creates an access request; it cannot read business records until the owner approves it. The local CLI configuration allows sign-up and disables email confirmation to match the current Auth flow. These local settings do not change Auth settings on the hosted project. Password recovery builds its callback from the current browser origin and `/redefinir-senha`; on the hosted project, allow the exact origin you use (`http://127.0.0.1:3000` or `http://localhost:3000`) and the production origin, and configure working email delivery.

## Local database

These commands start and reset only the local database. `db reset` reapplies the migrations and does not copy hosted users, the business, or operating records:

```bash
npx supabase start
npx supabase db reset
npx supabase status
```

To use this local database from the web app, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `apps/web/.env.local` to the local API URL and local publishable/`anon` key shown by `supabase status`, then restart Vite. To return to the hosted project, restore its URL and publishable key. Never use a hosted service-role or secret key in the app.

A fresh local reset has no Auth users, Shalom Adonai business, or operational records. The public sign-up screen first looks up the business to which the account is requesting access. For an isolated local sign-up test, first create a throwaway local Auth user in the local Supabase Studio, then create its local business as that user's owner using the trusted local SQL Editor:

```sql
insert into public.businesses (name, timezone, currency, created_by)
values ('Shalom Adonai', 'America/Sao_Paulo', 'BRL', '<local-owner-auth-user-uuid>')
returning id;
```

The migration creates the matching owner membership automatically. Use a UUID from the local Auth instance only; this bootstrap is for the local database and is not needed for the already provisioned hosted business. Do not run `db push`, `db reset --linked`, or other remote database commands for this local setup.

## Commands

```bash
npm run lint
npm run build
npm run preview
```

## Current setup status — 2026-11-03

The hosted Supabase project is `ACTIVE_HEALTHY`. Hosted Auth currently allows email sign-up and auto-confirms email; new accounts still receive no business data access until the owner approves their request. The owner's confirmed Auth account, Shalom Adonai business, and owner membership are present. The hosted database has 22 recorded migrations; 9 newer migrations in `supabase/migrations/` are not applied yet, so some screens that call their database functions currently return errors. Customer interaction entry falls back to its prior RPC until the pending idempotency migration is applied; retry protection is not active on that legacy path. Multiple named customer addresses are implemented in the repository, but the hosted address table is pending; the legacy principal address remains editable. `supabase/config.toml` describes the local CLI stack; it does not configure the hosted project's Auth or database.

The repository already includes customer and product records, named customer delivery addresses with order-specific snapshots, optional private product photos, manual call history and follow-ups, orders and receivables, stock tracking and physical purchase receipts, combo component snapshots, delivery assignments and explicit customer pickup, paid outflows, managerial reports, and manual bank-movement reconciliation. No demonstration customer, stock, order, or financial records are seeded; the owner will provide and enter operational data progressively using the existing forms. Bank movements are transcribed manually: Open Finance and statement-file import are not connected.

Stable production hosting and domain, hosted Auth redirects and recovery email delivery, end-to-end verification of the hosted schema and permissions, and the WhatsApp, banking, and fiscal provider integrations remain to be completed. WhatsApp number onboarding is intentionally deferred; fiscal details require the accountant's guidance. The temporary preview is for review, not production.
