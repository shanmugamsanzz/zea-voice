# Native call transfer: live acceptance checklist

The operator reports the original pilot is complete. Announcement sequencing and
hold music have automated verification; this code change does not perform a new
production deployment or live phone test. Use approved participants for audio
acceptance. Never use historical call recipients as test participants by assumption.

## Scope and activation

Use one backend process; context retention is in process. Point each enabled
agent's prompt at `transfer_call`. Staff destinations and credentials remain
separate company/agent settings.

Default/release configuration:

```dotenv
CALL_TRANSFER_ENABLED=false
```

After migrations and environment checks, global activation configuration:

```dotenv
CALL_TRANSFER_ENABLED=true
CALL_TRANSFER_ANNOUNCEMENT_TIMEOUT_MS=30000
```

Enable the checkbox separately for each agent. No environment agent list is
required; the old CALL_TRANSFER_AGENT_IDS value is ignored and can be removed.
The call must belong to the same company/workspace and configured Plivo subaccount.

In Agent → Tools configure the approved staff test number, ring timeout, mode
and optional callback webhook. Validate that webhook saves a real request before
returning `success:true, saved:true, requestId:<actual ID>`. A notification result
is separate (`notified:true`). A failed transfer alone must not invoke it.

Prompt instructions for the pilot (adapt wording to the agent language):

> Invoke transfer_call only when the caller requests/agrees and this agent's
> scenario permits it. Use the verified transfer state when assistance resumes.
> Do not greet again or repeat collected details. Explain the actual failure.
> If a callback tool is configured, offer it according to the prompt and wait for
> caller agreement; collect only required missing fields. Promise a callback only
> after the verified saved request result. If unavailable or failed, explain the
> limitation and continue helping. Do not promise a contact deadline. On no further
> help, close using the normal call-control mechanism.

## Automated release gate

From Backend run `npm run verify:call-transfer` and `npm run check`.
From Frontend run `npm run lint` and `npm run build`.
The release suite runs 13 transfer/audio/call/tool/callback/browser/capacity checks.
Tests use mocked provider/database operations and a real local WebSocket where
applicable; passing these is not proof of a live phone bridge or production RLS.

## Live acceptance matrix (pending)

For each row record call ID, transfer ID, mode, actual result, caller audio,
callback request ID if any, tester and pass/fail. Use consenting test participants.

| Scenario | Expected evidence |
| --- | --- |
| Staff answers, both modes | One staff leg, verified answer/connected event, caller/staff audio, AI silent, caller remains connected |
| Announcement and music | Full prompt-controlled announcement before staff dialing; matching playback checkpoint; music instead of ringing; stops on answer/failure |
| Missing/cleared playback ACK | No staff dialing; caller assistance recovers when media is available |
| Staff busy/rejects, both modes | Wait mode resumes existing context; direct mode announces failure then ends |
| No answer until configured timeout, both modes | Timeout honored; same mode-specific result; no automatic callback promise |
| Caller hangs up while ringing, both modes | Staff ringing stops; pending transfer canceled; no AI reconnect |
| Late answer after caller hangs up | Known/late B-leg canceled; no ghost bridge |
| Invalid credentials | Safe failure with existing caller assistance; no staff connection claim |
| Duplicate answer/result callback | No duplicate transition/action; recovery response stable; no second callback request |
| Callback webhook saves request | Only after caller agreement; real request ID; callback promise supported |
| Callback webhook fails/returns bare success | No promise, no notification claim; assistance continues |
| Caller declines callback or wants more help | No callback submission; answer current question and preserve known fields |
| Another company's account/tool/agent | Setting/execution denied; no cross-company call or context |
| Flag off or agent checkbox off | Native tool unavailable; existing call/webhook behavior retained |

Use Plivo delivery logs plus `voice.transfer` and selected-call LLM/playback traces
to compare actual callbacks, generated speech and audible caller experience.
Direct-mode failure audio is currently English. Staff B-leg charges are not added
as a new credit-ledger charge by this implementation; verify billing separately.

## Rollback and acceptance

Stop admitting new native transfers by setting `CALL_TRANSFER_ENABLED=false` or
disabling the agent's transfer checkbox. Keep callback routes/schema and the owning
backend process alive until in-flight transfers end. Then revert/restart if needed.
Do not drop transfer tables or change the credential encryption key mid-call.

Owner routing/shared retention is required before any multi-process deployment.
