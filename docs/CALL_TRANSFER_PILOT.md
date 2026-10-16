# Native call transfer: one-agent pilot

Code and automated verification are prepared. Production deployment, database
migration and live Plivo calls have **not** been performed by this change.
The live pilot needs the environment/access method and approved caller/staff test
numbers. Never use historical call recipients as test participants by assumption.

## Scope and activation

Proposed agent: Balaji Anu, `146e5fb6-870d-4d65-9b9e-3b52c2ed948e`.
Confirm this target before activating the live pilot. Use one backend process;
context retention is in process. Keep the current n8n workflow available until
the native pilot is accepted, but point the pilot prompt at `transfer_call`.

Default/release configuration:

```dotenv
CALL_TRANSFER_ENABLED=false
CALL_TRANSFER_AGENT_IDS=
```

After migrations and environment checks, pilot activation configuration:

```dotenv
CALL_TRANSFER_ENABLED=true
CALL_TRANSFER_AGENT_IDS=146e5fb6-870d-4d65-9b9e-3b52c2ed948e
```

Both settings are required. An empty list or another agent UUID denies native
execution even when enabled settings exist. The call must belong to the same
company/workspace and configured Plivo subaccount. Do not alter other agents.

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
The release suite runs 12 transfer/call/tool/callback/browser/capacity checks.
Tests use mocked provider/database operations and a real local WebSocket where
applicable; passing these is not proof of a live phone bridge or production RLS.

## Live acceptance matrix (pending)

For each row record call ID, transfer ID, mode, actual result, caller audio,
callback request ID if any, tester and pass/fail. Use consenting test participants.

| Scenario | Expected evidence |
| --- | --- |
| Staff answers, both modes | One staff leg, verified answer/connected event, caller/staff audio, AI silent, caller remains connected |
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
| Flag off or agent not allowlisted | Native tool unavailable; existing call/webhook behavior retained |

Use Plivo delivery logs plus `voice.transfer` and selected-call LLM/playback traces
to compare actual callbacks, generated speech and audible caller experience.
Direct-mode failure audio is currently English. Staff B-leg charges are not added
as a new credit-ledger charge by this implementation; verify billing separately.

## Rollback and acceptance

Stop admitting new native transfers by setting `CALL_TRANSFER_ENABLED=false` or
removing the pilot UUID from the list. Keep callback routes/schema and the owning
backend process alive until in-flight transfers end. Then revert/restart if needed.
Do not drop transfer tables or change the credential encryption key mid-call.

Expand beyond the single agent only after the live matrix passes and owner
routing/shared retention is implemented for any multi-process deployment.
