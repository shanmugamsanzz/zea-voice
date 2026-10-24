# Sarvam Realtime STT

Backend support is opt-in through a separate model or provider entry. Existing saaras:v3 legacy configurations stay on the existing protocol. No automatic model changes or migrations.

## Admin configuration after deployment

- Runtime connection type: sarvam (existing selection).
- Provider base URL: wss://api.sarvam.ai/speech-to-text-realtime/ws
- Secret parameter: SARVAM_API_KEY (existing key aliases also supported).
- Model key: saaras:v3-realtime. saaras:v4 is also supported when the Realtime endpoint is explicitly selected.
- Model capabilities: runtime.adapter=sarvam, runtime.streaming=true, runtime.protocol=websocket; audio.input.encoding=pcm_s16le, audio.input.sampleRate=16000 (or 8000), audio.input.channels=1.
- Model parameters: language_code=auto, stream_type=fast, mode=transcribe, endpointing=vad. Optional VAD values: threshold, silence_duration_ms, min_speech_duration_ms. Omit to use provider defaults. Do not copy legacy frame-based VAD fields.
- Encoding and sample_rate are derived from actual input audio capabilities, not arbitrary model parameters. Realtime only accepts mono little-endian PCM in this adapter. Input is converted by the existing audio engine.

Partials remain plain transcription even when final mode is codemix or translit. Language switching for agent replies stays separate from STT language detection. stream_type=simulated deliberately disables provider partials and is inappropriate for fast barge-in.

## Protocol and behavior

Uses event=audio_input with base64 PCM; maps vad.speech_start, vad.speech_end, transcript.partial and transcript.final into existing normalized events. Partial words reach the existing text-triggered interruption policy immediately. Sound-start events alone do not cancel speech. Finals provide a speech boundary before LLM dispatch; partials never generate responses. The new adapter does not infer final speech from a quiet gap between partials. VAD endpointing owns finalization; the legacy runtime flush request is a no-op because Realtime flush is manual-only. Keepalive ping runs only during connection and is cleared on close.

Usage uses submitted PCM bytes without double-counting across close and session.end, following current internal duration accounting. Provider-authoritative billed audio reconciliation is not added here. No raw caller text/audio or API keys are added to diagnostics.

## Verification

Mock WebSocket tests: node scripts/verify-sarvam-realtime.js. Existing verify-voice-stt.js and verify-stt-provider-adapters.js also pass. Tests do not access the paid provider. Account/model access, actual latency, multilingual accuracy, long-sentence partial timing and real browser/Plivo calls require live verification. First-word cancellation still depends on provider partial delivery, not guaranteed instantaneous silence.

Official protocol: https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming
