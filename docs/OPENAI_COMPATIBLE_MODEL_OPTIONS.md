# OpenAI-compatible model request options

Configure these rows under Admin Model Parameters (stored in model settings):

| Key | Values | Default |
| --- | --- | --- |
| outputTokenParameter | max_tokens or max_completion_tokens | max_tokens |
| reasoning_effort | none, minimal, low, medium, high, xhigh, max | omitted |
| supportsTemperature | true/false (yes/no also accepted) | true |

Only choose values supported by the particular provider/model. This allowlist does not claim that every model accepts every effort value. Existing models without options retain their old request payload. Gemini and Anthropic adapters are not changed.

For GPT-6 Luna, set outputTokenParameter=max_completion_tokens, reasoning_effort=none, supportsTemperature=false (omit temperature for conservative compatibility). Keep Model Key=gpt-6-luna; credentials and Base URL remain provider settings. An existing numeric max_completion_tokens row is accepted as a compatibility selector when outputTokenParameter is absent, but its numeric value is ignored. Explicit outputTokenParameter takes precedence. Remove the numeric row to avoid confusion.

The actual output limit is always the current runtime maxOutputTokens. A 708-character main response budget currently computes 1608 tokens; utility and summary requests keep their existing per-request budgets. The change selects the API field name without overriding those budgets. It covers the streaming adapter and shared non-streaming OpenAI-compatible client. Arbitrary model parameters cannot override messages, tools, schemas, model, credentials, stream mode or token budget.

Invalid option names/values are rejected at model-setting normalization/runtime configuration. No migration or automatic model changes. No paid provider requests were made during verification. Run a browser test after deployment before changing customer agents; model output quality and live API compatibility still require testing.

Sources checked: https://developers.openai.com/api/docs/models/gpt-6-luna and https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create .

Checks: verify-openai-model-request-options.js, verify-voice-llm-streaming.js, verify-llm-request-trace.js and existing runtime/RAG regressions.
