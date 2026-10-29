# Shalom Adonai Finance and Reports Plan

> **For agentic workers:** Use `superpowers:executing-plans` to continue this milestone task by task.

**Goal:** Give the owner a reliable daily and monthly view of recorded sales, receipts, receivables, purchases, expenses, delivery costs, and cash movement, with each figure tied to its source records.

**Architecture:** Extend the existing React/Vite app and Supabase/PostgreSQL schema. Reuse order, installment, payment, and physical inventory-receipt records. Add owner-scoped financial outflow records and narrow owner-checked database functions for writes and period summaries. Keep inventory receipt and financial payment effects separate unless explicitly linked. Use business-local dates in `America/Sao_Paulo` and integer cents.

**Tech Stack:** React, TypeScript, React Router, Supabase JS, PostgreSQL migrations, existing CSS system.

**Spec:** `docs/technical-plan.md`; user-pasted `MASTER SOFTWARE ENGINEERING PROMPT — Shalom Adonai`, especially sections 7.9, 7.10, 12–14.

## Confirmed business rules

- Every order continues to carry explicitly entered due dates and installment amounts; no product-wide default term is inferred.
- An inventory receipt records physical goods only. It does not create a financial purchase, cash outflow, expense, or profit entry.
- Distinguish order totals, receipts manually reported by the owner, open/overdue installment balances, purchases, operating expenses, delivery costs, and actual recorded cash inflow/outflow.
- Only actual receipts and paid financial events count as cash movement. A recorded payment is not processed by the app, and no bank account is connected.
- The result/profit formula is not confirmed. Do not calculate margin or profit until the owner confirms the cost basis, treatment of discounts, delivery fees/costs, installment sales, and inventory purchases. Order cost snapshots may be absent and must not be treated as complete cost data.
- No bank, fiscal, WhatsApp, migration, production database, or production deployment work is included in this milestone slice.

## Discovery still open

- Whether purchase/expense entry must support unpaid obligations, due dates, multiple/partial payments, or only transactions that have already been paid.
- Whether the proposed managerial result formula is accepted or needs changes.
- How cancellations should be represented in historical sales reports. Existing orders have `cancelled_at` but no refund or adjustment workflow.
- Delivery costs are not currently recorded as financial events.

## Review focus

- Show every financial concept separately and label each date basis: order creation, reported receipt time, installment due date, or actual payment date.
- Keep historical cancellations visible rather than silently rewriting a prior period.
- New tables require explicit grants, owner-scoped RLS, tenant-safe foreign keys, append-only financial history, integer-cent checks, and retry-safe owner-checked writes.
- Date filters must use the `America/Sao_Paulo` business calendar. Summaries must not silently truncate at the API page limit.
- Report drill-downs and exports must reproduce the same totals and selected period. Loading, errors, and empty data must remain distinct.
- “Resultado gerencial” remains an explicit pending state until its policy is confirmed; cash flow must never be presented as profit.
- Finance tables favor stillness and clear scan paths; honor reduced-motion behavior.

---

## Task 1: Build daily/monthly reports from existing sources

**Files:**

- Create: `apps/web/src/pages/ReportsPage.tsx`
- Create: `supabase/migrations/20261029221801_m4_finance_reports.sql`
- Modify: `apps/web/src/auth/AuthRoutes.tsx`
- Modify: `apps/web/src/pages/DashboardPage.tsx`
- Modify: `apps/web/src/App.css`
- Modify: `docs/technical-plan.md`

- [x] Add a daily/monthly/custom-period report for order totals, reported receipts, and current receivables, each clearly labeled and derived from its own source.
- [x] Include cancellation details and avoid counting canceled orders as current active sales without showing the cancellation.
- [x] Add print/CSV export for the selected period with the same definitions and figures visible in the screen.
- [x] Replace static dashboard finance indicators with real source-backed values or an explicit unavailable state.
- [x] Show result as pending; do not calculate a proxy.

## Task 2: Record purchases, operating expenses, and delivery costs

**Files:**

- Create: one versioned finance migration
- Create: owner forms/lists for purchase and expense records
- Modify: `apps/web/src/auth/AuthRoutes.tsx`
- Modify: `apps/web/src/components/AppShell.tsx` only if new navigation links are needed
- Modify: `apps/web/src/App.css`
- Modify: `docs/technical-plan.md`

- [ ] Implement only after the user confirms how unpaid, partial, and dated payments should work.
- [ ] Allow a financial purchase to link explicitly to a physical inventory receipt; never infer payment from receipt.
- [ ] Record actual payment dates/amounts as distinct events so cash totals reflect paid amounts only.
- [ ] Support delivery costs as explicit financial records without treating the customer delivery fee as the business's delivery cost.
- [ ] Keep purchase cash outflow separate from operating expense and avoid double-counting inventory purchases in result until the cost policy is approved.

## Task 3: Reconcile, review, and hand off

- [x] Compare report summaries to their source-record lists and use `America/Sao_Paulo` period boundaries. If concurrent writes make totals disagree, hide the values and require a retry.
- [x] Run the applicable local build/lint and diff checks. Local Supabase DB lint was attempted but cannot connect because no PostgreSQL service is running; SQL/RLS runtime remains unverified.
- [x] Request read-only software/security and product-design reviews of this coherent report slice and address the material findings.
- [x] Update this plan and `docs/technical-plan.md` with implemented behavior, checks, runtime limitations, and unresolved policy.
- [ ] Commit the coherent change and verify the remote push to the configured GitHub repository.
