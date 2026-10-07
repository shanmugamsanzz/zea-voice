# Caller contact names — Task 4

Live phone calls receive a built-in `update_contact` workflow tool. It takes only
`name` and an exact caller `evidence` quote, not a phone number, contact ID, tenant
or workspace. The runtime's existing final-utterance/authorization flow must
authorize EXECUTE. The executor additionally checks the built-in identity and
authorization record. There is no public or dashboard write endpoint in this task.

The backend reads the live call by company, workspace, agent and call ID. It uses
the inbound caller or outbound recipient from that persisted call. Browser tests,
ended calls, mismatched scope and unassigned/unauthorized tool requests cannot
write. A transaction and company/phone advisory lock serialize simultaneous name
updates. Database statement timeout is 3 seconds. Saving and auditing commit
together; repeated same-name requests do not create duplicate contacts or audits.

Clear self-identification (English/Tamil/selected romanized Tamil forms) or a
name-only response to a clear own-name question permits initial saving. Bare
names without that context, unsupported phrasing, and third-party references
require clarification. This intentionally favors asking over guessing. Extend
language-specific evidence checks with tests before accepting other phrases.

If the saved name conflicts, the tool returns `saved:false` and asks whether to
update to the proposed name. It does not expose the existing name. A subsequent
affirmative response to that specific question requires earlier own-name evidence.
An explicit English correction such as “Please change my name to Ravi” also
authorizes replacement. Model-supplied booleans cannot bypass these checks.

Tool execution can succeed while returning `saved:false` (a clarification result).
The agent must not claim persistence until `output.saved=true`. A successful name
update is available immediately to following turns and to future dynamic contact
lookups. Names are caller-supplied metadata, not verified identity. Existing
transcripts/summaries still capture the conversation normally.

Custom assigned tools whose normalized runtime name is `update_contact` are retained without being
shadowed; the built-in is not attached in that case. Rename a conflicting custom
tool before enabling this built-in behavior for that agent. The built-in has no
webhook, secret or external network request. It uses the same structured LLM and
tool-result flow: normal turns remain one LLM call; a name-save workflow may use
the existing second call to explain the tool result.

Requires the Task 1 contact migration. No new `.env` setting or database migration
is needed. Contact/thread historical call linking remains Task 5; saving a name
alone does not create the timeline or mark someone as a returning conversation.

Verification: `npm run verify:update-contact`, `verify:agent-webhook-tools`,
`verify:agent-tool-assignment`, `verify:template-engine-production-runtime`,
`verify:agent-qdrant-grounded-turn`, and `verify:dynamic-prompt-values`.
Database fixtures verify persistence, scope, conflict handling and idempotency;
live PostgreSQL/phone-provider staging verification remains pending.
