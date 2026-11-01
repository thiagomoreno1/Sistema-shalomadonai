# Central do dia Implementation Plan

> **For agentic workers:** Use this plan for the approved Central do dia design in one bounded implementation task.

**Goal:** Reorganize the Início page as an actionable daily center, with independent priority counts, a grouped action queue, and recent orders while retaining existing trends.

**Architecture:** Reuse the current priorities RPC and chart component. Add a narrowly scoped, owner-only recent-orders read under existing RLS, with independent loading/error/retry and stale-request protection; do not change server permissions.

**Tech Stack:** React, TypeScript, existing Supabase client, existing CSS design tokens.

**Spec:** `docs/superpowers/specs/2026-11-01-central-do-dia-design.md`

## Global Constraints

- Keep the existing 7/30 day charts and business scopes.
- Do not run or add tests, build, or lint unless the user asks.
- Do not change Supabase migrations or expand staff permissions.
- Keep recents limited to four rows and select only the fields in the design spec.
- Commit and push the completed change after review, per the user's standing instruction.

## Review Focus

- A repeated business context or stale request must not show another business's recent orders.
- Staff must not get a client-side attempt to bypass the current owner-only RLS policy.
- Empty and failed recent-order loads must remain distinguishable and recoverable.
- Counters must remain independent and not imply a deduplicated total.
- The action queue must preserve type-specific labels and ordering.

## Task 1: Implement the Central do dia layout

**Files:**
- Modify `apps/web/src/pages/DashboardPage.tsx`
- Modify `apps/web/src/App.css`
- Modify `apps/web/src/components/AppShell.tsx`

**Steps:**
- [x] Add three linked summary counts from `get_dashboard_priorities`, retaining separate categories.
- [x] Recompose existing priority groups into an action queue without flattening or reordering the source lists.
- [x] Add up to four recent orders using the existing RLS-protected table, only for owner role, with minimal fields and independent loading/error/empty/retry behavior.
- [x] Make the recent-order request business-scoped, latest-first, bounded to four, and protected from stale responses on unmount or business change.
- [x] Add a responsive two-column layout that stacks action queue before recents, consistent with current light/dark tokens.
- [x] Preserve trends, inventory, connections and quick links below the central panel.
- [x] Review diff manually; do not run tests/build/lint. Inspect the browser if the local app is available.
- [x] Commit only this task after read-only product/security review; push after final review.
