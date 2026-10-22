# Latency acknowledgement modes

Existing agents keep single-message playback by default. Single and multiple modes are mutually exclusive in the editor; both may be off. The stored single message is retained when disabled. No database migration is required; configuration is in agent settings.

Multiple mode: choose up to 10 unique language groups, each with up to 20 phrases of 200 characters. Tamil and Tanglish share ta; choose wording consistent with the agent prompt/TTS. Selection uses the per-call responseLanguage, falling back to the Overview language. Missing language groups are silent, never fall back to another language.

Frequency is every N eligible SEARCH turns (1 to 20; default 2), or independent 50 percent probability per eligible search. Direct responses and tool routes do not advance the counter. The counter is per call across languages; phrase-repeat history is per language and updates when speech is queued. Count is based on eligible searches, not successful playback, so quick searches can consume an interval without acknowledgement. Selection avoids the last queued phrase when another unique phrase exists.

The original 750 ms default threshold, SEARCH gating, final-answer cancellation, interruption and call-ending guards remain in the existing speech pipeline. Language changes cancel pending acknowledgement; audio already heard cannot be recalled. The switch is known only when the model returns its metadata. Static audio caching continues using the existing runtime-profile/text cache; no extra LLM request.

Settings: latencySingleEnabled (default true), latencyMultipleEnabled (default false), latencyPhraseInterval (default 2 or random), latencyPhraseGroups ([{language,phrases}]). Server validates modes and bounds. Existing tool, answer generation, STT and TTS configuration are unchanged.

Validation: verify-acknowledgement-phrases.js, existing call/runtime/RAG regressions, and frontend TypeScript. Before rollout verify UI save/reload, a live language switch and interrupted/delayed SEARCH playback in UAT.
