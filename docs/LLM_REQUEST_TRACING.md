# Per-turn LLM request, response and playback tracing

Diagnostics for OpenAI-compatible, Gemini text LLM and Anthropic adapters,
plus voice-engine tool, fallback and playback events. Does not trace native
audio sessions or prove what a remote caller physically heard.
No additional provider requests or prompt changes. Quick replies that bypass the
LLM have no request trace. History, retrieved evidence and workflow definitions
appear where actually sent (often embedded inside the system message).

Disabled by default. Both enablement and an explicit call allowlist are required.
Logs contain sensitive caller/medical content. Restrict access to Docker logs,
retain only for debugging and disable after the test. Do not place credentials
inside prompts/KB. Authentication headers and endpoint URLs are never logged;
configured provider parameter values and common credential fields are redacted.

Set in Backend/.env and recreate the backend through your normal deployment:

```dotenv
LLM_REQUEST_TRACE_ENABLED=true
LLM_REQUEST_TRACE_CALL_IDS=
LLM_REQUEST_TRACE_CALL_IDS_FILE=/app/artifacts/llm-trace-call-ids.txt
```

Start a test call and find its internal call ID in the call-start logs. Then
enable subsequent LLM requests for only that active call (replace the ID):

```bash
docker exec zea-voice-backend sh -c 'umask 077; printf "%s\n" "YOUR_INTERNAL_CALL_ID" > /app/artifacts/llm-trace-call-ids.txt'
docker logs --since 10m -f zea-voice-backend 2>&1 | grep -E 'llm\.(request|response)_trace|voice\.(turn|playback)_trace'
```

The allowlist file is re-read for each request; no restart is needed to select
an active call. Requests before selection cannot be recovered. Alternatively,
LLM_REQUEST_TRACE_CALL_IDS accepts comma-separated IDs known before startup.
Never use wildcards. Each event contains callId, turnEpoch, unique traceId,
model identity and the serialized provider request with credential redaction.
Turn epochs are runtime IDs, not necessarily sequential caller-exchange numbers.
All requests in one epoch (including post-tool generation) have distinct traceIds.
Human log mode emits these events as full JSON without its usual truncation.

## Compare one call from input to playback

Replace YOUR_INTERNAL_CALL_ID with the selected test call ID:

```bash
docker logs --since 1h --timestamps zea-voice-backend 2>&1 \
  | grep 'YOUR_INTERNAL_CALL_ID' \
  | grep -E 'llm\.(request|response)_trace|voice\.(turn|playback)_trace' \
  > /tmp/zea-call-trace.log
cat /tmp/zea-call-trace.log
```

| Stage / event | Meaning |
| --- | --- |
| llm.request_trace | Exact serialized provider body after credential redaction |
| llm.response_trace | Provider JSON stream events, terminal status, provider request ID; same traceId as the request |
| voice.turn_trace / final_speech | Final validated speech selected by the engine, recovery/failure metadata |
| voice.turn_trace / tool_result | Actual executed tool results, with credential fields redacted |
| voice.turn_trace / configured_quick_reply | Configured response bypassing the LLM |
| voice.turn_trace / cached_technical_fallback | Cached technical recovery speech |
| voice.turn_trace / runtime_recovery_entered | Runtime recovery path and originating error code |
| voice.turn_trace / final_transcript | Text committed to the conversation transcript |
| voice.playback_trace / sentence_queued | Text scheduled for synthesis, not proof of playback |
| voice.playback_trace / tts_text_submitted | Actual synthesis text after pronunciation processing, including look-ahead attempts |
| voice.playback_trace / transport_packet_sent | Audio packet send completed, generation ID, duration/bytes; no raw audio |
| voice.playback_trace / playback_interrupted | Queued, synthesis-completed and audio-started sentence lists when interrupted |
| voice.playback_trace / sentence_failed | Failed sentence or optional acknowledgement and error code |
| voice.playback_trace / playback_drained | Local output queue drained; no remote playback acknowledgment |

Correlate all events by callId + turnEpoch; correlate individual LLM invocations
by traceId, and sentence/audio events by generationId. An initial greeting can
have no LLM request. An interrupted response can have no final_speech or committed
final transcript; its raw provider stream and playback events remain diagnostic.
The response collector holds at most 1,000,000 serialized characters per LLM
invocation and sets truncated=true if more arrive. Unselected/disabled calls
do not accumulate response events. Removing selection also suppresses subsequent
events. No hidden reasoning is collected; providerEvents are returned API data.

Audio-started text can include a sentence whose playback was cut short. A
successful WebSocket send does not prove the caller heard it. The pacer may
combine frames across sentence boundaries; firstGenerationId and generationId
identify packet endpoints, not word-level delivery. Use the call recording to
confirm the audible result. Packet tracing is verbose; select only test calls.

Stop selection immediately after testing:

```bash
docker exec zea-voice-backend sh -c ': > /app/artifacts/llm-trace-call-ids.txt'
```

Clear any static IDs too. Set LLM_REQUEST_TRACE_ENABLED=false and recreate the
backend at the next appropriate maintenance/deployment window. Recreating an
active voice backend can interrupt calls. Logger level must permit info events.

Checks: `node scripts/verify-llm-request-trace.js` and
`node scripts/verify-llm-response-playback-trace.js`, plus
`node scripts/verify-voice-llm-streaming.js` from Backend.
