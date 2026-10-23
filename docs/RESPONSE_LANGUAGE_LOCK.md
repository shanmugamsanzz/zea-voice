# Per-call response language

The agent Overview language initializes the main LLM response language. Human-readable labels are normalized to language codes. Each accepted turn passes this preference independently of retained conversation history.

The existing universal LLM response now includes nullable languageChange metadata (language and exact current requestQuote). Instructions require an explicit caller request permitted by the agent prompt; mixed speech alone must not change it. The backend validates code format and quote presence, then stores the preference on the individual orchestrator only if that turn is still current. No extra LLM request, database migration or global shared state is introduced. The same-turn tool-result response uses the updated language. Old/custom invokers without metadata retain the current preference.

This is an LLM response preference, not a hard output-language verifier. Semantic recognition of explicit requests and allowed-language restrictions remains the LLM responsibility. Per-call memory ends with the runtime; no cross-call preference is saved. Static greetings/acknowledgements/recovery text are still configured text and are not translated by this change. STT and TTS provider settings remain unchanged; the voice must support the selected language.

Checks: verify-response-language.js, verify-universal-answer-pass-through.js and verify-template-engine-production-runtime.js. Validate Tamil to English and back in staging with one-turn history and tool execution before production rollout.

## Live-call hardening

Response-language instructions explicitly recognize polite capability questions as switch requests, require same-response languageChange metadata, and distinguish default-language examples from the persistent preference. Request evidence matching tolerates Unicode normalization, case and whitespace differences while still requiring a substring of the current caller message. Backend logs voice.response_language_input and voice.response_language record prior/requested/resulting language, acceptance and stale-turn status without recording request quotes. Semantic recognition and actual spoken language still depend on the model: these changes do not prove the cause of the previously supplied call or guarantee compliance. Replay that case with traces in UAT.
