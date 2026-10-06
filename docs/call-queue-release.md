# Company call queue rollout

The queue release flag defaults to off. Shared company call-capacity enforcement,
existing outbound queues, schedules, retries, credits, agent runtime and RAG remain
active. The flag controls new inbound waiting, company outbound queue-size checks
and queue-management actions. Monitoring remains available during rollback.

## Local verification

From `Backend`:

```powershell
npm run verify:call-queue-release
npm run check
```

From `Frontend`:

```powershell
npm run lint
npm run build
```

The backend suite covers shared admission, mixed inbound/outbound sources, FIFO,
100 batch/realtime tasks at a company limit of 3, draining every task once,
duplicate callbacks, expired reservations, recreated services, tenant isolation,
role restrictions, billing, signatures, callback continuity and existing runtime/RAG
regressions. Default capacity tests use deterministic Redis and database simulators.
They do not establish real provider latency or actual container restart recovery.
The generated `Backend/reports/call-queue-release.json` distinguishes local success
from production readiness and is ignored by Git.

## Staging gate

Use an isolated staging deployment of the committed revision. Apply migrations
before starting the new backend; migration
`1791269000000_company-queue-settings.js` is required even while the flag is off.

```bash
cd Backend
npm run db:migrate
```

Use a dedicated local Redis on the staging host for Lua tests. The test scripts
connect only to `127.0.0.1`, use random tenant namespaces, and remove their test keys.
No provider API is called by the automated queue suite. For example, if an isolated
test Redis listens on port 16379:

```bash
CAPACITY_TEST_REDIS_PORT=16379 npm run verify:call-queue-release -- --redis
```

The `--redis` option executes actual Lua admission/release, binding and waiting
logic. Campaign database transactions and the dialer still use test doubles.

Set a test company's concurrency to 3. Enable that company on **every backend
replica/worker** using the same environment settings:

```dotenv
VOICE_COMPANY_QUEUE_ENABLED=true
VOICE_COMPANY_QUEUE_TENANT_IDS=<test-company-UUID>
```

Verify these scenarios using staging phone numbers, provider callbacks, persistent
Redis and PostgreSQL. Capture timestamps, company IDs, call/task IDs, slot counts,
task statuses, attempts and billing outcomes. Do not include credentials in logs.

| Scenario | Required result |
| --- | --- |
| Mixed inbound, batch, realtime and phone-test traffic | At most 3 reserved/active calls across all sources; inbound overflow plays music and drains in arrival order. |
| 100 outbound tasks | Initially 3 dial and 97 wait; all eligible tasks eventually complete, with no duplicate dials or capacity-related retry consumption. |
| Duplicate answer/hangup callbacks | Same call uses one slot; terminal processing and credit deduction happen once. |
| Backend restart with active/waiting calls | Waiting order survives; abandoned reservations recover after their lease; completed calls are not dialed again. |
| Isolated Redis restart with persistence enabled | Queue state survives; coordination fails closed during the outage and resumes after recovery. |
| Company isolation | Filling company A does not consume company B's slots; B cannot view or mutate A's tasks. |
| Flag rollback with callers already on hold | No new inbound callers join the queue; signed hold callbacks continue draining existing callers; active calls and outbound jobs keep their normal lifecycle. |

Also check calling-hour schedules, low-credit behavior, role restrictions and
end-to-end agent answers from the assigned knowledge documents during mixed load.
Provider/account limits and server CPU/memory may impose lower practical capacity.

Save a staging evidence JSON **outside the Git checkout**. Supply actual evidence
paths or log references for each passed scenario; do not mark untested cases as passed:

```json
{
  "commit": "<git rev-parse HEAD>",
  "testedAt": "<UTC ISO timestamp>",
  "scenarios": {
    "mixedTraffic": { "passed": true, "evidence": "<staging log reference>" },
    "hundredTasksLimitThree": { "passed": true, "evidence": "<staging log reference>" },
    "duplicateCallbacks": { "passed": true, "evidence": "<staging log reference>" },
    "backendRestart": { "passed": true, "evidence": "<staging log reference>" },
    "redisRestart": { "passed": true, "evidence": "<staging log reference>" },
    "companyIsolation": { "passed": true, "evidence": "<staging log reference>" },
    "rollbackDrain": { "passed": true, "evidence": "<staging log reference>" }
  }
}
```

Run the final gate against the clean tested revision and staging database:

```bash
CALL_QUEUE_STAGING_EVIDENCE=/path/to/evidence.json CAPACITY_TEST_REDIS_PORT=16379 \
  npm run verify:call-queue-release -- --redis --release
```

The gate requires actual Redis tests, the database's restricted runtime role and
migration, a clean revision matching staging evidence, and evidence less than
24 hours old. It writes `releaseReady: true` only when all requirements pass.
The gate never enables the feature or deploys containers itself.

## Production rollout and rollback

Deploy the migration/backend/frontend with the flag off. After the staging gate,
enable one selected company using its UUID in the allowlist. Recreate backend
containers to load changed environment variables; `docker restart` alone does not
reload `env_file`. Watch active capacity, queue depth, wait times, provider failures,
expired leases, duplicate processing, latency, credits and resource usage.

Expand the allowlist after observing the selected company. An empty allowlist with
`VOICE_COMPANY_QUEUE_ENABLED=true` enables all companies. Keep all replicas consistent.
Company size/wait settings remain editable through Super Admin company forms.

To roll back admission, set `VOICE_COMPANY_QUEUE_ENABLED=false` and recreate every
backend replica/worker. Leave Redis queue data and the migration intact. Existing
signed `queue_poll=1` requests continue draining callers already on hold. Active
calls retain shared capacity and heartbeat/release handling. Existing outbound
tasks, schedules and retries continue. Do not flush Redis, delete waiting tasks,
reverse the migration under the new backend, or increase concurrency to bypass it.
