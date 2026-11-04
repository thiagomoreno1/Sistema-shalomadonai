# Shalom Adonai Orders and Manual Receivables Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner record an order from current catalog items, enter its payment schedule explicitly, record partial receipts against chosen installments, and review the outstanding balance without applying unconfirmed payment, delivery, or inventory policies.

**Architecture:** Extend the existing React/Vite client and Supabase/PostgreSQL schema. The browser reads records through owner-scoped RLS and uses owner-checked transactional RPCs for order, payment, and cancellation mutations. Order lines and customer/address data are snapshots; monetary values stay in integer cents.

**Tech Stack:** React, TypeScript, React Router, Supabase JS, PostgreSQL migrations, existing CSS system.

**Spec:** `docs/technical-plan.md`; user-pasted `MASTER SOFTWARE ENGINEERING PROMPT — Shalom Adonai`, especially sections 7.5–7.6, 12–13, and 14.

## Global Constraints

- “Do not assume that every product always uses these terms.”
- “Confirm the exact rules for payment schedules, due dates, late payments, and renegotiations during the relevant development phase.”
- “Do not automatically charge interest or fees without explicit confirmation.”
- “Do not use binary floating-point arithmetic for financial totals.”
- “Keep payment terms configurable by order or product category after confirming the business policy.”
- “The browser must never receive a Supabase service-role key or another server secret.”
- “Enforce authentication and authorization on every private route and database operation.”
- “Keep animations subtle and functional. Respect reduced-motion preferences.”

## Review Focus

- Cross-business customer, product, order, installment, payment, and allocation references must be rejected by composite foreign keys and owner checks.
- Catalog edits after an order must not rewrite the order's recorded product name, unit, price, or cost snapshot.
- Installment totals must equal the order total; payment allocations must equal the receipt and cannot exceed installment balances, including concurrent requests.
- Cancellation must preserve history and must not strand an already-recorded receipt without a refund workflow.
- BRL totals, business-local dates, narrow mobile layouts, validation, loading, success, and recoverable errors must remain understandable.

---

## Task 1: Owner-scoped order and receivable schema

**Files:**

- Create: `supabase/migrations/202610290003_orders_and_receivables.sql`
- Modify: `docs/technical-plan.md`

**Interfaces:**

- `create_order(p_business_id uuid, p_customer_id uuid, p_delivery_address text, p_delivery_fee_cents bigint, p_discount_cents bigint, p_notes text, p_items jsonb, p_installments jsonb, p_request_id uuid) returns uuid`. Items are `{product_id, quantity}`; the database snapshots current active product data and price. Installments are `{amount_cents, due_on, payment_method}`. The RPC creates one open order and requires installment totals to equal the computed order total.
- `record_order_payment(p_business_id uuid, p_order_id uuid, p_amount_cents bigint, p_received_at timestamptz, p_payment_method text, p_notes text, p_allocations jsonb, p_request_id uuid) returns uuid`. Allocations are `{installment_id, amount_cents}` and are chosen explicitly by the owner.
- `cancel_order(p_business_id uuid, p_order_id uuid, p_reason text) returns uuid`. Cancellation is allowed only when no receipt exists.
- Order reads expose snapshots, lines, installments, payment allocations, totals, and status history under owner RLS. Authenticated clients receive no direct insert/update/delete access to financial ledger rows.

- [x] Add business-scoped tables for orders, order lines, installments, payments, payment allocations, and order events, with owner-only RLS, composite tenant foreign keys, idempotency keys, append-only payment history, and integer-cent constraints.
- [x] Implement the three transactional RPCs with a pinned empty `search_path`, owner checks before reads/writes, locks around installment balances, exact allocation validation, and safe cancellation rules.
- [x] Review the migration statically for privilege boundaries and SQL invariants. The GitHub CI run on `f2a8799` replayed all 34 migrations in an isolated local Supabase database and passed both pgTAP files (99 assertions), including owner/staff/other-business checks. This does not verify hosted Auth or HTTP behavior.

## Task 2: Order creation, list, and detail

**Files:**

- Create: `apps/web/src/pages/OrdersPage.tsx`
- Create: `apps/web/src/pages/NewOrderPage.tsx`
- Create: `apps/web/src/pages/OrderDetailPage.tsx`
- Modify: `apps/web/src/auth/AuthRoutes.tsx`
- Modify: `apps/web/src/pages/CustomerDetailPage.tsx`
- Modify: `apps/web/src/components/Icon.tsx` if a required icon is missing
- Modify: `apps/web/src/App.css`

**Interfaces:** consume `useBusiness()`, active customers, active priced catalog items, and the RPC signatures from Task 1. From customer detail, `/pedidos/novo?cliente=<id>` preselects that active customer.

- [x] Add a responsive owner flow for customer/address, catalog items and quantities, explicit discount/delivery fee, and one or more manually entered due dates and amounts. Do not prefill a payment-term preset; leave method labels as manual text and do not imply that a payment was processed.
- [x] Validate on the client for feedback and rely on the database RPC for authoritative totals, tenant ownership, and installment invariants. Preserve form entries on failure and reuse the request id when retrying an uncertain create.
- [x] Replace the `/pedidos` placeholder with open/cancelled order lists, true empty/loading/error/retry states, and links to order detail. Show sales total, received amount, and outstanding amount as separate figures.
- [x] Add order detail with immutable line snapshots, schedule, payment history, remaining balances, explicit partial-payment allocations, and cancellation only before the first receipt.
- [x] Add a manually prioritized receivables view at `/financeiro` with open installment balances grouped by overdue, due today, and upcoming. Overdue is derived from the business date and remaining balance; reminder state and automated messages remain pending policy and provider confirmation.
- [x] Add a “Novo pedido” entry point on active customer details; do not add combo-stock deductions, delivery-worker logins, fiscal, banking, or WhatsApp behavior here.
- [x] Keep the financial-entry flow still, with immediate button/status feedback and complete reduced-motion behavior.

## Task 3: Checks and handoff

- [x] Run `npm run lint`, `npm run build`, and `git diff --check` after the final review corrections; all pass.
- [x] Verify migration and RPC behavior against a fresh local database in GitHub CI; all 34 migrations replay and both SQL suites pass (99 assertions). Hosted deployment and HTTP authentication remain unverified.
- [x] Request read-only software/RLS and product-design reviews of the coherent order/receivable diff; address material findings and request follow-up reviews for the corrections.
- [x] Update the technical plan with completed code, verified runtime behavior, and still-open decisions.

## Business-policy boundary for this slice

The owner explicitly chose manual due dates and amounts for every order. Do not generate the commonly observed 30-day food schedule or 12 appliance installments. Payment method labels are manual text only. Do not add interest, fees, automatic payment allocation, overpayment credit, renegotiation, refunds, write-offs, payment reminders, sales-to-stock movements, combo component deductions, delivery lifecycle values, or profit calculations in this slice; their policies and data dependencies remain to be confirmed in the relevant milestones.
