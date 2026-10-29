# Shalom Adonai Operations System — Technical Plan

## Goal and scope

Build a private, owner-operated system that connects customers, contacts, calls, orders, payments, stock, deliveries, finance, and supported integrations. The owner is the only app user in the first release; delivery workers remain assignment records without accounts. The interface is Brazilian Portuguese, uses BRL, and interprets business dates in `America/Sao_Paulo`.

This repository is separate from the commercial proposal site. Its initial milestone establishes the app foundation, owner sign-in and recovery, the responsive navigation shell, versioned database migrations, and a safe authorization pattern. Business modules and external integrations follow as independently validated milestones.

## Architecture and repository

- **Web:** React, TypeScript, Vite, semantic HTML, and CSS in `apps/web/`.
- **Data and identity:** Supabase Auth and PostgreSQL. Browser access uses the Supabase publishable key and user session; exposed tables use least-privilege grants and Row Level Security (RLS). Service-role keys and provider secrets stay server-side.
- **Backend extensions:** a small modular monolith. Supabase Edge Functions and narrow server-side adapters handle provider webhooks, fiscal/bank operations, and WhatsApp where those integrations are verified. No microservices are planned.
- **Schema:** versioned SQL in `supabase/migrations/`. Business records belong to a business and are authorized through membership; the initial UI exposes only the owner workflow, while the schema can represent later staff roles.
- **Hosting:** undecided until the client’s account, domain, and operating costs are confirmed. Cloudflare Pages is a candidate for the static Vite app; no production deployment is configured.

## Domain model

Use UUID keys, foreign keys, explicit status values, `timestamptz` for event times, `America/Sao_Paulo` for business-calendar calculations, integer cents (or fixed-precision numeric where fractional units are needed), and audit history for material changes.

Core entities are:

- Businesses and memberships; customers, contacts, addresses, tags, interactions, calls, and follow-up tasks.
- Product categories, products, assets, combos, and combo components.
- Orders and lines; installments, payments, refunds, adjustments, renegotiations, delivery assignments, and delivery-status history.
- Inventory movements, purchases, suppliers, expenses, bank accounts, imported bank transactions, reconciliation batches, and matches.
- Fiscal document references; WhatsApp connections, conversations, messages, webhook events, consent/opt-out records, automation rules, message attempts, and internal notifications.
- Import batches, row-level import errors, and audit events.

The model must not infer a universal payment term, inventory rule, late fee, tax treatment, or profit formula. Each is confirmed with the owner (and accountant for tax/accounting) at the relevant module milestone.

## Delivery milestones

| Milestone | Deliverable | Main dependencies / exit checks |
| --- | --- | --- |
| 0 — Foundation | Private repository, React/TypeScript app shell, owner sign-in/recovery, RLS foundation, setup docs | Build succeeds; no public sign-up; auth and RLS configuration are explicit; responsive shell has no invented business data |
| 1 — Owner dashboard and base records | Priorities, customers, products/categories, activity history, import templates | Owner can add/find/review records; empty/loading/error states; import validation and duplicate detection |
| 2 — Calls and sales workflow | Manual call log, follow-up queue, catalog/combos, orders, installments/receivables | Confirm customer fields, manual call flow, combo rules, payment schedules, partial-payment and renegotiation policies |
| 3 — Inventory and deliveries | Stock ledger, purchasing, low-stock signals, owner-managed delivery assignments | Confirm units, thresholds, returns/losses, worker assignment, statuses, and failed-delivery handling |
| 4 — Finance and reports | Receipts, receivables, purchases, expenses, cash flow, daily/monthly reports | Agree result formula and cost basis; reconcile reports to transaction records |
| 5 — Integration proofs | Supported WhatsApp inbox, bank statement or connection, fiscal provider workflow, approved message rules | Test with the client’s actual or approved non-production account/file; obtain provider, accountant, consent, and policy details |
| 6 — Migration and handoff | Existing records imported/entered, reconciliation summaries, usage and recovery guidance | Inspect source formats and volume first; report successes, duplicates, and errors; reconcile counts/totals |

## Dependencies, risks, and discovery backlog

**External dependencies:** Supabase project and owner identity; email delivery for account recovery; a selected hosting account/domain; WhatsApp Business Platform/provider and approved number; bank/provider or supported statement files; fiscal provider plus CNPJ/state/tax details from the accountant; source records for migration.

**Risks:** unknown source-record volume and quality; provider onboarding, eligibility, and usage costs; fiscal and accounting rules; changing payment/stock/delivery practices; and an unapproved profit formula. Do not claim an integration is complete without an end-to-end test. Keep customer-facing automation paused until message content, trigger rules, channel capability, consent, and stop behavior are approved.

**Discovery backlog:** required customer fields and categories; phone logging sufficiency; product/basket/combo catalog and costs; payment/late/renegotiation rules; stock units and thresholds; delivery statuses and evidence; manager-result formula; bank and statement format; fiscal document/provider; WhatsApp account and inbox capabilities; message copy/timing/consent; report filters; and migration formats/volume.

## Milestone 0 acceptance checks

1. The app builds and starts from the documented commands.
2. The sign-in screen offers no public registration; reset requests use enumeration-safe messaging; authenticated users can set a new password from a recovery link.
3. Missing or malformed Supabase URLs/keys produce a clear setup state, not a crashed app or a fake signed-in session. Only publishable and legacy `anon` keys are accepted in browser configuration.
4. Every private database foundation table has explicit grants and RLS; anonymous access is denied, and a user's membership scope is enforced in PostgreSQL.
5. No service-role key, provider secret, sample customer, or fake business metric is present in browser code.
6. The owner shell is usable by keyboard and on phone; touch targets, visible focus, status text, and reduced-motion behavior are present.
7. Local migration replay and build output are checked. Production auth, data, and deployment remain pending until the client project and account details are available.

## Milestone 0 implementation status — 2026-10-29

**Completed and checked:** the React/TypeScript shell, email/password sign-in and recovery screens, route guard, missing/malformed-configuration state, non-demo empty states, Portuguese navigation, and database access foundation are in the repository. Browser configuration accepts a current publishable key or legacy `anon` JWT, requires HTTPS outside loopback, and rejects invalid URLs and secret/service-role keys before creating a client. The Vite config exposes no arbitrary `VITE_` values and injects only validated public Supabase settings, preventing an accidentally configured secret key from being embedded. `npm run build` and `npm run lint` pass. The setup and sign-in/recovery screens were inspected in Chrome at desktop width and phone widths of 390px and 320px; the tested pages had no horizontal overflow, keyboard focus was visible, reduced-motion mode was enabled, and no browser console errors were observed.

**Reviewed but not runtime-verified:** the Supabase CLI v2.122.0 read `supabase/config.toml`; an independent security review found the RLS/grant pattern and corrected owner-provisioning path coherent. A product-designer source review raised a sign-out exception edge case that was fixed; its rendered review was blocked because its browser tool could not identify the active URL. Local Supabase startup could not proceed because Docker Desktop's Linux engine was unavailable, and `db lint --local` could not connect to a local Postgres service. The migration has not been replayed, and anonymous denial, two-identity isolation, actual sign-in, password-recovery email delivery, and sign-out have not been tested against a Supabase project.

**Still pending:** a real Supabase project and owner account, production hosting/domain, full operational modules and business-rule discovery, verified WhatsApp/bank/fiscal providers, historical data inventory/import, and the remaining production acceptance checks. No real customer data, provider secret, or service-role key is in the repository. This milestone is a foundation, not a production-ready release.

## Milestone 1 implementation status — 2026-10-29

**Implemented in code:** owner membership resolution that stops on ambiguous multiple-business membership; owner-scoped records for customers, product categories, products, manual customer interactions, and follow-up tasks; searchable active and archived customer lists; customer history with reactivation; product create/edit/archive flows; a manual call log with structured outcomes and editable timestamps; paginated global call history; and a due-date follow-up queue. Interaction recording uses an owner-checked RPC with direct interaction inserts withheld, so a missed call and its same-day high-priority follow-up are atomic. Prices and costs use integer cents. Customers require a name; phone and one delivery-address field are optional. Product categories, units, costs, and prices can remain unset on inactive records. Product records do not claim a stock balance, combo composition, image, or price history.

**Business choices kept provisional:** phone and delivery address are optional; a customer currently has one free-form delivery-address field; product categories are owner-defined; priority uses low/normal/high; call outcomes are constrained to answered/missed/other; and WhatsApp entries are explicitly manual notes. Multiple contacts/addresses, phone duplicate handling, imports, product media, combo composition, inventory movements, opening stock, and price/cost history remain later work or require discovery.

**Local checks and source review:** `npm run lint`, `npm run build`, and `git diff --check` pass. Read-only software, product-design, and RLS reviews found issues that were corrected; the final RLS review found no material authorization gap in the owner-checked interaction RPC.

**Not verified against PostgreSQL/Supabase:** the new migration has not been replayed because Docker Desktop's Linux engine is unavailable. RLS behavior, RPC execution under an authenticated role, CRUD, and sign-in against a real owner account still need runtime verification. The UI requires a seeded owner membership; setup instructions remain in the README. Existing paper or digital records have not been inventoried or imported because no source files were provided.

## Milestone 2 implementation status — 2026-10-29

**Implemented in code:** owners can create an order from active priced catalog products, review a customer/address snapshot and immutable line price/cost snapshots, enter discount and delivery fee, and provide the due date and amount of every installment manually. The schedule must equal the server-computed order total; no 30-day or 12-installment preset is applied. Order list/detail views separate sale total, manually recorded receipts, and outstanding balance. Partial receipts require explicit allocation to one or more installment balances; the receipt and allocations are written atomically by an owner-checked RPC, which serializes receipts on the order and prevents overpayment. An order can be cancelled only before its first receipt, and history remains visible.

**Receivables view:** `/financeiro` now presents open installment balances as overdue, due today, or upcoming using the business date in `America/Sao_Paulo`. Late status is derived from a manually entered due date and unpaid balance. The view paginates database results and batches order IDs so API row limits do not silently truncate balances. It does not charge interest or trigger a reminder. The payment date/time field is interpreted in Brasília time, a blank time uses the database clock, and the database rejects future-dated receipts. Retry IDs are retained after ambiguous transport/server failures to prevent duplicate orders or receipts. Cancelled schedules show no amount due. Payment wording makes clear that the owner is recording a reported receipt, not processing a payment.

**Business choices preserved:** the owner answered that each order must carry its own manually entered due dates and amounts. The commonly observed food and appliance terms are not defaults. Method labels remain free text. Interest, reminders or reminder state, message automation, credit/renegotiation, refunds, write-offs, stock/combo effects, delivery statuses, fiscal/bank/WhatsApp workflows, and managerial profit calculations remain unimplemented until their policies and data sources are confirmed.

**Static review and local checks:** independent software, product-design, and RLS reviews inspected the source diff. Corrections addressed ambiguous mutation retries, future receipt timestamps and timezone interpretation, canceled installment balances, allocation mismatch feedback, keyboard focus on receipt entry, zero-value success feedback, loading-state summaries, API result pagination, mobile touch target size, and overdue receivables visibility. The product review was source-based; browser inspection was unavailable because the Chrome DevTools profile was already running. `npm run lint`, `npm run build`, and `git diff --check` pass after corrections.

**Not verified against PostgreSQL/Supabase:** migration `202610290003_orders_and_receivables.sql` has not been replayed or exercised with two identities. Docker Desktop's Linux engine was unavailable; Supabase CLI and `psql` were also absent in the local environment. A successful frontend build does not verify migration syntax, RLS, or RPC behavior. A configured Supabase project and owner account are still needed for end-to-end verification. This milestone does not complete the broader operations system or production release.
