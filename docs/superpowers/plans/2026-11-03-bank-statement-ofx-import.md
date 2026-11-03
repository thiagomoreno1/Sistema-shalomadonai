# Bank Statement OFX Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated business owner preview and safely import BRL bank transactions from OFX/QFX files into bank reconciliation.

**Architecture:** Parse OFX in the browser and never upload or persist the raw file. A narrowly scoped owner-checked database RPC records normalized movements and an append-only batch summary, using OFX FITID values for idempotent deduplication; the UI previews account identity and duplicate candidates before confirmation.

**Tech Stack:** React, TypeScript, Supabase Postgres RPC/migrations, native browser APIs.

**Spec:** `docs/technical-plan.md` — Bank reconciliation foundation and Milestone 5 setup.

## Global Constraints

- Do not connect a real bank or request bank credentials.
- Keep raw statement contents in the browser only; persist normalized movement fields and batch counts.
- Only authenticated business owners may import or read batch history.
- Keep the change local until schema rollout is separately approved.
- Do not add or run automated tests unless the user asks for testing or verification; verify the application build instead.

## Review Focus

- OFX SGML/XML variation, missing FITID, and malformed transactions must fail closed with actionable errors.
- Non-BRL currency, future dates, unsafe amounts, and excessive file/row counts must be rejected before import.
- A file account ending that differs from the selected account must block confirmation.
- Repeated FITIDs within the file and from prior imports must be counted as duplicates, not written twice.
- Retrying after a lost response must return the same batch result and must not create additional movements.

---

### Task 1: Parse OFX/QFX locally

**Files:**
- Create: `apps/web/src/lib/ofxStatement.ts`

**Interfaces:**
- Produces `parseOfxStatement(contents: string): OfxStatement`.
- `OfxStatement` contains `accountLastFour`, literal currency `BRL`, unique normalized rows, and `duplicateRowsInFile`.
- Each row contains ISO transaction date, signed integer `amountCents` as a decimal string, description, optional counterparty, and FITID as `externalTransactionId`.

- [x] Implement bounded parsing for OFX 1.x SGML and OFX 2.x XML bank statement blocks; reject files without exactly one BRL bank statement, account ID, or transaction list.
- [x] Require valid dates, safe non-zero cent values, bounded text, and unique-per-account FITIDs; retain the first row for repeated FITIDs and report the remainder as internal duplicates.

### Task 2: Add owner-only atomic import RPC

**Files:**
- Create: `supabase/migrations/<CLI timestamp>_bank_statement_ofx_import.sql`

**Interfaces:**
- Adds `public.bank_statement_import_batches`, owner-readable and append-only.
- Adds `public.import_bank_statement(p_business_id uuid, p_bank_account_id uuid, p_rows jsonb, p_duplicate_rows_in_file integer, p_request_id uuid)`, returning the batch ID and imported/duplicate counts.
- The RPC accepts at most 1,000 normalized rows, validates every field, skips existing `(business, account, statement_file, FITID)` transactions, and returns stored counts for an identical retry.

- [x] Create the migration with the Supabase CLI and add the batch table with RLS, owner-only SELECT, no direct writes, and append-only triggers.
- [x] Implement and grant only the authenticated RPC; include owner, active account, input, request fingerprint, advisory-lock, and per-row duplicate checks.

### Task 3: Add preview and confirmation UI

**Files:**
- Create: `apps/web/src/components/BankStatementImportCard.tsx`
- Modify: `apps/web/src/pages/BankReconciliationPage.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- Component accepts `businessId`, active bank accounts, and an async refresh callback.
- Calls `parseOfxStatement`, checks the selected account’s last four digits, reads existing FITIDs in the statement date range for preview, and calls `import_bank_statement` only after explicit owner confirmation. The RPC performs the full account-scoped FITID deduplication.

- [x] Enforce a 5 MiB file limit and `.ofx`/`.qfx` selection; show local preview, duplicate count, and normalized BRL total.
- [x] Display imported and skipped counts; preserve the same request ID after an uncertain response and reset it only after success or a new file.
- [x] Make clear that the raw file stays in the browser and only normalized movements are stored.

### Task 4: Update integration record

**Files:**
- Modify: `docs/technical-plan.md`
- Create: `docs/integrations/bank-statement-ofx-import.md`

- [x] Document supported formats, privacy boundaries, deduplication, setup/rollout status, and the fact that the migration is not applied remotely.
- [x] Run `npm run build` and `git diff --check`; do not apply migrations or deploy provider functions.
