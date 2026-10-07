# Conversation continuity release

Task 10 adds the regression runner, missed-callback/inbound coverage and an off-by-default runtime rollout flag. Run from Backend:

```sh
npm run verify:conversation-release
```

The generated `Backend/reports/conversation-release.json` records every local result and keeps `releaseReady=false` in local mode. Checks include caller-name evidence/conflicts, chronological scoped history/transcripts, summary retry fencing, timezone/confirmation/duplicates/cancellation, missed callbacks followed by inbound calls, queue capacity and reconstructed workers, roles/company isolation, campaign retries, runtime/RAG and metered billing. Local provider/database fixtures cannot prove real restarts or concurrent PostgreSQL triggers. Frontend `npm run lint` and `npm run build`, and backend `npm run check`, are separate required build checks.

Both Backend `.env` and `.env.example` contain:

```dotenv
VOICE_CONVERSATION_CONTINUITY_ENABLED=false
VOICE_CONVERSATION_CONTINUITY_TENANT_IDS=
```

After staging verification, set Enabled to true and Tenant IDs to one staging company's UUID for a canary. An empty list with Enabled=true permits all companies. This flag gates runtime contact-tool registration, loading previous conversation history, contextual openings, new callback/reminder scheduling, standalone follow-up queue dispatch and campaign mirror recovery. Company queue flags and agent callback/outbound usage settings must also permit scheduling. No live feature was enabled during local verification.

Storage, summary attachment, directional prompt configuration and the read-only Conversation screen remain available with the flag off. Existing campaign callback behavior stays compatible. Flag rollback stops new standalone dispatch and new runtime continuity; pending standalone tasks remain persisted and can be canceled from Conversations. Already submitted calls and campaign queue jobs finish under their existing rules. Outcome handling and billing remain active. Do not drop populated conversation tables to roll back runtime behavior. An already prepared call keeps its profile until it ends.

An inbound call can load a same-workspace missed/busy/failed callback from the last seven days alongside prior answered summaries. Pending callbacks take priority, and a current outbound attempt takes highest priority. Inbound calls retain their actual direction and do not become scheduled outbound attempts. A busy/failed result does not prove the caller missed the call, and phone matching does not verify identity.

For the live gate, use an isolated test PostgreSQL database for `CONVERSATION_SCHEMA_TEST_DATABASE_URL`, configured test Redis, and production-like staging schema. Commit the tested revision first. Set `CONVERSATION_STAGING_EVIDENCE` to a JSON file containing `commit`, ISO `testedAt` within the last 24 hours, and `scenarios`. Each scenario below needs `{ "passed": true, "evidence": "actual logs or test artifact location" }`:

- `contactUpdates`, `history`, `scheduling`, `missedCallbackInbound`
- `capacity`, `backendRestart`, `redisRestart`, `permissions`, `companyIsolation`
- `campaignRetries`, `billing`, `rollback`

Then run:

```sh
npm run verify:conversation-release -- --redis --release
```

The gate checks isolated SQL storage verification, Redis capacity checks, installed follow-up columns/triggers, clean matching revision and staging evidence. It does not enable the flag, deploy, or synthesize evidence. Staging must exercise the Task 9 triggers, duplicate signed callbacks, cancellation concurrent with dispatch, backend/Redis restart recovery, no-answer followed by inbound history, shared capacity under load, separate company/workspace access and unchanged campaign retries/billing. Feature enablement remains pending until that evidence exists.
