# Phone-test call queue

With `VOICE_COMPANY_QUEUE_ENABLED=true` (and the company included in the optional
allowlist), the agent testing Call button immediately dials when shared company
capacity is available. When busy, it saves a phone-test request in PostgreSQL and
returns `status: queued`. The company outbound waiting limit applies to the combined
campaign and phone-test backlog. A full waiting queue rejects additional requests.

The calling dialog reports queued/initiated/failed/canceled status and polls saved
requests. Entering a different number allows another call request. Closing the
dialog does not cancel a saved request. Company Users can view waiting calls;
Developers can cancel them through Call Queue. Share links are separate future work.

Apply migration `1791280000000_agent-phone-test-queue.js` before starting the updated
backend (`npm run db:migrate` from Backend, or the existing automatic migration).
No additional environment variables are needed. The persistent queue worker polls
using `CONCURRENCY_RETRY_DELAY_MS` and uses `CAMPAIGN_WORKER_CONCURRENCY` to bound
parallel company dispatch. It runs independently of campaign worker enablement.
Inbound callers retain priority through existing shared-capacity admission.

Each dispatch rechecks agent/number configuration, runtime models and credits.
Low credits leave the request waiting. Capacity waits consume no provider attempts
or credits. Dispatch uses the existing Plivo callbacks, signed capacity reservation,
call runtime and metered billing. Client request UUIDs are idempotent within the
company/workspace; reusing one with different call details is rejected.

Queued requests survive backend restarts. A committed `dispatching` request is
never automatically redialed if provider acceptance is unknown. After five minutes,
the worker marks an unresolved dispatch failed (`PHONE_TEST_DISPATCH_UNCONFIRMED`);
existing reservations recover by their lease. Check the provider before submitting
another request for an ambiguous dispatch. Provider failures are terminal for that
request and do not retry automatically.

The inbound maximum waiting time applies to callers on hold. Outbound phone-test
requests wait for capacity/credits until dispatched, canceled or invalidated by an
agent configuration change. Existing queued requests drain even if the queue flag
is later disabled, as existing outbound campaign jobs do.

Verification from Backend:

```bash
npm run verify:agent-phone-test-queue
npm run verify:call-queue-release
```

The targeted test uses deterministic transaction/capacity/provider doubles. Run
staging calls with two active slots and two allowed waiting requests, release one
slot, and confirm that exactly one queued call starts. Test simultaneous retries,
credit changes, cancellation, backend restart and cross-company isolation before
production rollout. The existing Cartesia TTS issue requires a separate fix.
