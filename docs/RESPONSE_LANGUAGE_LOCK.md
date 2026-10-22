# Per-call response language

The agent Overview language initializes the main LLM response language. Human-readable labels are normalized to language codes. Each accepted turn passes this preference independently of retained conversation history.

The existing universal LLM response now includes nullable languageChange metadata (language and exact current requestQuote). Instructions require an explicit caller request permitted by the agent prompt; mixed speech alone must not change it. The backend validates code format and quote presence, then stores the preference on the individual orchestrator only if that turn is still current. No extra LLM request, database migration or global shared state is introduced. The same-turn tool-result response uses the updated language. Old/custom invokers without metadata retain the current preference.

This is an LLM response preference, not a hard output-language verifier. Semantic recognition of explicit requests and allowed-language restrictions remains the LLM responsibility. Per-call memory ends with the runtime; no cross-call preference is saved. Static greetings/acknowledgements/recovery text are still configured text and are not translated by this change. STT and TTS provider settings remain unchanged; the voice must support the selected language.

Checks: verify-response-language.js, verify-universal-answer-pass-through.js and verify-template-engine-production-runtime.js. Validate Tamil to English and back in staging with one-turn history and tool execution before production rollout.
