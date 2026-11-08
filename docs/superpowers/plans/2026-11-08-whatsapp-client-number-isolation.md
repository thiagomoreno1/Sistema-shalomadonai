# WhatsApp Client Number Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one isolated WhatsApp number per business while preserving the existing inbox experience and archiving previous connection data.

**Architecture:** Add a service-role-only connection registry with a unique live connection per business, seed the existing configured instance as archived, and expose controlled RPCs for creating, activating, and archiving connection rows. Make Evolution Edge Functions resolve the current instance from that registry and enforce current-instance visibility in both Edge Function queries and RLS; keep provider credentials server-only.

**Tech Stack:** Supabase Postgres migrations/RLS/RPC, Supabase Edge Functions (Deno/TypeScript), React/TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-08-whatsapp-client-number-isolation-design.md`

## Global Constraints

- Only one active or pairing WhatsApp connection may exist for a business.
- Previous connection history remains stored under its old instance name and is not visible in the active inbox.
- Provider credentials and webhook secrets remain server-only.
- Connect/disconnect remain owner-only; webhook business ownership comes from the registry, never its payload.
- The inbox retains the existing Shalom design and QR/phone pairing options.
- Do not run tests unless the user explicitly requests them.

## Review Focus

- Archived conversations, messages, calls, and context must not be readable by authenticated clients through RLS; constrain them to the selected instance.
- Repeated pairing requests after a network error must reuse the same pending instance instead of creating multiple registry records.
- An active instance must be archived before a different number can be paired into a new namespace.
- Provider logout failure must not allow the next number to reuse the old namespace; archive anyway and report the provider state.
- Child inbox rows must be tied to their parent conversation and connection using instance-aware foreign keys and RLS parent checks.
- Webhooks use a per-instance HMAC-derived bearer token rather than sharing the raw master secret across inboxes.
- Events from a previous archived instance must never be written into the new instance's active inbox.
- Environment instance/business values must not override the database-selected connection.

---

### Task 1: Connection registry, lifecycle RPCs, and RLS isolation

**Files:**
- Create: a Supabase migration for `whatsapp_connections`, lifecycle RPCs, legacy archival, and active-instance RLS policies.
- Modify: none outside the migration.

**Interfaces:**
- `get_evolution_runtime_config()` returns the current selected instance and existing server secrets, with the selected instance sourced from the registry.
- `start_evolution_connection(p_business_id uuid)` reuses a pending instance, rejects an active instance until it is archived, or creates one unique pending instance; service-role only.
- `activate_evolution_connection(p_business_id uuid, p_instance_name text)` promotes the matching pending row; service-role only.
- `archive_evolution_connection(p_business_id uuid, p_instance_name text)` archives the matching current row; service-role only.
- Private active-instance predicate is executable by authenticated RLS policies and checks both business membership and selected instance.

- [x] Create an explicit migration with RLS enabled and no authenticated grants on the registry.
- [x] Seed every legacy instance found in inbox tables and Vault as archived, preserving old data and ensuring first client pairing creates a new instance.
- [x] Add a unique partial index for at most one `pending` or `active` connection per business.
- [x] Add lifecycle RPCs with fixed `search_path`, service-role checks, explicit execute grants, business-row serialization, and idempotent archival.
- [x] Update RLS and instance-aware foreign keys for conversations, messages, calls, aliases, and contexts so only matching selected pending/active data is available.
- [ ] Review SQL against existing schema/migration patterns; do not apply to live Supabase in this task.

### Task 2: Dynamic Evolution instance resolution

**Files:**
- Modify: `supabase/functions/evolution-inbox/index.ts`
- Modify: `supabase/functions/evolution-webhook/index.ts`
- Modify: local server-only environment example only if it documents obsolete instance/business overrides.

**Interfaces:**
- Inbox uses the selected instance from the runtime RPC. Connect creates/reuses a pending instance; status promotes it after provider connection; disconnect archives it even if provider logout is unavailable.
- Webhook resolves `body.instance` to the registered active/pending connection and uses its business ID. Archived known instances are acknowledged and ignored; unknown instances are rejected.

- [x] Separate provider configuration from the optional selected connection so connect can work before a connection exists.
- [x] Remove static instance/business environment precedence; keep provider credentials and callback secrets server-side.
- [x] Use the lifecycle RPCs for connect, successful activation, and disconnect; prevent replacing an active namespace without archival.
- [x] Preserve current owner/member authorization and maintain idempotent pairing retries.
- [x] Scope every inbox-side database query and webhook write to the selected instance; derive a unique webhook bearer per instance.

### Task 3: Clear one-number replacement flow

**Files:**
- Modify: `apps/web/src/pages/WhatsAppInboxPage.tsx`
- Modify: existing WhatsApp inbox styles only if needed for responsive text layout.

**Interfaces:**
- Existing QR and phone-code actions remain supported.
- Status identifies no current selected connection as disconnected-but-ready-to-pair.
- The disconnect confirmation and empty connection state explain that old history is archived and the replacement opens a separate inbox.

- [x] Keep inbox panels hidden unless the current connection is provider-connected.
- [x] Explain that changing the number archives the old inbox and keeps the same features for the new number.
- [x] Keep staff from creating, switching, or disconnecting a number; owner-only controls remain.

### Task 4: Review, documentation, and delivery

**Files:**
- Modify: this spec/plan only if implementation decisions change.

- [ ] Review the branch diff for registry lifecycle, webhook tenant resolution, RLS coverage, and UI messaging.
- [ ] Run the repository's build/typecheck only if it is not classified as a test; do not run unit/integration tests without user request.
- [ ] Commit only files for this feature, push the feature branch, and open/update a PR against the default branch.
- [ ] Do not apply the production Supabase migration or deploy the functions until the production rollout is explicitly authorized.
