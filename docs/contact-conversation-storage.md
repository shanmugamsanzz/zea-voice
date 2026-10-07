# Contact conversation storage — Task 1

Task 10 adds [release verification and rollout controls](conversation-release.md).
Runtime continuity is disabled by default until a company canary passes staging.

Task 9 adds [callback/reminder scheduling and dispatch](follow-up-scheduling.md)
for both phone call directions, with confirmation, cancellation, company queues
and campaign retry compatibility. Apply `1791374000000_follow-up-dispatch.js`.

Task 8 now selects prompts/welcomes by the actual call direction and generates
[contextual openings](directional-conversation-openings.md) for returning phone
callers. Legacy values remain fallbacks; User-Initiates remains unchanged.

Task 6 connects completed post-call summaries to thread context and adds worker
claim protection in migration `1791373000000_conversation-summary-context.js`.
See [post-call summary continuity](conversation-summary-context.md) for structure,
retry behavior and deployment checks. Transcripts remain separate call records.

Task 7 adds the read-only [Conversation tab](conversation-view.md), including
contact search, chronological summaries and transcripts. Company users and
developers are restricted to their authenticated company/workspace; Super Admin
selects a company. Apply the preceding migrations and backfill older call links
to make historical records visible.

Task 2 adds agent editing/API support and migration
`1791371000000_agent-summary-context-settings.js`. Apply both migrations before
deploying the updated backend. Agent Usage controls which prompt/welcome fields
appear. Both direction fields are retained when usage changes. Previous summaries
default to 2 with a combined 6,000-character context limit; 0 summaries disables
history. API bounds are 0–10 summaries and 500–20,000 total characters.

Task 2 saves configuration; Tasks 3 and 8 now provide runtime history and
direction selection. The UI keeps the original prompt/welcome fields
compatible using inbound values (or outbound for outbound-only agents). Existing
API clients can still supply only legacy fields. Explicit null welcomes clear
the corresponding direction; omitted PATCH fields preserve existing values.
Run `npm run verify:agent-conversation-configuration` for configuration checks.

Migration: `1791370000000_contact-conversations-follow-ups.js`.

This is storage only. It does not change runtime prompts, greetings, callback
dispatch, RAG, campaign retries, credits, or existing conversation memory. No
new environment variable is required for application operation.

Existing agents receive copies of their legacy prompt and welcome in both
direction-specific fields. The legacy columns remain untouched and in use.
The new fields are nullable so older create/update endpoints still work;
direction routing must fall back to legacy fields when implemented. The copies
are initial migration snapshots, not a live mirror of subsequent legacy edits.

`conversation_contacts` identifies a normalized E.164 number within a company.
The same number in two companies creates two independent contacts. Contact
names record provenance; a name does not imply verified identity.
`contact_conversations` permits exactly one thread per contact. Threads span
agents/workspaces within the company; future APIs must enforce workspace and
role authorization before exposing that company-wide history.

`conversation_call_links` links individual calls to a thread. Existing
`call_transcript_entries`, `call_ai_summaries`, recordings, billing, call results,
and `conversation_memories` remain authoritative and unchanged. Historical
call linking is deferred to Task 5; this migration does not guess identities
or treat browser tests as real phone contacts.

`scheduled_follow_up_tasks` stores callback/reminder purpose, requested and
effective due times, timezone, source call, client UUID, retries and leases.
`follow_up_call_attempts` links individual provider attempts to each task.
No worker consumes these tables yet. Campaign callback/retry storage remains
intact; integrating it is a later task. Timezone text must be validated as an
IANA zone by the future API. Lifecycle transitions and same-contact simultaneous
dispatch protection require transactional service logic in later tasks.

Composite foreign keys prevent cross-company/workspace agent/call links.
New tables enforce RLS for tenant context or existing privileged service/admin
contexts. Runtime grants omit DELETE. Role restrictions need the later API.

Run `npm run verify:conversation-storage` in Backend for migration contract
checks. To run real SQL, set `CONVERSATION_SCHEMA_TEST_DATABASE_URL` to an
isolated PostgreSQL test database with the project's `zea_voice_runtime` role;
the test owner needs schema creation and SET ROLE privileges. Fixtures and
migration changes execute in a temporary schema inside a rolled-back transaction.
Without that explicit URL, PostgreSQL verification is reported as skipped.

Before deployment, back up the database and run `npm run db:migrate` using the
normal deployment process. Backfill updates agents and composite unique
constraints build indexes, so measure migration locks on staging before a busy
production rollout. Rollback drops only the new storage and fields; it loses
any new data written after rollout. Never roll back populated tables casually.
