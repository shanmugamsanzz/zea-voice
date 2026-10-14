# GPT Runner - Task 1 integration contract

Reviewed 2026-10-13, Asia/Kolkata. Branch: gpt-runner.
Status: source contract confirmed; executable runner and live acceptance not implemented.

## Scope

Reuse each existing agent's public browser-test session API and audio socket. The server attaches attachRealtimeConversationOrchestrator; target retrieval, tools, interruption handling, speech providers, memory and persistence remain in the existing engine. Add only an isolated automated caller. Do not alter existing UI, application startup, routes, migrations, prompts, knowledge, provider records or billing.

## Repository baseline

The gpt-runner branch is checked out. Only docs/GPT_RUNNER_TASKS.md was untracked before this task. No project AGENTS.md was found; previously checked ancestors had none, and .agents was empty. The earlier branch check matched HEAD to local main and locally recorded origin/main; no fresh remote fetch was performed. Backend requires Node >=22 and already depends on ws. No credentials were opened or exported.

## Existing HTTP contract

Input: test URL with /test/SHARE_TOKEN and explicit API base URL. Treat the share token as a secret bearer capability and never log the complete URL. Production nginx in this repository proxies /api/ to backend:1112, stripping /api and forwarding WebSocket upgrades. Preserve any API base path when building addresses. Verify deployed routing; source configuration is not live evidence.

| Operation | Path relative to API base | Contract |
| --- | --- | --- |
| Lookup | GET /public/browser-test-links/{token} | success/data; agent id/name/status/agentUsage; expiresAt/permanent |
| Create | POST /public/browser-test-links/{token}/sessions | JSON direction=inbound or outbound; returns session |
| End | DELETE /public/browser-test-links/{token}/sessions/{testCallId} | Scoped cleanup; already-ended sessions return existing state |

Public frontend chooses outbound for outbound-only agents, otherwise inbound. Respect the agent's actual supported direction. Share-link validity, active agent, scope, expiry, and concurrency are enforced by the backend. No normal account login is required for this public session flow.

Created session fields: testCallId, callId, tenantId, workspaceId, agentId, direction, status, expiresAt, mediaPath, protocol, inputFormat, outputFormat, and token. Keep identifiers/token in memory; redact private identifiers in exported reports. Session creation writes a ringing call. The API has no client idempotency key, so do not retry creation automatically after an unknown outcome.

## Media authentication

Build ws/wss address from API origin + API prefix + session.mediaPath. Add call_id and token query parameters and session.protocol as the WebSocket subprotocol. Never log the full address.

Source defaults: mediaPath=/voice/browser-test/media; protocol=zea.browser-voice.v1; token TTL=120 seconds; session maximum=1800 seconds; concurrent browser tests per company=3. Deployed values remain unverified.

Token is signed and scoped to call/company/workspace/agent/user/nonce. Connect promptly. A session can be claimed only once while ringing and unexpired. Missing tokens, wrong protocol, invalid scope and replay are rejected. Do not reconnect using a consumed token or bypass checks. A fresh session is a new test with lifecycle and usage consequences.

## Audio and event contract

Both directions use mono audio/x-mulaw, 8000 samples/second. Input is JSON with base64 RAW mu-law samples; binary frames and WAV/MP3 containers are not accepted. Convert caller TTS output to the transport format. No virtual microphone or browser UI automation is necessary.

| Direction | Event | Handling |
| --- | --- | --- |
| Server -> runner | ready | Validate call, stream and media format before sending. Media readiness is not proof all providers initialized. |
| Runner -> server | media | media.payload=base64 samples; media.timestamp=monotonic milliseconds. Pace frames; do not burst a whole utterance. |
| Server -> runner | audio | Validate contentType/sampleRate, decode payload and queue/record in order. |
| Server -> runner | checkpoint | Send playedStream with matching name only after preceding audio's real-time consumption finishes. |
| Server -> runner | clearAudio | Clear pending playback and superseded checkpoints, send clearedAudio, record interruption. |
| Runner -> server | stop | End stream; close owned socket; bounded HTTP cleanup in finally. |
| Server -> runner | diagnostic | Preserve transcript, state, latency, barge_in and sanitized errors. |
| Optional | dtmf/sendDTMF | Not needed for initial conversational smoke test. |

Proposed pacing: 20-ms frames = 160 raw mu-law bytes. Send properly encoded silence during quiet periods as browser capture does, supporting endpointing and media-idle handling. Never loop target output into target input. Bound queues/backpressure; the server rejects oversized messages and excessive pending messages.

A headless runner emulates paced playback consumption, not human listening. Record separate incoming/outgoing tracks. Cancel pending caller generation on errors/cancellation. Attempt stop, socket close and scoped DELETE with finite deadlines. Report failed cleanup; link revocation/expiry can make DELETE unavailable, so socket close and watchdog remain relevant. DELETE success alone does not prove durable finalization is finished. Never retry uncertain target tool actions.

## Transcripts, turn boundaries and reporting

The existing socket sends transcript diagnostics: sequenceNumber, speaker (agent/user), text, offsetMs, and agent sources. Deduplicate by sequence number and preserve original text/order. State includes previous/current/reason. Latency includes epoch, routingMs, retrievalMs, llmMs, ttsFirstChunkMs and totalFirstAudioMs. barge_in carries reason. Store missing metrics as unknown, and distinguish acknowledgement audio from actual-answer audio.

Use received agent transcripts for answer-dependent caller follow-ups, but wait for the relevant audio/checkpoint consumption boundary before speaking. Transcript receipt is not playback completion. Bound missing transcript/checkpoint and silence waits; preserve partial/interrupted turns. Initial caller timing depends on target welcome/agent-initiates settings.

Initial caller can use an LLM + TTS and the target's emitted transcript; independent caller STT is optional for semantic turn planning. It is required, or supplemented by human/audio review, for independent transcript/audio fidelity and pronunciation verification. Save both generated caller text and target-recognized caller transcript to identify recognition errors.

Tool limitation: UI handles diagnostic.type=tool_result, but no runtime emitter was found in the source scanned. Do not treat spoken success as verified tool success. Authenticated /calls/{callId} can provide transcripts and role-dependent developer/provider metadata after finalization, subject to authorized account access; it does not guarantee every tool outcome is available. Public-link-only reports must label missing tool evidence unverified. No public transcript-list or provider-credential endpoint exists in this flow.

## Caller provider design and access

Source registers LLM adapters for OpenAI-compatible/Gemini/Anthropic; TTS for Sarvam/Cartesia/ElevenLabs/Azure; STT for Sarvam/Cartesia/ElevenLabs; and optional audio-to-audio providers. Source support does not establish active deployment selections, language coverage, credentials, permissions, quotas or connectivity.

Candidate initial caller: one compatible LLM adapter plus Tamil-capable TTS adapter. Reuse provider code where it can be initialized from an explicit caller configuration without mutating target settings. Imports depend on backend environment validation; confirm initialization before deciding direct reuse versus a runner-only wrapper. Caller is separate from target and from this Codex voice chat.

The public link supplies no target prompt/knowledge/tools or provider keys. Configure caller credentials through approved local secret/environment inputs. Do not use super-admin provider-list discovery to harvest credentials: source mapping can return decrypted parameters. Existing accounts may be reused only after model/voice/audio-format/permission/quota checks. No provider requests were made during task one.

## Usage and safe live acceptance

The server executes real attached tools, and public session creation has no disable-tools switch. First live test needs a designated agent, synthetic caller data and verified test destinations. Never claim tools are sandboxed or silently change the target.

Although the page describes tests as non-billable, current isolation verification checks AI usage metering. Treat browser tests as potentially consuming provider quota/company AI credits, plus caller-side provider costs. No phone carrier call is needed for this integration. Verify effective billing and bounded usage before live testing.

Expected answers need approved prompt/knowledge/workflow fixtures or separately authorized read access. Target output is not ground truth and cannot authorize changes to test settings. Supported-language policy defines expected behavior; intentionally unsupported languages are not automatically defects.

## Exact proposed files for later tasks

- Backend/scripts/gpt-runner/run.js: CLI and bounded lifecycle.
- Backend/scripts/gpt-runner/config.js: validation, dry-run, redaction.
- Backend/scripts/gpt-runner/session-client.js: existing scoped HTTP calls.
- Backend/scripts/gpt-runner/media-client.js: socket events, pacing and acknowledgements.
- Backend/scripts/gpt-runner/audio.js: codecs, silence and recordings.
- Backend/scripts/gpt-runner/caller.js: provider configuration and adaptive questions.
- Backend/scripts/gpt-runner/report.js: readable/machine evidence reports.
- Backend/scripts/gpt-runner/config.example.json: placeholders only.
- Backend/scripts/gpt-runner/scenarios/tamil-smoke.json: synthetic information-only scenario.
- Backend/scripts/verify-gpt-runner.js: focused offline lifecycle/codec/redaction/report tests.
- docs/gpt-runner/README.md: task results, changes, future instructions.
- docs/gpt-runner/INTEGRATION_CONTRACT.md: this document.
- docs/GPT_RUNNER_TASKS.md: task status.

Initially use direct Node commands and existing ws; no package/startup modification or new transport dependency is proposed. Raw PCM/mu-law recordings can avoid encoder dependencies. Further dependencies require capability evidence. Ignore live configuration, credentials and recordings when implementation introduces them. The files listed as executable are proposed, not created.

## Baseline verification completed

All passed on 2026-10-13:

| Working directory | Command | Actual scope |
| --- | --- | --- |
| Backend | node scripts/verify-browser-test-media.js | Local socket/server with injected runtime/session dependencies; tokens, replay, scope rejection, protocol, audio, clear and cleanup. No live provider conversation. |
| Backend | node scripts/verify-browser-test-session-isolation.js | Fixture companies/agents/capacity/cleanup and AI metering; no real database load. |
| Backend | node scripts/verify-browser-test-share-links.js | Static/source link contract check; no deployed API requests. |
| Frontend | .\node_modules\.bin\tsx.cmd --test tests\browser-agent-media.test.ts | Four tests passed: API prefix, codec conversion, silence/polarity, invalid/empty buffers. |

No full build, external API/provider call, migration, spoken-quality or concurrent-load test ran.

## Remaining live prerequisites

Confirm caller model/voice/audio format, securely configured credentials, deployed API routing/network access, approved expected facts and test-safe tools, and usage bounds. Task one is complete as a documented source contract, with missing access explicitly listed. Task two can build an offline skeleton/dry-run; it cannot declare live acceptance before these prerequisites are verified.

## Primary source references

Frontend/src/views/PublicBrowserAgentTestView.tsx; Frontend/src/lib/browserAgentMedia.ts; Frontend/src/components/agent/BrowserAgentTestPanel.tsx; Frontend/nginx.conf.

Backend/src/app.js; Backend/src/config/env.js; Backend/src/voice/browser-test-share-link.routes.js; browser-test-share-link.service.js; browser-test-session.service.js; browser-test-token.js; browser-test-media.socket.js; realtime-conversation-orchestrator.js.

Backend/src/voice/providers/registry.js; defaults.js; tts/tts.interface.js; tts/streaming-runtime.js; llm/llm.interface.js. Backend/src/calls/call.routes.js and call.service.js. Backend/src/providers/provider.routes.js and provider.service.js.
