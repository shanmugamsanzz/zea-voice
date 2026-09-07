# Actual-answer latency baseline — 7 September 2026

Source: supplied server-log attachment d30165fc-bc89-486d-bde6-38b2fe952ecb.
This is one call, not a production-wide SLA sample. No live calls were placed.

## Recorded baseline

The call-end summary reports 15 final-audio samples:

| Metric | Milliseconds |
| --- | ---: |
| Final-answer P50 | 4195 |
| Final-answer P90 | 10799 |
| Final-answer P95 | 12498 |
| Acknowledgement P50 (separate; 5 samples) | 5235 |
| TTS average first audio | 163.27 |

Knowledge turns 3–5 began their answers after 9508–10799 ms. Booking
turns 12–13 with one routing invocation took 1525–1582 ms; turns 7 and 16
with three routing invocations took 3937 and 4873 ms. Those latter turns
retried workflow collection for caller-evidence validation.

Turn 3 recorded generation 6355.91 ms / 4 invocations, routing 1353 ms,
retrieval 909.38 ms, and validation 1701.8 ms. The old generation bucket
includes auxiliary LLM reviews; the log cannot retrospectively split them.
Its total turn duration of 41760 ms includes playback, not just waiting.

## New measurements

Existing stage aggregate names remain unchanged. Each stage_timing event now
adds operation, startedAtMs and endedAtMs; offsets begin at the production
runtime instrumentation boundary. Completed-turn stageTimings also contains
per-operation duration, call and cache-hit counts.

Operations distinguish initial routing, tool activation review, workflow
collection review, their decision repairs, answer generation, answer repair,
reference/context/multilingual/entity-coverage reviews, request-meaning review,
workflow speech generation, follow-up repair and tool-result validation.
Unknown LLM request formats are grouped as other_llm, never as prompt text.
Publication loading, retrieval and speculative retrieval remain separate.

Use finalAnswerFirstAudioMs as the existing actual-answer-start proxy and
finalAnswerAudioAfterReadyMs for audio startup after validated text is ready.
AcknowledgementFirstAudioMs is separate and cannot satisfy the answer target.
Recovery speech is also included in existing final-audio summaries: filter
recoveryKind/validationFailure when comparing successful-answer-only latency.

These timestamps measure application audio readiness/queueing, not audio heard
at the handset. The timer starts at turn processing, not reliably at the caller's
last speech sample. A zero sttFinalizationMs does not prove zero recognition
delay. Do not label this baseline caller-speech-end-to-ear latency.

Operations may overlap (especially speculative retrieval) or be nested in a
parent span. Do not sum all operations into wall-clock latency. Cache reuse
events have zero work duration and are not provider invocations. Cancelled or
failed operations retain an error outcome; incomplete turns may lack a final
turn summary, so inspect individual stage events as well.

## Next comparison

Collect the new logs in staging for equivalent knowledge, booking, correction,
clarification and interruption scenarios. Compare per-route P50/P90/P95,
successful-answer counts, recovery rates and invocation counts against this
baseline. Under-three-second P95 remains a target, not a measured result.
This change introduces measurements only: no searches, reviews, validations,
authorization checks, prompts or provider settings are removed or relaxed.

## Task 5 verification — working tree, 7 September 2026

After the subsequent latency optimizations, the following checks were rerun
successfully (offline fixtures, not live-provider accuracy evidence):

- `npm run verify:template-engine-grounding-workflow-release`
- `node scripts/verify-template-engine-post-search-orchestrator.js`
- `npm run verify:template-engine-routing-evidence-gate`
- `npm run verify:isolated-call-memory`
- `npm run verify:canonical-topic-memory`
- `npm run verify:interruption-engine`
- `npm run verify:interruption-audio-isolation`
- `git diff --check`

Coverage includes booking collection, corrections, confirmation, cancellation,
factual side questions, multilingual requests, grounded repair/recovery, audio
isolation and timing/cache boundaries. No additional runtime changes were made
for this verification step.

Live comparison is **pending**: no staging endpoint/test agent or post-change
live report was supplied. Baseline P95 remains 12498 ms; post-change P95 is
unmeasured. Do not approve rollout or claim the 3000 ms target is met.

For a matched comparison, use the same published content, provider models,
language, transport and test sequence before/after. Record both deployed build
identities and sample counts. Include collection, corrections, comparisons,
clarification and interruptions; inspect transcripts and actual audio as well
as timing. Use a sandbox webhook for any authorized booking test, never create
real appointments. Report recovery, incomplete and cancelled turns separately
instead of quietly excluding them from successful-answer latency statistics.
