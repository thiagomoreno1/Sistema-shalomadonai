# WhatsApp Client Number Isolation

## Intent

Connect the Shalom Adonai business WhatsApp number in the existing inbox while keeping the same design and functions. Only one number is active for a business at a time. Each connection uses its own Evolution instance and conversation history so the test number's contacts, conversations, calls, media, and custom context cannot appear in the client's active inbox.

## Goals

- Let an owner disconnect/archive the current number and connect a replacement with QR or phone pairing.
- Keep prior connection data in storage, hidden from the active inbox and inaccessible through authenticated direct database reads.
- Keep the WhatsApp inbox interface and supported features unchanged for each active connection.
- Make the current Evolution instance dynamic, with the database connection registry as the source of truth; environment variables must not override the active instance.
- Accept webhooks only for the active/pairing instance; acknowledge and ignore delayed events from archived instances.
- Preserve owner-only connect/disconnect, business membership checks, server-only Evolution credentials, and existing webhook secret validation.

## Non-goals

- Simultaneously showing or operating multiple numbers in the inbox.
- Deleting, merging, or copying the test number's history or contact metadata into the client number.
- Migrating existing WhatsApp contacts or customer records between businesses.
- Changing the visual design or adding WhatsApp features unrelated to number replacement.

## Approaches

1. **Reuse the same Evolution instance and clear/select data by phone.** Rejected: Evolution history and locally stored contact mappings would still share an instance namespace, and cleanup risks deleting the test history.
2. **Add multiple visible inboxes and let staff switch between them.** Rejected: the user explicitly wants one number and one active inbox, not two concurrent inboxes.
3. **Create one connection registry per business and rotate to a new instance when the owner disconnects and reconnects.** Selected: each number gets a unique instance namespace; the prior record is archived and retained; the existing inbox keeps its current features and displays only the current connection. This directly fits the requested workflow and prevents old data leakage.

## Behavior

- A migration registers every legacy instance found in conversations, messages, calls, aliases, or the existing Vault configuration as archived, preserving all rows and leaving no active connection. The next connection therefore creates a fresh instance.
- Starting a pairing flow creates one pending instance for the business if none is active. Retries reuse that pending instance. If a current instance is already connected, the request does not silently replace it.
- Once the provider reports a successful connection, the pending registry record becomes active. Only one record may be pending or active per business.
- Pairing may reuse only a pending instance. If a selected instance is already active but the provider is disconnected, the owner must archive it before pairing another number; the backend rejects attempts to pair a different number into that old namespace.
- Disconnect attempts provider logout, then archives the current record even if the Evolution API is temporarily unreachable. That preserves the isolation boundary; the UI reports if provider logout could not be confirmed.
- Reconnecting after disconnect creates a new isolated instance. The owner uses the existing QR or phone-code flow; no Evolution API key is exposed in the browser.
- The active/pending instance name comes from a service-role-only database function. API URL and provider credentials remain in server configuration/Vault. Static instance and business environment variables cannot supersede the registry.
- Inbox queries and authenticated RLS policies expose only rows for the selected active/pending instance. Composite foreign keys tie conversations to registered connections and messages, calls, and aliases to conversations in the same instance. Existing child rows with inconsistent legacy tags remain hidden by the RLS parent match; new writes are constrained.
- Webhooks resolve the instance against the registry and use the registered business ID, never a business ID supplied by the webhook payload. Each Evolution instance receives a deterministic HMAC-derived bearer token from the server master secret. The legacy master bearer is accepted only to acknowledge and ignore already archived instances; active and pending instances require their derived token. Unknown instance names are rejected.

## Constraints and decisions

- Use the existing `business_id + instance_name` data partition already present on WhatsApp conversations, messages, and calls.
- Keep the existing service-role-only configuration RPC and owner authorization for connection changes. Start and archive operations serialize on the business row so concurrent requests cannot reuse an instance while it is being archived.
- Do not put provider keys or webhook secrets into the connection registry or client response.
- Do not delete archived messages, calls, media metadata, context, or mappings.
- A later live Supabase migration and Edge Function deployment are a separate production step; source changes must be committed and reviewed first.

## Acceptance

- All known legacy test instances are archived, not deleted, and a new pairing flow gets a different instance name.
- A second connection cannot be active concurrently for one business.
- Inbox list, messages, calls, media, and context read only the current instance.
- Authenticated direct queries cannot read archived instance conversations, messages, calls, or contexts.
- Webhooks for the new active connection are authenticated with its derived token and processed; old archived-instance events do not write into the new inbox.
- The UI explains that the old history remains archived and that the new number starts a separate inbox with the same Shalom features.
