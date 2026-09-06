# September 6 conversation acceptance

Production rollout remains **blocked pending live-model staging verification**.

## Offline integration check

Run `npm run verify:template-engine-conversation-replay` from Backend.
This exercises the current RealtimeConversationOrchestrator, streaming JSON parser,
routing, published exact retrieval, coverage invocation, semantic validation invocation,
speech delivery and failed-repair recovery in one sequential call.
It prints the actual text passed to its TTS adapter and checks audio-frame delivery.

Limitations: LLM decisions and semantic assessments are fixtures; published records,
aliases, STT, TTS, audio transport and storage boundaries are simulated. This does not
test provider ranking, live Tamil understanding, actual publication completeness,
pronunciation or real acoustic playback. Fixture facts are not a production publication.
Its successful output explicitly does not approve rollout.

## Live staging procedure

1. Identify a staging endpoint and authorized test agent. Record deployed Git SHA,
   enabled engine path, published knowledge revisions and configured STT/LLM/TTS models.
   Verify that this deployment contains the tested working-tree changes; an older SHA
   does not validate them. Do not use the production phone number or publish test aliases.
2. Check approved recovery configuration and publication content in the staging UI.
   Use its Browser Test with real configured providers. Do not substitute the older
   `verify-live-production-acceptance.js` runner: it uses a different grounded-turn path.
3. Speak the turns in `fixtures/template-engine-sept06-replay.json` in order, preserving
   one conversation. Repeat the full sequence three times. Use no tool execution.
   Also test an unclear phonetic name and a new-topic correction after clarification.
4. Save restricted-access call IDs, redacted server diagnostics, final transcripts and
   recordings. Inspect the actual responses and listen to every answer, not only the
   decision label or validation result. Do not include phone numbers, credentials or
   caller identity in committed reports.
5. For each turn verify:
   - Welcome acknowledgement continues the configured published overview.
   - Repeated overview requests name available categories, without assuming prior
     knowledge or asking which category before offering an overview.
   - Onco details include published tests/scans and distinguish add-on versus premium;
     generic cancer-screening prose alone fails the details request.
   - Organ-Specific details summarize the requested published options within the budget.
   - Diabetic/Kids topic changes do not reuse stale Onco or overview records.
   - Named clarification candidates have published support. A clear broad question
     does not require identity clarification solely because its answer is long.
   - Cited facts match the active publication. Full answer plus follow-up fits the
     configured budget, and the recording is complete and intelligible.
   - Compare acknowledgement first-audio time separately from actual-answer audio time.
6. Test rejected-answer recovery separately using an isolated staging fault-injection
   harness, not production configuration. Rejected text must never play; recovery must
   be audible and the healthy call must remain open.

Record actual answer text, cited record IDs, validation/repair diagnostics, answer
audio latency, playback completion and reviewer notes per turn. Mark any unanswered
clear request, wrong entity, unsupported claim or silent/incomplete audio as a failure.
Do not mark the release accepted until all runs and recording reviews pass.

The existing `verify-template-engine-live-acceptance.js` validates a supplied live
report; it does not generate live evidence. Do not manufacture a passing report from
the offline fixture output.
