# Shalom Adonai Inventory and Deliveries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-managed product stock, stock receipts and adjustments, combo component snapshots, and an order-linked delivery workflow.

**Architecture:** Keep inventory as an append-only PostgreSQL ledger and calculate balances from its movements. Use owner-checked, idempotent RPCs for opening stock, receipts, stock changes, order creation, and delivery transitions. Add the delivery record only when the owner marks an order for delivery; delivery workers remain contact records without accounts.

**Tech Stack:** React, TypeScript, Vite, Supabase Auth, PostgreSQL 17, versioned SQL migrations, existing CSS and component patterns.

**Spec:** `docs/technical-plan.md` and the user-provided master prompt sections 7.7, 7.8, 9, 11, 12, 13, and 14.

## Global Constraints

- Keep the interface in Brazilian Portuguese, money in BRL, and business dates in `America/Sao_Paulo`.
- Enforce authenticated owner scope in PostgreSQL; use explicit grants and RLS for all new private tables and views.
- Stock tracking requires a unit and an explicit opening count; an untracked product must not appear to have zero stock.
- Deduct tracked stock at dispatch. Permit a negative result while presenting a warning.
- Require a saved component composition for combos and snapshot that composition on each order line.
- Record physical returns manually after inspection; never restock automatically on an attempted or returned delivery or customer pickup.
- Create delivery rows only for orders explicitly marked as delivery. Workers are records and receive no application accounts.
- Orders not marked for delivery stay outside the queue and offer an explicit customer-pickup action; record the handoff once and deduct tracked stock then.
- Do not add payment, expense, profit, tax, messaging, or provider behavior to this milestone.
- Preserve existing customer, order, payment, and receivable behavior.

## Review Focus

1. A repeated request or network retry must not duplicate a receipt, stock issue, return, or delivery transition.
2. A product without configured stock must remain distinguishable from a tracked zero balance.
3. Editing a combo recipe must not alter the component quantities already snapshotted on an order.
4. Insufficient stock must show a warning and still allow a deliberate dispatch with a negative balance.
5. Only explicitly marked orders may appear in the delivery queue; invalid status transitions must be rejected by the database.

---

### Task 1: Owner-scoped inventory, combos, purchasing, and delivery schema

**Files:**
- Create: `supabase/migrations/<generated timestamp>_inventory_and_deliveries.sql`
- Modify: `docs/technical-plan.md`

**Interfaces:**
- Products gain an explicit inventory-tracking flag, optional minimum balance, and combo flag.
- `combo_components` stores positive component quantities for a combo. `order_line_components` preserves product name, unit, and extended quantity at order time.
- `inventory_movements` is append-only and stores signed `numeric(12,3)` deltas, reason, actor, event time, and optional order/receipt references.
- `inventory_balances` exposes tracked balances and minimums as a read-only security-invoker view.
- `inventory_receipts` and receipt lines represent quantities physically received, supplier text, and purchase notes without recording payment or expense effects.
- `delivery_workers`, `deliveries`, and `delivery_events` represent owner-managed assignment and status history. Delivery status values: `awaiting_separation`, `ready`, `dispatched`, `delivered`, `attempted`, `rescheduled`, `returned`.
- Orders gain `requires_delivery`; only a true value creates a delivery record.
- Owner-checked RPCs: `configure_product_inventory(p_business_id uuid,p_product_id uuid,p_inventory_unit text,p_opening_quantity numeric,p_minimum_stock numeric,p_request_id uuid) returns uuid`; `set_combo_components(p_business_id uuid,p_combo_product_id uuid,p_components jsonb) returns integer`; `record_inventory_receipt(p_business_id uuid,p_supplier_name text,p_purchase_reference text,p_received_on date,p_notes text,p_items jsonb,p_request_id uuid) returns uuid`; `record_inventory_movement(p_business_id uuid,p_product_id uuid,p_movement_type inventory_movement_type,p_quantity numeric,p_direction text,p_reason text,p_order_id uuid,p_occurred_at timestamptz,p_request_id uuid) returns uuid`; `update_delivery_plan(p_business_id uuid,p_delivery_id uuid,p_delivery_worker_id uuid,p_scheduled_on date,p_time_window text,p_notes text,p_request_id uuid) returns uuid`; and `transition_delivery(p_business_id uuid,p_delivery_id uuid,p_status delivery_status,p_note text,p_next_step text,p_request_id uuid) returns uuid`.
- Extend `create_order` with `p_requires_delivery boolean`; include it in the retry fingerprint and snapshot combo components. Extend `cancel_order` so it cancels a still-pending delivery atomically and rejects cancellation after dispatch.
- On dispatch, create one issue per ordered component quantity not already out for that order. A manual return creates a positive movement tied to that order and cannot exceed its net dispatched quantity. A later dispatch issues only quantities manually returned and sent again.
- `record_order_pickup(p_business_id uuid,p_order_id uuid,p_request_id uuid) returns uuid` records an idempotent customer handoff for an open, non-delivery order, deducts its tracked component quantities once, saves any negative-balance warnings in order history, and prevents later cancellation.
- An inspected return may reference an eligible attempted/delivered delivery or an order with a recorded customer pickup; either way, quantity cannot exceed the tracked amount still out for that order.

- [x] Generate the migration with the Supabase CLI and implement schema, constraints, indexes, explicit grants, RLS, owner checks, immutable ledger protections, idempotency, and transaction-safe RPCs.
- [x] Extend order creation to require a nonempty saved recipe for each combo and snapshot its components.
- [x] Update the technical plan with M3 decisions, implementation boundaries, and runtime verification dependencies.
- [x] Inspect the migration for search-path safety, business-scoped foreign keys, function grants, and retry behavior.

### Task 2: Catalog inventory setup and combo composition

**Files:**
- Modify: `apps/web/src/pages/ProductsPage.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- Product forms display `inventory_tracked`, `inventory_unit`, `minimum_stock`, and `is_combo`.
- Starting tracking requires a unit and opening quantity. Existing tracked products cannot be reset through the product form.
- Combo editing submits a list of `{ component_product_id: string, quantity_per_combo: number }` to the owner-checked recipe RPC.

- [x] Add fields and validation for stock tracking, unit, opening count, and optional minimum balance.
- [x] Add combo recipe rows that choose active, tracked, non-combo products; require at least one unique component and positive quantities.
- [x] Distinguish tracked, not configured, combo without recipe, and archived product states in the catalog list.
- [x] Preserve loading, save, retry, and error messages for partial catalog/recipe save outcomes.

### Task 3: Inventory balances, receipts, movement history, and manual returns

**Files:**
- Create: `apps/web/src/pages/InventoryPage.tsx`
- Modify: `apps/web/src/auth/AuthRoutes.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- The inventory page reads `inventory_balances`, active products, receipts, and paginated `inventory_movements`.
- Receipt RPC input is `p_supplier_name`, `p_purchase_reference`, `p_received_on`, `p_notes`, `p_items` (`{product_id,quantity}` entries), and an idempotency `p_request_id`.
- Movement RPC input is `p_product_id`, `p_movement_type` (`adjustment`, `loss`, or `return`), positive `p_quantity`, `p_direction` for adjustments, required `p_reason`, optional `p_order_id` for a return, `p_occurred_at`, and idempotency `p_request_id`.

- [x] Show tracked, below-minimum, zero, negative, and not-configured states without conflating them.
- [x] Record quantities only for tracked products and add them once on physical receipt.
- [x] Record adjustments, losses, and inspected returns as separate ledger events with reasons and dates.
- [x] Show paginated movement history with product, signed quantity/unit, event, date, related order/receipt, reason, and actor attribution.
- [x] Provide filtered empty/loading/error/retry states and phone-sized layouts.

### Task 4: Mark delivery orders and manage delivery queue

**Files:**
- Modify: `apps/web/src/pages/NewOrderPage.tsx`
- Modify: `apps/web/src/pages/OrderDetailPage.tsx`
- Create: `apps/web/src/pages/DeliveriesPage.tsx`
- Modify: `apps/web/src/auth/AuthRoutes.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- `create_order` sends `p_requires_delivery: boolean`; default is false.
- Delivery plan updates capture worker record, optional scheduled date/window, and delivery notes.
- Delivery plan updates use a client-generated `p_request_id` and reject reuse with different details.
- Status transitions go through the owner-checked `transition_delivery` RPC with an idempotency request ID; an attempted status requires a note and a next step.
- Dispatch shows the current stock balance and any negative-stock warning before confirmation.

- [x] Add an explicit delivery checkbox to order creation and send it through the idempotent order RPC.
- [x] Add an explicit, idempotent customer-pickup action for orders not marked for delivery; show stock preview, allow a warned negative balance, and keep the handoff out of the delivery queue.
- [x] Show delivery details and history on an order when a delivery record exists.
- [x] Build delivery worker records, queue filters, schedule/assignment updates, and the agreed status workflow.
- [x] Allow a dispatch with insufficient stock after a clear warning; let the database write the negative balance and dispatch movement atomically.
- [x] Keep attempted, rescheduled, and returned handling auditable; returning goods never adjusts stock unless a separate inspection-based return movement is saved.
- [x] Show delivery-specific loading, empty, error, success, retry, and mobile states.

### Task 5: M3 documentation and milestone checks

**Files:**
- Modify: `docs/technical-plan.md`
- Modify: `README.md`

- [x] Record confirmed decisions and remaining limitations, including that stock is not verified against a live Supabase project.
- [x] Run the existing lint and production build commands; inspect the changed file list and `git diff --check`.
- [x] Review rendered screens when a browser is available; otherwise document source-only accessibility review.
- [x] Commit and push only the M3 files to `main`, then verify the remote commit SHA.
