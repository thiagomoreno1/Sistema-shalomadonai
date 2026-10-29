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
- The owner confirmed purchases and expenses are recorded only for amounts actually paid. Each cash outflow is one paid record with its own payment date; no unpaid balance, due date, or payable tracking is represented.
- The owner approved this managerial formula: order total after discount (product subtotal + customer delivery fee − discount) for completed deliveries/pickups, minus the item cost frozen on each order line, minus operating expenses paid and actual delivery costs paid. Inventory purchase payments are cash outflows but do not reduce the result until products are sold; the frozen order-line costs represent that cost.
- The result uses the completed-delivery/pickup date for sales and item costs, and the actual payment date for operating and delivery costs. These bases are shown separately. If any included sold line has no frozen cost, the numeric result is withheld and the report shows the missing-cost count.
- An inventory receipt may be explicitly linked to one or more purchase-payment records for reference only. It never infers an amount or payment. Customer delivery fees remain separate from actual delivery costs.
- No bank, fiscal, WhatsApp, migration, production database, or production deployment work is included in this milestone slice.

## Discovery still open

- Refunds, financial adjustments, and the accounting treatment of inspected returned goods remain outside this slice; do not claim the result includes them.
- Historical cancellation reporting remains based on current order status. Existing orders have `cancelled_at` but no refund workflow.

## Review focus

- Show every financial concept separately and label each date basis: order creation, completed delivery/pickup, reported receipt time, installment due date, or actual payment date.
- Keep historical cancellations visible rather than silently rewriting a prior period.
- New tables require explicit grants, owner-scoped RLS, tenant-safe foreign keys, append-only financial history, integer-cent checks, and retry-safe owner-checked writes.
- Date filters must use the `America/Sao_Paulo` business calendar. Summaries must not silently truncate at the API page limit.
- Report drill-downs and exports must reproduce the same totals and selected period. Loading, errors, and empty data must remain distinct.
- Withhold numeric managerial result when any completed order line lacks its frozen cost. Keep recorded cash movement distinct from managerial result.
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

## Task 2: Record paid purchases, operating expenses, and delivery costs

**Files:**

- Create: `supabase/migrations/20261029223500_m4_paid_financial_outflows_and_result.sql`
- Create: `apps/web/src/pages/FinancialOutflowsPage.tsx`
- Create: `apps/web/src/components/FinanceNavigation.tsx`
- Modify: `apps/web/src/auth/AuthRoutes.tsx`, `apps/web/src/components/AppShell.tsx`, `apps/web/src/pages/ReceivablesPage.tsx`, `apps/web/src/pages/ReportsPage.tsx`, `apps/web/src/pages/DashboardPage.tsx`, `apps/web/src/App.css`, and `docs/technical-plan.md`

- [x] Record only amounts actually paid; do not model unpaid obligations or due dates.
- [x] Allow a financial purchase to link explicitly to a physical inventory receipt; never infer payment from receipt.
- [x] Use one outflow record per actual paid amount with its payment date, so cash totals reflect paid amounts only.
- [x] Support delivery costs as explicit financial records without treating the customer delivery fee as the business's delivery cost.
- [x] Keep purchase cash outflow separate from operating expense and avoid double-counting inventory purchases in result.
- [x] Calculate the approved managerial formula from completed handoffs, frozen order-line costs, and paid operating/delivery costs; withhold a numeric result when costs are incomplete or a post-handoff physical return needs an unconfirmed financial adjustment.

## Task 3: Reconcile, review, and hand off

- [x] Compare report summaries to their source-record lists and use `America/Sao_Paulo` period boundaries. If concurrent writes make totals disagree, hide the values and require a retry.
- [x] Run the applicable local build/lint and diff checks. Local Supabase DB lint was attempted but cannot connect because no PostgreSQL service is running; SQL/RLS runtime remains unverified.
- [x] Request read-only software/security and product-design reviews of this coherent report slice and address the material findings.
- [x] Update this plan and `docs/technical-plan.md` with implemented behavior, checks, runtime limitations, and unresolved policy.
- [x] Commit the coherent report slice and verify its push to the configured GitHub repository (`a9238828370a3c9ac34b497b127a4311fd0bf4c9`, `main`).

## Task 4: Review and deliver the paid-outflow extension

- [x] Add owner-scoped, append-only financial outflow records and an idempotent owner-checked write RPC.
- [x] Connect the paid-outflow history and form to Finance navigation.
- [x] Add outflows and known net recorded cash movement to reports and the owner dashboard.
- [x] Add the approved result formula using successful delivery/pickup dates, saved item costs, and paid expense/delivery outflows; keep stock purchases out of result.
- [x] Keep result unavailable for missing frozen costs and post-handoff physical returns until their financial treatment is defined.
- [x] Finish source-level UI, engineering, product, and SQL/RLS reviews; address findings; run lint/build/diff verification; and document the database-runtime limitation.
- [x] Commit and push the coherent paid-outflow extension to the configured GitHub repository.
