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

**Discovery backlog:** required customer fields and categories; phone logging sufficiency; product/basket/combo catalog and costs; payment/late/renegotiation rules; stock units and thresholds; delivery statuses and evidence; refunds, financial adjustments and returned-goods treatment; bank and statement format; fiscal document/provider; WhatsApp account and inbox capabilities; message copy/timing/consent; report filters; and migration formats/volume.

### Milestone 3 business decisions — 2026-10-29

- A product becomes stock-tracked only when it has a unit and an explicit opening count. A product without configured tracking is not shown as zero stock.
- Stock is deducted when a delivery order is dispatched or when the owner explicitly records customer pickup for an order without delivery. If the balance is insufficient, the handoff remains allowed after a negative-stock warning; the recorded final balance is preserved in history.
- Combos require a saved component composition. Each order preserves the component quantities as they were when that order was created.
- Only an order explicitly marked as a delivery creates a delivery record and appears in the delivery queue.
- An order not marked for delivery stays outside that queue. The owner explicitly records customer pickup when the goods are handed over; that action deducts tracked stock once and is saved in the order history.
- Use the delivery states from the brief: awaiting separation, ready, dispatched, delivered, attempted, rescheduled, and returned. Delivery workers are reusable records without login accounts.
- Goods returned after an attempted delivery or a recorded customer pickup are added back only through a manual inventory movement after inspection, capped by the quantity still sent for that order. A delivery status change alone never changes stock.
- Payment due dates and amounts remain entered per order; the software applies no default food or appliance payment term.
- A per-product minimum stock level is planned as optional with no default. Exact low-stock thresholds remain owner-configurable; no threshold or inventory data is seeded.
- Purchase receipts represent physically received goods. Their stock receipt does not itself record a payment, cash outflow, or expense; those belong to Milestone 4.
- Delivery evidence requirements, delivery time-window conventions, and the treatment of any delivery cost in management results remain for discovery in their relevant milestones.

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

## Milestone 3 implementation status — 2026-10-29

**Implemented in code:** the catalog can configure stock with a required unit and opening count, optional minimums, and saved combo recipes. Orders preserve their combo component quantities and are marked explicitly for delivery or left outside the delivery queue. The inventory screen shows tracked balances, low-stock signals, physical purchase receipts, manual adjustments/losses/inspected returns, and paginated movement history. Return entry now loads the order's tracked items and quantities still sent before allowing a product and quantity to be selected. Delivery workers are owner-managed records; the queue uses the agreed statuses, assignment and schedule notes, an explicit dispatch confirmation, and recorded negative-stock warnings. For a non-delivery order, the owner can explicitly record customer pickup; a retry-safe RPC deducts tracked stock, records the final negative balances if any, and preserves the event in the order history. An order with a recorded pickup cannot be canceled.

**Confirmed business choices:** unit and opening count are required to begin stock tracking; the owner may dispatch or record a pickup that leaves a negative balance after seeing a warning; only explicitly marked orders enter the delivery queue; pickup is a separate confirmed handoff; combos need a saved recipe and orders preserve its snapshot; delivery workers have no accounts; and physical returns are added only by a separate, manually inspected stock movement. Payment due dates and amounts remain per order. A purchase receipt records physical inventory only, with no payment, expense, or cash-flow effect.

**Source review and local checks:** independent software/security and product-design reviews inspected the migration and current source. Static review covered owner checks, grants and RLS, request retries, combo quantity bounds, business-scoped links, and immutable movements. The migration review found no new material authorization gap; the product review identified a return-selection ambiguity, stale delivery actions after load failure, and missing focus management, which were corrected in the UI. The review was source-based; browser inspection was unavailable because the Chrome DevTools profile was already in use. `npm run lint`, `npm run build`, and `git diff --check` are run for this milestone; see the final change record for results.

**Not verified against PostgreSQL/Supabase:** the inventory/delivery and pickup migrations have not been replayed. Docker Desktop's Linux engine is unavailable, and no matching Shalom Adonai Supabase project is connected. The frontend build and static review do not verify migration execution, RLS under authenticated identities, stock concurrency, pickup/dispatch RPC behavior, or database retry behavior. Live sign-in, owner data, email delivery, and production hosting remain unavailable. No production deployment is configured; this milestone is code-ready for a configured database but is not an end-to-end verified release.

## Milestone 4 implementation status — 2026-10-29 (in progress)

**Implemented in code:** `/financeiro/saidas` records only purchases of stock for resale, operating expenses (including other purchases), and real delivery costs already paid; each row stores its paid date and amount. The type must be explicitly chosen. The owner can optionally link a stock purchase payment to physical inventory receipts and a delivery cost to an order. Those links are informational: inventory receipt does not infer payment, and a customer delivery fee does not infer actual delivery cost. Incorrect entries can be voided with a required reason; the original and void event remain in history, but the voided amount is removed from reports and cash/result totals. A void is an entry correction, not a money refund. No accounts payable, due dates or unpaid balances are modeled. `/relatorios` combines order totals, manually reported receipts, receivables, paid outflows, and known net recorded cash movement. The dashboard displays today's paid outflows and net recorded movement. CSV and print include the selected range and source detail.

**Confirmed result policy:** the owner approved `completed order total after discount (product subtotal + customer delivery fee - discount) - order-line frozen item cost - paid operating expenses - paid real delivery costs`. An order is recognized on successful delivery or recorded customer pickup; a dispatched-but-not-completed delivery is not yet a sale in this formula. Expenses use payment date. Paid inventory purchases appear as cash outflows but do not reduce the result; the frozen order-line cost is recognized when an item sells. The report discloses the separate date bases. It withholds the numeric result if an included line lacks frozen cost or if a physical return is recorded after handoff, because refund/return treatment is not configured. No bank verification is implied.

**Still outside this slice:** refunds and financial adjustments; bank reconciliation; fiscal, WhatsApp and messaging integrations; historical-record migration; and production configuration. Order product-cost snapshots may remain blank when catalog cost was not set before order creation.

**Source reviews:** the prior report slice received static product, engineering and RLS review. For this paid-outflow extension, product and engineering reviews led to explicit transaction types, audited voids, and date refresh behavior. SQL/RLS review found no material owner-isolation, tenant-link, privilege or monetary-overflow issue; its separate `TRUNCATE` audit-trail finding was closed with statement-level reject triggers on all three outflow tables. Reviews are source-only, not rendered browser checks.

**Verification and deployment:** `npm run lint`, `npm run build`, and `git diff --check` pass for this extension. `npx --yes supabase@2.122.0 db lint --local` was attempted and cannot connect to PostgreSQL at `127.0.0.1:54322`; the migration has not been applied or executed. No matching Shalom Adonai Supabase project is connected. SQL compilation and authenticated runtime behavior remain unverified; no production database or deployment was changed.

## Milestone 5 setup and decisions — 2026-10-29 (in progress)

**Owner decisions:** prepare visible setup areas for WhatsApp, banking, and fiscal documents without claiming a provider is connected. Do not enter or provision the WhatsApp phone number yet. Use Open Finance as the first banking proof path. The company is in Niterói, Rio de Janeiro; tax regime, document types, and fiscal provider remain for the accountant to confirm. The owner will provide customer, product, stock, order, and finance data gradually as those workflows are built; no historical files or sanitized samples are required before beginning that work. For initial intake, use the existing manual forms; do not require spreadsheets or build a batch importer yet. Once source records are supplied, inspect their format and volume before deciding whether manual entry or a tailored import is appropriate.

**Supabase provisioning:** the owner approved a new `shalom-adonai` project in the only available organization and the São Paulo region (`sa-east-1`). The organization is on the Free plan. The Supabase tool quoted $0 monthly for a free project, but creation was rejected because the account already has two active free projects: `sistema-estetica-automotiva-teste` and `Atelier Approach`. No database project was created or changed. The owner explicitly decided to keep the inactive `app-gestao-financeira` project separate; do not reuse or resume it for Shalom Adonai. Do not pause or repurpose the two active projects. Supabase bills by organization, and upgrading this organization to Pro would affect all its projects. Current official documentation lists a $25/month Pro fee and $10 in monthly compute credits; at the default Micro size, three full-month active projects are estimated at $45/month total before taxes or overages. This is an estimate, not an organization-specific quote or authorization to upgrade.

**Open Finance proof:** [Banco Central guidance](https://www.bcb.gov.br/estabilidadefinanceira/cliente-open-finance) requires consent through a participating receiving institution and authentication at the transmitting institution. [Belvo's sandbox documentation](https://developers.belvo.com/apis/belvoopenapispec/section/introduction/sandbox) describes dummy data, a widget, endpoints, and webhooks; production access requires a separate request and certification. This gives the project a possible provider-backed sandbox route, but no provider account, credentials, or bank consent has been supplied. A sandbox test must be labeled as such and must not be reported as a live bank connection.

**Not yet verified:** WhatsApp account and number onboarding; an Open Finance sandbox test; actual bank consent and account data; accountant-confirmed fiscal requirements; Supabase schema replay and authenticated access; and source-file inventory/import. No bank credentials, WhatsApp number, fiscal certificate, or customer data have been stored.

## Data API permission preflight correction — 2026-10-29

A static audit of the direct browser writes found that `ProductsPage` includes `is_active` when inserting a product, while the authenticated column-level INSERT grant created in `202610290002_customer_product_records.sql` omitted that column. Added `20261029230639_allow_product_active_insert.sql` to grant only INSERT on `products.is_active` to `authenticated`; the existing owner RLS policy still determines which rows may be inserted. The audit found no comparable field/grant mismatch in the other direct table writes inspected.

The [Supabase Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) rolls out by default to new projects and is scheduled to apply to all existing projects on 2026-10-30. Migrations in this repository explicitly grant only required table/function access; verify those grants and Data API reachability against the actual Shalom Adonai project when it is available. The new migration is not applied or runtime-tested: the Supabase project is still unavailable and Docker's Linux engine is not running locally.
