# GPT Runner implementation tasks

Status: Tasks 1-3 complete locally. Tasks 4-8 code/preparation added; live acceptance and load evidence remain pending. One partial live attempt ran; complete conversation acceptance remains pending.
Branch: gpt-runner

## Objective

Test existing Zea Voice agents through live, two-way conversations in supported languages. Reuse the browser-test session API, audio transport, and published agent engine. Evaluate answers, follow-up handling, tool results, and latency; recommend prompt/code improvements with evidence.

## Working rules

- Complete tasks one at a time and record their results before proceeding.
- Keep the runner separate from existing browser and phone functionality. Do not create another application agent or conversation engine.
- Do not change published prompts, knowledge, provider configuration, migrations, billing, or existing call behavior as part of adding the runner.
- Store credentials securely; never put them in source control, transcripts, or reports. Redact session tokens and private caller data.
- Live tests can invoke real tools and consume provider quota. Start with a designated test agent and synthetic caller data; verify tool destinations before enabling consequential scenarios.
- Use actual audio and real model replies for live acceptance. Mock tests verify implementation behavior only.
- Document each completed task and every changed file in a separate runner README. Do not mark untested scenarios passed.

## Task 1 - Confirm integration contract (read-only)

- [x] Verify branch, repository instructions, and baseline working-tree status.
- [x] Map public test-link session creation, media authentication, audio format, events, playback acknowledgements, interruption handling, and session cleanup.
- [x] Identify how transcripts and tool outcomes can be collected using existing authorized interfaces.
- [x] Inspect available provider capabilities without exposing credentials. Determine whether existing STT/LLM/TTS providers can serve the automated caller or whether a separate speech connection is required.
- [x] Record the exact proposed file list, dependencies, limitations, and baseline checks before implementation.

Acceptance: a documented connection design using the existing engine; missing access and capabilities explicitly listed.

Completed 2026-10-13: source contract and four baseline suites documented in [runner README](gpt-runner/README.md). Live credentials, deployed selections and external acceptance remain unverified.

## Task 2 - Add isolated runner skeleton and README

- [x] Create a dedicated runner directory, configuration example containing placeholders only, and README.
- [x] Support agent test link, test language, scenario, turn limit, duration limit, and output directory.
- [x] Validate configuration and provide a dry-run mode that makes no live call and executes no tools.
- [x] Prefer existing dependencies; document any additions.

Acceptance: dry-run succeeds; application behavior and existing startup commands remain unchanged.

Completed 2026-10-13: actual isolated JavaScript CLI/configuration added; offline dry-run and nine new tests passed. Existing three backend browser suites and four frontend audio tests also passed. No live calls or dependencies added. See [runner README](gpt-runner/README.md).

## Task 3 - Connect existing audio transport

- [x] Create one session through the existing test API and connect to its authenticated media socket.
- [x] Send correctly encoded and paced audio; receive reply audio and honor playback checkpoints and clear-audio events.
- [x] Bound startup waits, buffering, duration, retries, and cancellation.
- [x] End the session reliably on success, errors, or user cancellation; do not retry uncertain tool actions.

Acceptance: local protocol checks pass. Transport-only results are not reported as conversational accuracy.

Implemented and locally verified 2026-10-13. Test session/audio ran only against an isolated simulated server. No live acceptance is implied.

## Task 4 - Add live automated caller

- [ ] Connect approved speech providers to listen to reply audio and generate spoken questions in the selected language.
- [ ] Make follow-up questions depend on the actual received answer and scenario goals.
- [ ] Keep caller/test instructions separate from target-agent prompts and knowledge.
- [ ] Add turn-taking and bounded silence handling; enable interruption scenarios only after normal conversation works.

Acceptance: one verified live Tamil conversation with multiple answer-dependent turns using the existing target engine.

## Task 5 - Add evidence and evaluation reports

- [ ] Save permitted audio, caller/agent transcripts, timing measurements, and available tool outcomes.
- [ ] Compare answers to provided approved knowledge and expected workflow; distinguish prompt issues, retrieval issues, tool failures, and speech errors.
- [ ] Report supported conclusions with turn-level evidence. Mark unavailable evidence and uncertain judgments explicitly.
- [ ] Produce a readable report and machine-readable results; recommend changes without editing target prompts automatically.

Acceptance: a reviewer can trace each finding to a real conversation turn or recorded tool outcome.

## Task 6 - Verify compatibility

- [ ] Run focused tests for transport lifecycle, cancellation, language/configuration handling, redaction, and report correctness.
- [ ] Run relevant existing browser-media, session-isolation, retrieval, and conversation checks after inspecting their side effects.
- [ ] Confirm normal browser tests and phone-call behavior remain intact in an appropriate test environment.
- [ ] Update the README with exact changes, commands, results, and remaining limitations.

Acceptance: relevant checks pass; no unrelated code changes or automatic deployment.

## Task 7 - Expand test coverage

- [ ] Test each existing agent independently using its own test link and published configuration.
- [ ] Add supported languages, mixed-language questions, corrections, pronoun follow-ups, topic changes, unknown facts, and tool-failure scenarios.
- [ ] Confirm model language coverage and evaluate uncertain pronunciation judgments separately.

Acceptance: real results per agent/language; unsupported or untested cases are clearly marked.

## Task 8 - Optional concurrent-call tests

- [ ] Confirm environment, actual company/browser/provider limits, test destinations, and usage budget before load runs.
- [ ] Ramp from one to three, five, then ten active audio sessions where configured capacity permits.
- [ ] Measure actual-answer latency, audio gaps, provider failures, server resource usage, isolation, and capacity cleanup.
- [ ] Separate configured admission limits from measured sustainable capacity.

Acceptance: evidence-backed capacity report, not a claim based solely on session creation or mocked responses.

## Change record

- Initial task document created. Implementation has not started.
- Planned implementation changes will be tracked separately in the runner README, including changed files and validation results.



## Implementation update - 2026-10-13

Tasks 4-8: automated-caller, reporting, multilingual fixtures, batch code and offline compatibility checks implemented. Twenty-seven runner tests, backend syntax, frontend typecheck and existing browser checks passed. Task 4 live conversation, Task 5 actual evidence review, Task 6 live browser/phone verification, Task 7 real per-agent/language tests and Task 8 real load acceptance remain uncompleted. Public Balaji link lookup succeeded; caller credentials/configuration are missing and the read-only configuration-database preflight failed. No schema/migration changes. User authorized one existing-API live session after record creation was explained; it has not run. See [README](gpt-runner/README.md).


## First live attempt update - 2026-10-13

Configured caller from user-supplied OpenAI/Cartesia settings without exposing keys. One authorized session greeted and recognized the Tamil service question, then hit the runner timeout. Corrected checkpoint-only completion detection to use runtime state events; local regression tests passed. Full live conversation and all-agent/language/load acceptance remain unverified. See README for evidence and changes.

