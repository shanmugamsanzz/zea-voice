# Problems we need to fix

Updated: 21 October 2026 (Asia/Kolkata).

Track confirmed problems separately from improvements. Fix one issue at a time, preserve unrelated working behavior, and record tests and deployment status before closing an item. Do not store credentials, caller numbers or medical transcripts here.

## High priority

### H01 — Plivo subaccount mappings can become stale

Status: Confirmed code gap; New Royal incident manually recovered. Permanent fix pending.

Problem: Deleting a subaccount outside Zea does not invalidate its database mapping. Zea can show “Plivo subaccount ready” even when Plivo cannot find it. A later number assignment fails. Existing call routing can also be affected; the exact effect depends on number/application state in Plivo.

Evidence: New Royal assignment failed with “There is no subaccount with auth_id …”. A saved `telephony_accounts` row existed, with no phone rows referencing it. Retiring only that stale row allowed the user's retry to succeed. Why the original remote subaccount disappeared or became inaccessible is not established.

Code:
- `Backend/src/telephony/telephony.service.js`: `ensureCompanySubaccount` returns an existing row without remote verification; `listCompanySubaccounts` reads local records only.
- `Backend/src/telephony/plivo.client.js`: no current subaccount GET validation helper.
- `Frontend/src/components/views/SuperAdminViews.tsx`: shows “ready” from local record existence.

Required change: Validate remote existence/enabled state and parent scope before reuse. Reconcile number ownership on explicit refresh and optionally a bounded background check. Display distinct saved/unverified, verified, missing, disabled and verification-failed states. Never interpret timeout, DNS, authorization or generic provider failure as proof of deletion. A scoped Repair action must inspect active calls and references before creating a replacement application/subaccount or moving numbers. Do not silently move working numbers, delete remote resources or recreate on transient failures.

Acceptance: Tests for existing/enabled, disabled, confirmed missing, wrong credentials and timeout; no duplicate repair under concurrency; safe handling of already-assigned numbers; Balaji/Shanmuga working mappings unchanged. UI must never claim remote readiness solely from database existence.

### H02 — STT recovery failure can leave the caller connected silently

Status: Confirmed incident; permanent fix pending.

Evidence: Sarvam WebSocket closed with code 1011/keepalive timeout. Audio-input recovery cancelled current speech; reconnect then failed with DNS `EAI_AGAIN api.sarvam.ai`. Runtime entered failed, but provider hangup arrived about 105 seconds later when caller ended. Plivo recording download also later had a DNS failure. DNS worked on subsequent checks; no resolver journal entries explained the incident.

Required change: Inspect connection lifecycle and duplicate recovery events, implement bounded coordinated reconnection, and provide a verified audible failure/end path if recovery is impossible. Ensure runtime failure reaches telephony teardown. Diagnose infrastructure/DNS separately; do not assume a permanently wrong DNS configuration or blame RAG.

Acceptance: Disconnect during speech/listening, failed DNS, successful reconnect and exhausted retries; no duplicate recovery loops, lost active-call ownership or indefinitely silent provider call.

### H03 — Late summary cost may not be reconciled with wallet debit

Status: Confirmed inspected code gap; production balance impact not quantified.

Evidence: Call credit finalization totals current cost lines and is idempotent. Asynchronous summary completion adds/prices another LLM usage event but does not reconcile the already-finalized wallet debit. Report cost can therefore exceed credits charged.

Code: `Backend/src/credits/call-credit.service.js`, `Backend/src/voice/call-completion.service.js`, `Backend/src/voice/postcall-summary/postcall-summary-job.service.js`.

Required change: Design an idempotent late-cost adjustment or coordinated finalization mechanism. Preserve ledger auditability, price snapshots and balances; do not blindly rerun whole-call charging.

Acceptance: Successful/failed/retried summaries, duplicate job completion, concurrent finalization and missing prices; exact once-only charging reconciles report cost and ledger without duplicate debits.

### H04 — Shanmuga webhook envelope can identify the hospital as caller

Status: Confirmed supplied outbound payload; backend fix pending.

Evidence: Top-level `mobileNumber`/`callerPhoneNumber` contained outbound From (hospital), while `arguments.mobile_number` correctly matched outbound To (customer).

Required change: Locate shared webhook recipient mapping; use trusted inbound From/outbound To, scoped to the call, with explicit browser-test handling. Review consumers before changing existing envelope contracts. Prompt changes cannot correct backend envelope values.

Acceptance: Inbound/outbound tests and existing integration compatibility. n8n booking uses the verified recipient, never an assumed company number.

### H05 — Spoken package prices and clinical routing need validation

Status: Confirmed incorrect spoken amounts in supplied Shanmuga transcripts; prompt mitigations added locally, runtime verification pending.

Evidence: Malformed Tamil amounts and inconsistent spoken package prices occurred despite correct-looking booking arguments. One broad cheapest enquiry was narrowed to Master Health packages without clarifying scope. A three-day stomach-pain question prompted emergency advice without documented severe warning signs in that question; clinical routing quality needs review, not automatic suppression of emergency advice.

Required change: Compare original transcript, actual current row, final LLM speech and TTS-submitted text. Add factual amount checks/accurate spoken-number handling and language persistence where needed. Preserve appropriate urgent-care escalation and avoid screening recommendations for active symptoms.

Acceptance: Tamil/English amounts including 998/999/1650/4950/7980; language switching, category-scoped comparisons and safety-reviewed symptom scenarios. No hardcoded current price catalogue in backend.

## Low priority / planned improvements

### L01 — Whole-table Live Data input can consume unnecessary tokens

Status: Confirmed architecture tradeoff, not universal retrieval failure.

Current behavior: Shared KB/Live Data top-K defaults to two points. Matching table IDs hydrate up to two tables, each up to 500 current rows. Tests confirmed correct single-table prices and short follow-ups; failed indexing previously limited multi-table coverage.

Idea: Measure tokens first, compact evidence formatting, then introduce tested question-aware row selection with broad queries for lists/comparisons/counts and safe fallback. Preserve actual current database values. Merely sending top two rows or the first 32 rows is insufficient.

Acceptance: Specific lookup, multi-item comparison, catalogue listing, cheapest/category ambiguity, multi-table and long follow-up tests; report accuracy and token savings.

### L02 — Reports do not use saved caller name

Status: Confirmed code gap; implementation pending.

`update_contact` writes `conversation_contacts.display_name`, while Reports `contactName()` reads only call metadata. Resolve using company-scoped caller identity/phone with defined metadata fallback. Never treat relative/patient names as the caller or a saved name as verified identity. Test both directions and tenant isolation.

### L03 — Permanent contact-history deletion is not implemented

Status: Requested feature; pending design/implementation. Destructive operation must require explicit UI confirmation.

Scope: Company-scoped contacts, linked calls, transcripts, summaries, memory, recordings, follow-up jobs/attempts and related campaign tasks. VQA/analytics derive from calls and must refresh after deletion. Inspect database RESTRICT relationships and preserve financial integrity without refunding historical usage. Stop active/queued jobs from recreating data; block active-call deletion. Storage objects, external provider copies, CRM/n8n exports, logs and backups require separate handling; never claim complete erasure from a database deletion alone.

Acceptance: Preview, developer-only authorization, deduplicated selection/Select All semantics, tenant isolation, durable file cleanup, job races and partial failures, report refresh, billing integrity.

### L04 — Summary can invent follow-up or overstate action completion

Status: Confirmed transcript/summary examples; shorter summary instructions provided, runtime validation pending.

Distinguish request saved, link sent and confirmed booking. No callback because caller said “I'll call later”; no mandatory follow-up merely from information enquiry. Summary worker currently relies on transcript/metadata; check actual tool-result availability before promising tool-grounded summaries. Test structured outcome and follow-up fields, not summary prose alone.

### L05 — Conflicting KB behavior and unverified action claims

Status: Confirmed Balaji trace conflicts; pending content/integration review.

Retrieved Balaji KB included old appointment/WhatsApp guidance and internal implementation notes conflicting with the directional prompt. Tool result said request saved/appointment confirmed without verifying a link was sent, but agent claimed WhatsApp sending. Remove obsolete behavioral KB instructions through reviewed content updates and require explicit verified delivery outcome. Investigate duplicate assistant transcript entries shown in payload history separately; duplication does not prove duplicate playback.

### L06 — Transfer announcement audibility needs targeted verification

Status: Provider transfer confirmed in earlier logs; user reported missing announcement/delayed music. Audible cause unconfirmed.

Playback ACK compatibility fix passed release checks previously. Later logs showed a substantial delay before tool invocation, followed by successful transfer stages. Compare selected-call trace and recording; distinguish model delay, speech selection, playback ACK and music startup. Do not reopen already-fixed transport behavior without evidence.

### L07 — Company/user labels show static names across accounts

Status: Fixed locally; deployment and multi-account browser verification pending.

Problem: Labels such as “URL Factory's Org” and “Lead Developer” appear as static names for different company users instead of reflecting the signed-in identity and organization. The shared dashboard header contained hardcoded personal/company labels.

Required change: Inspect shared dashboard layouts and authentication/profile data. Show the authenticated user's actual display name and their current company/organization; derive role labels from the authenticated role where applicable. Avoid hardcoded company/person placeholders and stale identity after logout, login or account switching. Do not confuse a role title with a user's name.

Fix: The header now uses authenticated first/last name, tenant name and derived initials. Auth responses include tenantName; login/session restore populate identity and logout/session expiry clear it. Missing names fall back to email or Account. TypeScript and eight identity/authentication tests passed locally.

Acceptance: Log in as different users in different companies and roles; each sees the correct name/company. Logout/login and profile refresh must not retain another user's labels. Missing profile values use neutral fallbacks. No cross-company identity disclosure.

## Implemented locally — deployment verification required

### F01 — Live Data indexing rejected tables above 32 inputs

Cause confirmed by embedding logs: 42 and 38 inputs exceeded `max_client_batch_size:32`.

Local changes: 32-input sequential embedding batches; UI/backend 50-row new-save limit; no silent truncation; validate all embedding batches before deleting previous index; existing larger tables remain readable/indexable. Retrieval unchanged. Qdrant delete/upsert replacement is still non-atomic and can fail after deletion.

Validation recorded: batch/failure/limit checks, retrieval checks, document embedding/source tracing checks and frontend TypeScript check passed. No deployment performed by the assistant. After deployment retry failed table saves and verify Index synced plus retrieved table evidence. See `docs/LIVE_DATA_INDEXING.md`.

## Updating this file

### F02 — Inbound queue exits were missing from Reports

Local implementation added: persistent tenant-scoped queued call records, separate caller-left/timeout outcomes, same-record admission, separate waiting duration, report labels and Analytics grouping. Normal queue-disabled/outbound/browser paths remain unchanged. Waiting callers have no fabricated AI transcript/summary; carrier hold usage is handled separately on signed hangup.

Validation: inbound queue reporting tests, existing queue release simulation suite (including billing/RAG regressions), and frontend TypeScript checks passed. Not deployed or live-tested. Staging must cover two active calls plus a waiting third caller for hangup, timeout and successful admission, with cross-tenant isolation. Missing provider webhook/poll reconciliation remains a separate reliability limitation; see `docs/INBOUND_QUEUE_REPORTING.md`.

For each newly observed issue, record: priority, confirmed versus suspected status, sanitized evidence, affected code, proposed scope, acceptance tests and deployment status. Priorities reflect current triage and can change with demonstrated impact. Do not mark an item fixed merely because a prompt was edited or a local test passed. Obtain task-specific authorization before implementing a listed fix; this file is a tracker, not permission to change production.


### add the feture like when i edit the agent agent should show the last chages dte and time 

### add the new feture like when agent trnser the call in report it should show separaly 

### we can call the multiple tools at the same time 