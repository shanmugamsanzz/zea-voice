# Inbound queue reporting

Waiting inbound calls are persisted in `call_sessions` after signed webhook validation, agent resolution and queue admission. This applies only to the existing enabled inbound queue path. Outbound, browser and queue-disabled admission paths are unchanged.

The existing call status enum remains compatible:

| Queue result | Status | Report outcome |
|---|---|---|
| Caller hangs up before admission | canceled | Caller left waiting queue |
| Queue polling returns expired/ended | no_answer | Waiting time expired |
| Queue is full | no_answer | Waiting queue full |

`provider_metadata.inboundQueue` stores arrival, state, wait seconds and outcome. Reports expose `queueOutcome`, `queueWaitSeconds` and `queueArrivedAt`; Analytics outcome grouping uses the queue label when present. No AI summary or transcript is fabricated. Unanswered queue exits have zero AI conversation duration and no answered timestamp. Provider-reported hold duration can still generate telephony usage at hangup under existing pricing; there is no invented LLM/STT/TTS usage or automatic callback.

Admission promotes the same call ID, reserves normal call credits once, stores model/pre-call metadata, and starts the normal conversation clock at admission. Queue arrival and wait remain separately available. Repeated polls/hangups do not replace a terminal queue outcome. Account/provider-ID advisory locking and persisted tenant/workspace/agent/caller checks isolate records.

No database migration or data backfill is required. Historical waiting calls without persisted records cannot be reconstructed by this change. This is not a durable webhook delivery/reconciliation solution: if both the next queue poll and the provider hangup callback never arrive, a queued row can remain pending and requires separate reconciliation. Redis lease expiry alone is not proof that the caller hung up.

Validation:
```sh
cd Backend
node scripts/verify-inbound-queue-reporting.js
node scripts/verify-call-queue-release.js
```

The local suite uses test doubles; staging verification must use two active calls plus a waiting third call. Test caller hangup, configured waiting timeout, successful admission, duplicate callbacks and a second tenant. Verify Reports/Analytics and the separate wait/AI durations. Check pricing, empty transcripts and absent automatic callbacks. No live provider testing is performed by the local suite.
