# Bank Reconciliation Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an owner to reconcile one bank movement against multiple existing financial entries when their full amounts sum exactly to that movement.

**Architecture:** Add append-only reconciliation-group and group-reversal records while preserving existing one-to-one match rows as legacy records. An owner-checked, atomic Postgres RPC validates the movement direction, full cent sum, source eligibility, concurrency, and retry key; the UI requires manual selection and displays the exact running total.

**Tech Stack:** React, TypeScript, Supabase Postgres migrations/RPCs, pgTAP against local Supabase.

**Spec:** `docs/superpowers/specs/2026-11-03-bank-reconciliation-grouping-design.md`

## Global Constraints

- Only the authenticated owner may reconcile, reverse, or read business reconciliation records.
- A bank credit may include only receipts; a bank debit may include only paid, non-voided outflows.
- Sum the full source amounts in integer cents; require exact equality with the signed bank movement.
- Never create, edit, or reverse a receipt or outflow as a side effect of reconciliation.
- Keep existing one-to-one records and the old UI/RPC path usable while the hosted migration is pending.
- Do not change or deploy the hosted Supabase project; keep this migration local and versioned.
- Do not add animation; preserve keyboard focus, touch targets, responsive layout, and reduced-motion behavior.

## Review Focus

- Wrong direction, duplicate IDs, invalid item kinds, mismatched totals, and more than 50 selected items must be rejected before any group or link is written.
- Concurrent requests must not reconcile the same bank movement or source entry twice.
- Repeating the same request UUID and canonical payload must return the same group; reusing it with changed details must fail.
- Reversing a group must release every source and movement together, while retaining the reason and history; legacy single-match reversal must still work.
- The summary, outflow-void guard, duplicate guard, and candidate eligibility must agree on whether a grouped match is active.

---

### Task 1: Add grouped matching schema and atomic RPCs

**Files:**
- Create: `supabase/migrations/<CLI timestamp>_bank_reconciliation_grouping.sql`
- Create: `supabase/tests/bank_reconciliation_grouping.test.sql`

**Interfaces:**
- Add `public.bank_reconciliation_match_groups` with business, bank transaction, request UUID/fingerprint, creator, and timestamp.
- Add nullable `match_group_id` to `public.bank_reconciliation_matches`; null means a legacy one-to-one row. New grouped links use one row per full source record.
- Add `public.bank_reconciliation_match_group_reversals`, one append-only, reason-bearing reversal per group.
- Add `public.match_bank_transaction_group(p_business_id uuid, p_bank_transaction_id uuid, p_items jsonb, p_request_id uuid) returns uuid`. `p_items` is a JSON array of 1–50 objects shaped as `{"kind":"receipt"|"outflow","id":"<uuid>"}`. Return the group ID.
- Add `public.unmatch_bank_transaction_group(p_business_id uuid, p_group_id uuid, p_reason text, p_request_id uuid) returns uuid`.
- Keep `match_bank_transaction` one-to-one for old clients and legacy rows. Update `unmatch_bank_transaction` so a child link from a group reverses its entire group; a legacy row without a group still uses the existing single-match reversal.
- During group reversal, append the group event and one compatible child reversal per link in the same transaction. This keeps the existing summary, candidate, duplicate, and outflow-void checks correct without rewriting their historical migrations.

- [ ] Use `npx supabase migration new bank_reconciliation_grouping` after checking CLI help/version; do not invent the timestamped filename.
- [ ] Create the group/reversal tables, FK/indexes, owner-only RLS, read grants, append-only row/truncate protection, and group link column; do not rewrite or discard historical match rows.
- [ ] Implement owner-only atomic matching and reversal. Normalize item order for fingerprinting; lock the movement and source rows in stable order; validate business, direction, duplicates, active-match state, void state, exact sum, and the 50-item limit before writing.
- [ ] Preserve old RPC compatibility and verify that one active child makes the movement reconciled once, while grouped child reversals release the complete group for candidate, duplicate, and outflow-void checks.
- [ ] Add SQL verification for exact receipt and outflow groups, mismatched totals, wrong direction, repeated IDs, owner isolation, retry idempotency, and full group reversal.

### Task 2: Add manual grouped selection to bank reconciliation

**Files:**
- Modify: `apps/web/src/pages/BankReconciliationPage.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- Candidate items retain `kind`, `id`, date, display text, and positive `amount_cents`.
- Candidate search covers the existing ±45-day window and entries no larger than the absolute movement amount; it excludes voided, duplicate, and actively matched records. A group may contain at most 50 items.
- The selected total is computed with `BigInt`. The confirm action is enabled only when at least one item is selected and the sum exactly equals the movement amount.
- Submit the canonical selected item array to `match_bank_transaction_group`; preserve the same request UUID for a retry of an unchanged selection.
- Display each link under one bank-movement row, and reverse the entire group with the existing required-reason pattern.
- If the hosted schema/RPC is absent, keep the page loadable and keep one-to-one reconciliation available through the legacy RPC; explain that multi-item confirmation needs the migration.

- [ ] Expand candidate loading to same-direction source rows with amount less than or equal to the bank amount, preserving date and duplicate/void checks.
- [ ] Add accessible multi-selection, incremental candidate reveal, running total/difference, exact-match confirmation, and request retry behavior.
- [ ] Load grouped rows/reversals without making the entire page fail when the hosted migration is missing; render legacy one-to-one matches unchanged.
- [ ] Show grouped labels and grouped reversal history under the movement; ensure reversal closes every child link and refreshes statuses and summary.
- [ ] Inspect phone and desktop layouts, keyboard focus, loading/error/retry/empty states, and migration-missing fallback.

### Task 3: Record and verify the milestone

**Files:**
- Modify: `docs/technical-plan.md`
- Modify: `README.md`

- [ ] Document grouped exact-sum behavior, compatibility, local migration status, and that hosted reconciliation remains one-to-one until separately rolled out.
- [ ] Check local Supabase data counts before any reset; if no local records need preservation, run `npx supabase db reset --no-seed` and keep all database verification local.
- [ ] Run `npm run lint`, `npm run build`, `npx supabase db lint --schema public,private --level warning`, and `npx supabase test db supabase/tests/bank_reconciliation_grouping.test.sql`; record the exact results.
- [ ] Review the complete diff for RLS, retry/collision, and financial-total semantics; then commit and push the coherent change.
