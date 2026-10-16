# Built-in Call Transfer

Save the agent, then open Agent → Tools → Built-in Call Transfer. Select a
connected company Plivo subaccount or enter that registered subaccount's Auth ID
and token. Set the approved E.164 staff number, mode and 10–120 second ring
timeout. Manual tokens use the existing credential encryption key; blank token
preserves the existing secret only for the same manual account. The browser and
LLM never receive these tokens.

## Activation

The server flag `CALL_TRANSFER_ENABLED` defaults to **false**. When enabled,
each agent's saved **Enable built-in call transfer** checkbox controls access. Existing agents
and webhook/n8n tools keep their current behavior. Saving enabled settings alone
does not turn on the server flag. Agents without enabled settings do not get the
built-in tool. Browser tests cannot execute a telephone transfer.

Activation after deployment:

1. Apply all three migrations through the normal backend migration process:
   `1792100000000_agent-call-transfer-settings.js` and
   `1792100001000_call-transfer-attempts.js`, and
   `1792100002000_call-transfer-follow-up.js` (`npm run db:migrate` in Backend).
2. Keep the existing `CREDENTIAL_ENCRYPTION_KEY`. Set `PUBLIC_BASE_URL` to the
   publicly reachable HTTPS backend origin. Plivo must reach POST routes under
   `/webhooks/plivo/transfer/` and reconnect to `/webhooks/plivo/media`.
3. Set `CALL_TRANSFER_ENABLED=true` once on the backend, then enable settings
   for the selected agent. The selected subaccount must also own the live call;
   another account in the same company is insufficient.
4. Update that agent's prompt/workflow to use **`transfer_call`** when appropriate.
   `callerConfirmed=true` is required. Backend code does not match caller keywords
   or decide which hospital scenario merits transfer. Existing `transfer_to_ward`
   webhook tools still execute their original webhook. An existing tool named
   `transfer_call` takes precedence, so resolve that conflict before using the built-in.

5. Optionally select the active staff callback webhook in the same Tools panel.
   Selection is scoped to this exact company, workspace and agent. The action
   must return `{ "success": true, "saved": true, "requestId": "ACTUAL_SAVED_ID" }`.
   Set `notified: true` only after actual staff notification. No callback action
   is run automatically when a transfer fails; the prompt obtains caller agreement.

The settings API remains GET/PUT/DELETE `/agents/:agentId/call-transfer-settings`
for authenticated company developer/Super Admin sessions in the selected
workspace. `runtimeAvailable` reports the global server flag. The retired
`CALL_TRANSFER_AGENT_IDS` environment variable is ignored and may be removed;
adding another agent/company no longer requires an environment edit or restart.
Company/workspace/account checks still apply to every transfer.

## Live behavior

The authorized tool reserves one active transfer attempt per call under a
database row lock and a unique index. It reloads the agent's configured account
and destination from the active call's company/workspace. Tool arguments cannot
override credentials, destination, caller ID or call UUID.

Anu's current generation, output audio, STT and inactivity/duration timers pause.
The prompt's workflow speech is played as the pre-transfer announcement using the
agent's selected voice. If absent, the runtime generates a short announcement
using that prompt/language. It drains the audio frames, stops background pacing,
then sends a unique Plivo checkpoint. Staff dialing begins only after the matching
`playedStream` acknowledgement (including Plivo's legacy `played` format).
Acknowledgements must match the active stream and a pending checkpoint; they
are not filtered by the inbound audio sequence high-water mark. Duplicate or
unrequested checkpoint replies are ignored. Clearing audio invalidates pending
checkpoints. A missing/cleared/interrupted acknowledgement
fails safely without dialing staff and resumes assistance where media remains
available. `CALL_TRANSFER_ANNOUNCEMENT_TIMEOUT_MS` (default 30000) bounds the ACK wait.

The backend queues a Plivo A-leg transfer before stopping the original media
stream. Its signed Dial webhook returns XML with the configured ring timeout,
the platform's existing caller ID and the fixed staff destination. Plivo bridges
the original caller and staff when staff answer. Anu does **not** hang up the
caller's telephone leg. After staff have answered, the eventual end of that
conversation ends the caller leg; Anu does not rejoin after a successful bridge.

While staff ring, `Dial.dialMusic` points to the backend's public
`/webhooks/plivo/transfer-music` XML, which loops the existing original generated
4-second WAV at `/webhooks/plivo/hold-music.wav?seconds=4`. No external music URL,
upload or credentials are needed. Those public endpoints contain no tenant data
and perform no call-control writes. Other Dial/result callbacks remain signed.
Music stops when staff answer or the configured ring timeout is reached.
Announcement wording stays in the prompt; audio order and music are backend controlled.

| Result | Wait and return on failure | Direct handoff |
| --- | --- | --- |
| Staff answers | Staff/caller bridged; AI stays out | Same |
| Busy, rejected/failed, timeout, no answer | Signed action response reconnects the same call to Anu | Short failure announcement, then Hangup |
| Caller hangs up | Plivo tears down Dial; backend cancels a known staff leg and any late answering leg | Same |
| API rejects transfer before handoff | Original AI media is retained/restored with the actual failure | Same; no handoff occurred |

The direct-mode failure announcement is currently English: “The transfer could
not be completed. Please try again later. Goodbye.” It makes no callback promise.
If the owning runtime is unavailable during a wait-mode failure (for example,
after a backend restart), the same announcement and Hangup provide an explicit
fallback instead of starting a fresh agent with missing context.

In wait mode the replacement stream reuses the **same** controller, conversation
memory, collected fields, workflow state, transcript sequence and usage tracker.
It skips welcome/initialization and generates a brief response using the actual
verified result plus existing conversation context. The original elapsed call
duration is retained. Ordinary next-turn handling controls further help and
closing. **No staff callback or notification is created by a failed transfer.**
The verified transfer state remains available to the prompt on subsequent turns.
The configured callback action must succeed under the explicit saved/requestId
contract before a staff callback promise is supported. HTTP 200 or bare
`success: true` is insufficient. Failed/unconfirmed callback actions return to
the normal result-response path. Concurrent/repeated callback execution after
success reuses the saved result for that transfer instead of posting again.
The native follow-up webhook's callerPhoneNumber/mobileNumber are bound to the
current customer (outbound To, inbound From); original call-leg metadata and
ordinary webhook payload behavior remain unchanged. Missing customer phone
fails safely without submitting the callback.

## Callback and lifecycle controls

Dial, result, event and recovery callbacks validate Plivo V3 associated-account
or main-account signatures against canonical configured URLs and the attempt's
encrypted credential snapshot. They also bind the original A-leg UUID, known
B-leg UUID and staff destination. Unverified callbacks cannot mutate state.
Recovery XML is cached per attempt so duplicate failure callbacks return the
same recovery response rather than hanging up an already-resumed caller.
Conditional transitions suppress duplicate answer events and late events cannot
reopen a completed/canceled transfer. A delayed staff answer after caller hangup
is canceled using its verified B-leg UUID.

An intentional transfer stream closure removes the old media socket but retains
the caller's Redis capacity lease. A backend heartbeat owns that lease during
Dial/staff conversation. Verified telephone hangup cancels pending transfer work
and performs normal runtime cleanup; stream closure alone does not prematurely
complete/bill the call. A periodic provider CDR check detects a missed final
hangup callback. Original AI provider usage is retained; staff B-leg telephony
charges are not added as a new credit-ledger charge by this task.

Runtime retention is **in process**. Use one backend process. For
multiple workers/replicas, callback and resumed media routing must reach the call
owner; shared persistence or owner routing is required before enabling this in a
multi-worker deployment. Do not claim restart-safe conversation restoration.
For rollback, stop enabling new agents and let active transfers finish before
restarting or reverting code/schema. Turning off the flag stops new requests;
existing callback routes remain available to finish in-flight transfers.

## Verification and logs

Run from Backend:

```text
npm run verify:call-transfer
node scripts/verify-agent-call-transfer-settings.js
node scripts/verify-native-call-transfer.js
node scripts/verify-transfer-runtime-resume.js
node scripts/verify-transfer-media-ownership.js
node scripts/verify-agent-webhook-tools.js
node scripts/verify-template-engine-production-runtime.js
npm run check
```

Native service checks use real credential encryption and callback signature
verification with mocked database/provider operations. The runtime test exercises
the real orchestrator/controller with mocked providers. The media ownership test
uses a real local WebSocket with mocked DB/Redis. These do not place paid calls or
apply migrations. Live PostgreSQL/RLS, actual Plivo bridge/return, caller hangup
and staff-leg billing still require pilot validation.

Structured state logs use `stage=voice.transfer` with call ID, transfer ID and
state, without credentials. Retrieve a deployed call's entries with:

```bash
docker logs --since 30m zea-voice-backend 2>&1 | rg 'CALL_ID'
```

Enable the existing selected-call LLM trace separately when comparing the
resumed result, generated speech and audio output.

### Diagnose announcement acknowledgement failures

```bash
docker logs --since 30m zea-voice-backend 2>&1 \
  | grep -F 'YOUR_INTERNAL_CALL_ID' \
  | grep -E 'voice\.playback_checkpoint_sent|voice\.playback_ack_received|voice\.transfer|Stale Plivo'
```

`voice.playback_checkpoint_sent` and `voice.playback_ack_received` should carry
the same checkpoint name and stream ID before the provider transfer request.
`voice.transfer_request_failed` records a safe error code and `requestStarted`;
`TRANSFER_ANNOUNCEMENT_TIMEOUT` with `requestStarted=false` means dialing was
not attempted because playback was unconfirmed. Do not interpret this as staff
busy. Acknowledgements can be `playedStream` or legacy `played`; see
[Plivo protocol reference](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference)
and [legacy Plivo support examples](https://old-support.plivo.com/hc/en-us/sections/32252450281369-Audio-Stream).
No audio payloads or credentials are written by these diagnostic events.

See [live acceptance checklist](CALL_TRANSFER_PILOT.md). The automated
release suite records live pilot and live DB migration as not run; it does not
deploy, enable a production agent, or call third-party numbers.

Provider references: [Plivo transfer API](https://www.plivo.com/docs/voice/api/calls)
and [Dial XML and callbacks](https://www.plivo.com/docs/voice/xml/routing).
