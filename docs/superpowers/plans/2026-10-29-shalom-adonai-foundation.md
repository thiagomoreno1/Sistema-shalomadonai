# Shalom Adonai Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Milestone 0 as a secure, responsive Portuguese owner shell with a versioned PostgreSQL authorization foundation.

**Architecture:** A Vite React/TypeScript browser app uses Supabase Auth for the single owner's session and PostgreSQL RLS for private data. A business and membership schema is the authorization boundary; future provider integrations remain behind server-side adapters.

**Tech Stack:** React, TypeScript, Vite, React Router, `@supabase/supabase-js`, Supabase CLI/PostgreSQL, npm.

**Spec:** `docs/technical-plan.md` and the user-provided “MASTER SOFTWARE ENGINEERING PROMPT — Shalom Adonai”.

## Global Constraints

- “Language and localization: Brazilian Portuguese interface, BRL currency, Brazilian date and number formats, and the `America/Sao_Paulo` timezone.”
- “No delivery-worker accounts, driver portal, or driver login.”
- “AI is not a required first-release feature.”
- “Never expose private API credentials in browser code.”
- “The browser must never receive a Supabase service-role key or another server secret.”
- “Do not hard-code [AI credentials], expose [them] in browser code, or invent that the API is already available.”
- “Do not iframe WhatsApp Web, scrape or automate an unofficial browser session, copy session cookies, reverse-engineer private endpoints, or present an unsupported mirror as a reliable integration.”
- “Do not enable customer-facing automation with invented message copy or unconfirmed trigger logic.”
- “Do not silently invent a profit formula.”
- “Do not silently omit historical data.”
- “Use client-brand assets where provided, but do not copy the proposal page’s Arvello neon look into the actual business interface without a design decision.”

## Review Focus

- Missing or malformed Supabase environment values must block the private shell and explain setup; no demo identity or data appears.
- Session initialization and sign-out must not leave protected routes rendered for an unauthenticated visitor.
- Recovery requests must not reveal whether an email is registered; password updates require a valid recovery session.
- Membership policies must not recurse through RLS or let a user modify another business' data or membership role.
- Long labels, narrow phone viewports, keyboard navigation, and reduced-motion preferences must remain usable.

---

## File Map

- `apps/web/src/lib/supabase.ts` — typed browser client and environment validation.
- `apps/web/src/auth/AuthProvider.tsx` — auth session state and Supabase auth operations.
- `apps/web/src/auth/AuthRoutes.tsx` — public sign-in/recovery, password update, and protected app routing.
- `apps/web/src/components/AppShell.tsx` — desktop sidebar, mobile navigation, user menu, and route frame.
- `apps/web/src/pages/` — dashboard and clearly marked module placeholders without business data.
- `apps/web/src/index.css` and `apps/web/src/App.css` — responsive tokens and application styling.
- `apps/web/.env.example`, root `package.json`, and root `README.md` — safe setup and scripts.
- `supabase/config.toml` — local CLI configuration.
- `supabase/migrations/202610290001_business_access_foundation.sql` — business/member tables, grants, and RLS helpers/policies.
- `docs/technical-plan.md` — project architecture, data model, milestones, dependencies, risks, and acceptance checks.

## Task 1: Owner app shell and authentication

**Files:** the `apps/web/src/**` paths above, `apps/web/index.html`, `apps/web/.env.example`, and root package/workspace docs.

**Interfaces:** `SupabaseClient | null` from the client setup; auth context exposes configured/loading/session/error state; shell navigation uses named React Router paths; no business CRUD APIs are introduced.

- [x] Replace generated Vite content with the Shalom Adonai owner interface in Brazilian Portuguese; use provisional neutral/ink surfaces and one restrained green accent, without proposal branding or fabricated records.
- [x] Add email/password sign-in, generic reset-request feedback, recovery-link password update, route guard, sign-out, and a missing/malformed-configuration state. Do not add a sign-up flow.
- [x] Add responsive Dashboard, Customers, Atendimento, Orders, Catalog, Inventory, Deliveries, Finance, Reports, and Settings routes. Future modules must be visibly “Ainda não configurado/em implementação” rather than reporting fake activity or connection success.
- [x] Build and lint the web workspace; inspect desktop and phone render states for setup/sign-in/recovery, keyboard focus, missing-config behavior, and reduced-motion styles. Review the authenticated shell from source until a real owner account exists.

## Task 2: Database access foundation

**Files:** `supabase/config.toml` and `supabase/migrations/202610290001_business_access_foundation.sql`.

**Interfaces:** `businesses.id` is the stable partition key; `business_memberships` contains `business_id`, `user_id`, and the constrained `owner`/`staff` role. RLS helper functions are schema-qualified, `SECURITY DEFINER`, and use an empty search path.

- [x] Add business and membership tables with foreign keys, unique owner membership, explicit authenticated grants, RLS enabled, and policies that scope access to a member's business.
- [x] Allow only an authenticated creator to create a business and its initial owner membership; permit the owner policy needed for future staff membership records, without adding staff UI.
- [x] Replay all migrations in an isolated local Supabase database through GitHub CI; pgTAP verifies anonymous users cannot execute `create_order` and that owner/staff/other-business contexts are isolated in the order workflow. This is database-role/claim verification, not a real Auth sign-in or recovery-email test.

## Task 3: Documentation, review, and handoff

**Files:** root `README.md` and the two plan documents.

- [x] Document local setup, environment variables, account provisioning, migrations, and the fact that production keys/accounts and hosting are not yet configured.
- [x] Reconcile the implementation with Milestone 0 acceptance checks; record the actual build, lint, local migration, and responsive review outcomes.
- [x] Request independent software-engineering and product-design source reviews of the completed Milestone 0 diff and resolve material issues. The designer's rendered review limitation is recorded in the technical plan; key views were inspected directly.
- [x] Commit and push the coherent milestone to the new private GitHub repository.

## Scope Boundary

This milestone does not enable business sign-up, create delivery-worker accounts, seed customer/business data, issue fiscal documents, sync a bank, connect WhatsApp, activate automated customer messages, calculate profit, migrate historical records, or configure production hosting. Those require the relevant client/provider facts and end-to-end proof described in `docs/technical-plan.md`.

---

## Task 4: Owner records and follow-up queue

**Files:** `supabase/migrations/202610290002_customer_product_records.sql`, `apps/web/src/business/**`, `apps/web/src/pages/{CustomersPage,CustomerDetailPage,ProductsPage,FollowUpsPage}.tsx`, and the shared shell/data helpers.

- [x] Add owner-only, business-scoped RLS tables and atomic interaction-plus-follow-up creation.
- [x] Add customer and product list/create/edit/archive flows, manual contact history, and follow-up queue.
- [x] Structure call outcomes, require same-day follow-up for missed calls, preserve paginated call history, and keep archived customer history readable/restorable.
- [x] Detect multiple owner-business memberships rather than silently selecting one; ensure catalog copy and mutation feedback match implemented behavior.
- [x] Add dashboard follow-up visibility and clear empty/error/loading states.
- [x] Add direct customer/product and catalog RLS tests: owner create/read/update and archive/restore, staff and cross-business denials, anonymous table grants, and address update/delete/default-promotion paths. CI replays migrations and runs these pgTAP checks against an isolated local database; hosted HTTP authentication still requires separate acceptance.
- [ ] Inspect the authenticated screens at desktop and phone sizes. The hosted project exists, but its schema currently lacks 12 repository migrations; complete this acceptance after the compatible schema is rolled out and a dedicated test session is available.
- [ ] Inventory and import existing customer/product records after their source files and duplicate-resolution rules are provided.
