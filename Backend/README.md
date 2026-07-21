# Zea Voice Backend

Phase 1 backend foundation using Node.js, JavaScript, Express, PostgreSQL and Redis.

## Local setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The API defaults to `http://localhost:4000`.

## Health endpoints

```text
GET /health
GET /health/database
GET /health/redis
GET /health/workers
```

## Super Admin company endpoints

All endpoints require a Super Admin bearer token.

```text
GET   /admin/companies
POST  /admin/companies
GET   /admin/companies/:companyId
PATCH /admin/companies/:companyId
PATCH /admin/companies/:companyId/status
```

Creating a company atomically provisions its tenant, organization, default
workspace, settings and limits. The response includes all three public IDs.
Campaign concurrency defaults to 20 and cannot exceed either 20 or the
company-wide concurrent-call limit.

## Super Admin developer endpoints

```text
GET   /admin/developers
POST  /admin/developers
GET   /admin/developers/:developerId
PATCH /admin/developers/:developerId/status
```

Developer passwords are accepted only during account creation, bcrypt-hashed,
and never returned. Suspending a developer revokes all of that membership's
active sessions.

## Provider and model catalog endpoints

```text
GET   /admin/providers
POST  /admin/providers
PATCH /admin/providers/:providerId/status
POST  /admin/providers/:providerId/models
PATCH /admin/providers/models/:modelId/status
GET   /catalog/providers?type=llm|tts|stt
```

The authenticated catalog endpoint returns only connected providers and active
models. Provider secret parameters are encrypted and their values are never
returned.

## Telephony and phone-number endpoints

```text
GET  /admin/telephony/accounts
POST /admin/telephony/accounts
POST /admin/telephony/accounts/:accountId/sync
GET  /admin/telephony/phone-numbers
POST /admin/telephony/phone-numbers/:phoneNumberId/assign
POST /admin/telephony/phone-numbers/:phoneNumberId/release
GET  /phone-numbers
```

Plivo synchronization imports every rented account number into the reserve
inventory. A number can have only one active company assignment, while each
company can receive multiple numbers up to its configured limit.

Before saving real provider credentials, generate a persistent 32-byte key and
set its base64 value as `CREDENTIAL_ENCRYPTION_KEY` in `.env`:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Back up this key securely. Changing or losing it prevents existing provider
credentials from being decrypted.

## Credits and pricing endpoints

```text
GET  /admin/credits/summary
GET  /admin/credits/ledger
POST /admin/credits/platform/purchases
POST /admin/credits/companies/:companyId/allocations
POST /admin/credits/companies/:companyId/adjustments
PUT  /admin/credits/pricing
GET  /credits
```

Platform purchases enter the global wallet. Company allocations atomically
debit that wallet and credit the selected tenant wallet with paired ledger
entries. Tenant users can see only their own balance and ledger. New companies
receive an INR wallet automatically; default minute rates are INR 6.40 inbound
and INR 12.00 outbound.

## Queue monitor endpoints

```text
GET  /admin/queues
GET  /admin/queues/workers
POST /admin/queues/:queueName/pause
POST /admin/queues/:queueName/resume
POST /admin/queues/:queueName/flush
```

BullMQ queues are `batch-calls`, `realtime-calls`, and `call-retries`.
Emergency flush requires `{ "confirm": true, "reason": "..." }`, removes only
waiting/delayed jobs, and writes an audit event. Worker processes report a
Redis heartbeat; expired heartbeats disappear automatically.

## API key endpoints

```text
GET  /api-keys
POST /api-keys
POST /api-keys/:apiKeyId/rotate
POST /api-keys/:apiKeyId/revoke
```

Super Admin sessions create platform keys. Company Developer sessions create
keys bound to their own tenant and workspace. Key management requires a user
session, so an API key cannot create more keys. Plaintext keys beginning with
`zea_live_` are returned only at creation or rotation; PostgreSQL stores only
their SHA-256 hashes. API requests use `Authorization: Bearer <api-key>`.

## Call monitoring endpoints

```text
GET  /admin/calls
GET  /admin/calls/:callId
POST /admin/calls/:callId/hangup
GET  /calls
GET  /calls/:callId
```

The monitor returns live call status, calculated duration, agent/campaign
snapshots, cost, sentiment and ordered transcript turns. Super Admin force
hangup requires explicit confirmation, calls Plivo's single-call hangup API,
and records both a control event and audit event. Tenant routes are read-only
and protected by row-level security.

## Payment ledger endpoints

```text
GET   /admin/payments
GET   /admin/payments/summary
POST  /admin/payments
PATCH /admin/payments/:paymentId/status
GET   /payments
```

Transactions support subscription, credit-refill and add-on billing with
pending, succeeded, failed and refunded states. Complete card numbers are
rejected; only masked payment-method labels are stored. Payment recording does
not automatically alter credit wallets, preventing duplicate credit allocation
before a payment gateway fulfillment workflow is configured.

## Company user endpoints

```text
GET   /users
POST  /users
PATCH /users/:userId/status
```

Company Developers manage users inside their own tenant. Company Users cannot
manage other users. Suspending a user immediately revokes their active sessions.

## Voice agent endpoints

```text
GET    /agents
GET    /agents/:agentId
POST   /agents
PUT    /agents/:agentId
PATCH  /agents/:agentId/status
DELETE /agents/:agentId
```

Company Developers create and manage agents; Company Users have read-only
access. Each agent references active STT, LLM and TTS catalog model IDs. An
optional Plivo number must already be assigned to the same tenant and can map
to only one non-archived agent.

## Agent tool and knowledge endpoints

```text
GET    /agents/:agentId/tools
POST   /agents/:agentId/tools
PATCH  /agents/:agentId/tools/:resourceId/status
DELETE /agents/:agentId/tools/:resourceId
GET    /agents/:agentId/knowledge-documents
POST   /agents/:agentId/knowledge-documents
PATCH  /agents/:agentId/knowledge-documents/:resourceId/upload
DELETE /agents/:agentId/knowledge-documents/:resourceId
```

Tool secret configuration is encrypted and never returned by the API. Knowledge
documents register B2 object metadata and ingestion state. Actual object upload
and RAG indexing require the B2 credentials and worker tasks configured later.

## Campaign endpoints

```text
GET    /campaigns
GET    /campaigns/:campaignId
POST   /campaigns
PUT    /campaigns/:campaignId
POST   /campaigns/:campaignId/pause
POST   /campaigns/:campaignId/resume
DELETE /campaigns/:campaignId
```

Both batch and real-time campaigns select one active agent and one company
number at creation. Definitions include calling hours, timezone, scheduling,
retry intervals and outcomes, context schema, priority and concurrency.
Company Users can create, view, pause and resume campaigns. Company Developers
can additionally edit and delete them.

## Campaign task endpoints

```text
POST /campaigns/:campaignId/batch/import
POST /campaigns/:campaignId/realtime/tasks
GET  /campaigns/:campaignId/tasks
GET  /campaigns/:campaignId/tasks/:taskId
```

Batch imports accept `fileName` and `csvText`. The CSV requires a `phone`
column; `name` and `remarks` are optional. Invalid numbers and duplicates are
reported before execution, while accepted rows become tenant-isolated campaign
tasks.

Real-time requests accept a unique `eventId`, lead `phone`, optional `name`,
`remarks`, and `context`. The campaign's agent and assigned Plivo from-number
cannot be overridden per lead. Reusing the same event ID returns the existing
task instead of scheduling a duplicate call.

Tasks arriving outside calling hours are delayed until the next permitted
window. Tasks remain queued when credits are unavailable. A campaign configured
with three retries permits four total attempts: one initial attempt plus three
retries.

Campaign workers consume the batch, real-time, and retry queues. They enforce
the campaign limit and the Super Admin company-wide concurrent-call limit before
calling Plivo. Workers are deliberately disabled until the public callback and
voice-runtime URLs are configured:

```env
PUBLIC_BASE_URL=https://api.example.com
CAMPAIGN_WORKERS_ENABLED=true
CAMPAIGN_WORKER_CONCURRENCY=20
```

Plivo ring and hangup callbacks use
`POST /webhooks/plivo/calls/:attemptId/:eventType`. V3 signatures are required,
callbacks are idempotent, and only outcomes selected in `retryOutcomes` receive
another attempt. After retries are exhausted, the provider outcome such as
`busy` or `no_answer` is retained as the task's final status.

## Global platform settings endpoints

```text
GET /admin/settings
PUT /admin/settings
```

Super Admin can manage the admin IP allowlist, maximum session timeout,
compliance policy and SIP relay region. Updates require an interactive Super
Admin session. A setting that excludes the caller's current IP requires the
explicit `confirmAccessLoss` safety confirmation.

## Company dashboard endpoint

```text
GET /dashboard?days=14
```

The dashboard returns tenant-isolated call totals, current-month comparisons,
daily volume, recent calls, credits, assigned phone numbers and active team
members. The volume window accepts 7 to 90 days. A Super Admin must select a
company context using `x-tenant-id` and `x-workspace-id`; company credentials
are automatically restricted to their own tenant.

Agent and active-campaign totals are read from the Task 15 and Task 17 modules.

## Database migrations

All database changes must be added as versioned migrations. Pending migrations
are automatically applied at startup when `AUTO_MIGRATE=true`.

```powershell
npm run db:create-migration -- add-example-table
npm run db:migrate
```

The initial migration creates the multi-tenant core schema. The API migrates
with the configured database owner and serves normal queries through the
restricted `zea_voice_runtime` role so PostgreSQL row-level security applies.

## Optional local infrastructure

```powershell
docker compose up -d
```

The local compose services use PostgreSQL port `5433` and Redis port `6380` so
they do not conflict with default local installations.
