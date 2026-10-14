# GPT Runner

Current status: caller credentials configured; one live Tamil attempt ran but did not complete. Runner playback detection was corrected and locally regression-tested; successful live acceptance remains pending.

One partial live conversation ran; no real load test has run. No database table/schema/migration was changed. The only deployed request made was a read-only lookup confirming the Balaji share link is available. A read-only configuration-database preflight failed; it performed no successful application write and printed no credentials.

## What is implemented

- Existing public test-link lookup, session creation and cleanup client.
- Authenticated existing media protocol, 8 kHz mono raw mu-law, paced speech/silence, playback checkpoints, interruption clearing, bounded startup/backpressure/duration and cancellation.
- Answer-dependent caller questions through separately configured OpenAI-compatible LLM and Sarvam TTS adapters. Existing target agent engine remains unchanged.
- Live diagnostic transcripts and timings, redacted JSON/Markdown reports, optional explicit local audio recordings.
- Synthetic Tamil/English information scenarios and a Hindi supported-language-policy scenario.
- Bounded batch scheduling: up to ten jobs, at most three concurrent jobs in the CLI. This is not a ten-active-call capacity certificate.
- Explicit live-session permission guard. Dry-run never connects to the target, reads provider secrets, creates sessions, executes tools, or writes reports.

## Commands

From Backend:

```powershell
node scripts/gpt-runner/run.js --help
node scripts/gpt-runner/run.js --config scripts/gpt-runner/config.example.json --dry-run
node scripts/gpt-runner/batch-run.js --manifest scripts/gpt-runner/batch.example.json --dry-run
node scripts/verify-gpt-runner.js
node scripts/verify-gpt-runner-transport.js
node scripts/verify-gpt-runner-release.js
```

Examples use example.invalid and placeholders. Dry-run success proves local configuration validity only.

A live command exists but has not been executed:

```powershell
node scripts/gpt-runner/run.js --config scripts/gpt-runner/config.local.json --live --allow-session-records
```

Both flags are required before config loading/live execution. A real test necessarily creates normal call-session/transcript/usage records via the existing API and may execute real attached tools. The user authorized one live test after this was explained; credentials remain unavailable, so it has not started. Authorization for one call is not authorization to run a live batch.

## Configuration

Use ignored config.local.json beside the sample. Relative paths resolve from its directory. Do not commit real links or credentials.

| Field | Behavior |
| --- | --- |
| agentTestLink OR agentTestLinkEnv | Real existing /test/{share-token} URL, or name of an environment variable containing it; never both. |
| apiBaseUrl | Optional same-origin prefix, defaults to /api. Preserve the prefix; confirm deployment routing. Remove/replace example.invalid when using a real link. |
| language | BCP-47 tag matching the scenario; syntax validation does not establish provider language coverage. |
| scenario | Local scenario JSON; remote and UNC paths rejected. |
| maxTurns | 1-20, default 5. For first live acceptance use 2-3. |
| maxDurationSeconds | 10-600, default 120. Bounds transport and CLI execution. |
| outputDirectory | Local results directory; dry-run does not create it. |
| callerConfig | Local provider JSON path; required for live mode. |
| recordAudio | Boolean, default false. Raw audio can contain sensitive speech and cannot be text-redacted. |

Scenario fields: id, language, openingQuestion, goals and optional expectedFacts. Questions/goals/files are bounded. expectedFacts are optional approved fixture phrases, not invented business facts. Phrase absence creates a needs-review finding, not a certified incorrect answer.

## Caller provider setup

Copy caller.config.example.json to an ignored caller.local.json; set callerConfig in the run config to that file.

Caller supports OpenAI-compatible LLM + Sarvam or Cartesia TTS, using the existing adapters. Set approved provider HTTPS URLs, model names, supported voice and language. Values in the example are placeholders, not recommended active models. Configure the credential environment variables named by apiKeyEnv, such as GPT_RUNNER_LLM_API_KEY and GPT_RUNNER_TTS_API_KEY, securely in the process environment. Never paste keys into reports or commit them.

Current local backend environment has no caller LLM/TTS credentials. Target provider credentials appear to be stored in the application database, but the bounded read-only preflight could not access that configured database, including outside the sandbox. Public test links do not expose those keys. Existing account keys may be reused through secure explicit configuration; no provider records were changed or credentials harvested.

Provider adapter imports are lazy. Dry-run/mocked tests do not import application environment/provider modules. Live caller initialization reuses existing adapter code and its environment validation, but does not connect to a database. Actual model/voice/audio compatibility and quotas remain unverified. Do not assume registration in source means deployment support.

## Reports and limits

Reports store redacted transcripts, generated questions, observed failures, diagnostic latency and cleanup outcome. Full raw configuration, URLs, share/media tokens and private native exception messages are omitted. Optional WAVs are separate incoming/outgoing raw streams; they do not certify perceptual quality or reconstruct every inter-packet gap.

- Simulations are labeled simulation and never marked live verified.
- A live report with transcripts and no runtime failure establishes that a conversation was observed; it is not an answer-correctness certificate.
- Tool execution remains unverified without actual tool-result evidence. UI handles tool_result diagnostics, but no emitter was found in the runtime source scanned.
- Factual accuracy needs comparison to approved knowledge/workflow; pronunciation needs recorded-audio review or independent recognition.
- The caller scenario starts information-only and instructs the model not to request consequential tools. This does not sandbox the target; verify attached destinations before live acceptance.
- Missing transcript or checkpoint, invalid audio, oversized buffers, provider stalls and cancellation produce bounded failures rather than guessed replies.
- The CLI creates a fresh run-UUID report directory and does not overwrite prior evidence.
- A successful cleanup request is not proof all server post-call persistence finished.
- No server CPU/RAM, provider quota, database performance or sustainable capacity is certified by batch summaries.
- Current source browser capacity defaults to three per company. The runner does not alter it.

## Change record

### Task 1 - 2026-10-13

Added source [integration contract](INTEGRATION_CONTRACT.md), README and task checklist. Documentation only. Baseline media, session-isolation, share-link and four frontend audio checks passed.

### Task 2 - 2026-10-13

Added run.js, config.js, config.example.json, scenarios/tamil-smoke.json, runner .gitignore, and scripts/verify-gpt-runner.js. Offline dry-run and nine tests passed. No dependency/package/startup modifications.

### Tasks 3-5 implementation - 2026-10-13

Added errors.js, audio.js, session-client.js, media-client.js, caller.js, caller.config.example.json, conversation.js and report.js. Updated isolated run.js/config.js and configuration tests to wire live mode behind two permission flags. Added scripts/verify-gpt-runner-transport.js.

Eleven protocol/behavior tests passed, including a LOCAL simulated two-turn exchange with answer-dependent follow-up, pacing, acknowledgements, cleanup, startup timeout, audio clear, invalid format, caller validation, redaction and no-live-record permission guard. No live acceptance ran.

Task 3 local transport acceptance is complete. Task 4 real provider conversation and Task 5 real evidence review remain pending. No simulated reply has been presented as the Balaji agent's response.

### Tasks 6-8 preparation - 2026-10-13

Added batch.js, batch-run.js, batch.example.json, scenarios/english-smoke.json, scenarios/hindi-policy-check.json, and scripts/verify-gpt-runner-release.js. Added seven release tests. Batch dry-run passed for two placeholder jobs with zero sessions/requests. Scheduler tests verify worker bounds and failures, not real call load. CLI batch concurrency is deliberately capped at three; ten-active-call testing requires separately verified environment capacity and authorization.

Updated checklist and this README with implementation versus live acceptance status. No target prompts were automatically edited.

## Validation actually completed

- Runner configuration/CLI: 9 passed.
- Transport/caller/reporting: 11 passed.
- Release/permissions/languages/batch: 7 passed.
- Backend full JavaScript syntax check: passed.
- Frontend TypeScript no-emit lint: passed.
- Existing browser-media transport, fixture session-isolation and static share-link suites: passed.
- Existing frontend browser audio tests: 4 passed.
- Live public agent lookup: available, Anu - Balaji Robotic Rehab, supports both directions.
- Configuration database preflight: unavailable; bounded READ ONLY attempt, no credentials printed.
- Live provider conversation, deployed tool verification, manual audio review, restart recovery and concurrent load: NOT RUN.
- No full frontend build or phone-carrier call was needed or executed for these isolated scripts.

## Remaining work

Configure and verify caller provider access; run the one authorized information-only live conversation; review actual transcript/audio against approved knowledge and tool evidence. Then perform per-agent/language acceptance and separately authorized concurrent-load checks with resource metrics. Those are required before claiming all original task acceptance criteria complete.

## Files

Executable additions are confined to Backend/scripts/gpt-runner and three verification scripts. Documentation is confined to docs/gpt-runner and docs/GPT_RUNNER_TASKS.md. Existing application source, routes, database schema, package/lockfiles, prompts and startup commands are untouched.

Each later task must record its exact changes, checks, results and limitations here.

- [Task checklist](../GPT_RUNNER_TASKS.md)
- [Task 1 integration contract](INTEGRATION_CONTRACT.md)

## Live setup and first attempt - 2026-10-13

- User supplied OpenAI and Cartesia settings. Raw credential values had been placed in apiKeyEnv fields in the example. Moved them to ignored local .env and caller.local.json, restored placeholder-only example values, and verified Git ignores the private files. No key values were printed.
- Added Cartesia selection through the existing adapter and optional local dotenv loading at caller initialization. No target provider records were modified.
- Prepared ignored local Balaji config and information-only Tamil scenario; three-turn/120-second bound, optional local audio enabled.
- Caller initialized successfully. Existing release tests passed.
- Ran ONE authorized live session through the existing API. Agent greeted in Tamil and recognized the caller question about available treatments. There was no captured answer transcript before TURN_TIMEOUT; cleanup was requested and report/audio were saved under the ignored outputs directory.
- The captured target greeting was: “வணக்கம்! Balaji Robotic Rehab Hospital AI assistant அனு பேசுறேன். சொல்லுங்க, என்ன உதவி வேணும்?”
- Generated caller question: “வணக்கம், என்னென்ன சிகிச்சைகள் இருக்கு?” Target transcription retained this question correctly apart from punctuation.
- Found a runner assumption error: it waited for playback checkpoint events, but source runtime completes speech through state diagnostics instead. Added bounded consumption handling for greeting_completed/playback_completed, increased greeting wait, and saved sanitized state events in future reports. This is a runner correction; the timeout does not establish a target prompt defect.
- Added regression coverage for turn completion without a socket checkpoint. Transport tests: 12 passed; release tests: 7 passed; earlier configuration suite: 9 passed (28 runner tests total).
- First attempt remains incomplete and its report is not marked live verified. No retry has run. A second live session needs authorization after the one-session permission was consumed.

Changed files in this update: runner caller.js, media-client.js, conversation.js, report.js, placeholder caller.config.example.json, transport verification script, this README, and ignored local configuration/scenario/credential files. Existing application source and database schema/migrations are unchanged. The live API itself created normal test-call records as authorized.
