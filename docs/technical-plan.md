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
