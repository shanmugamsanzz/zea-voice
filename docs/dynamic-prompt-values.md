# Dynamic system prompt values — Task 3

Supported placeholders:

| Variable | Source / missing fallback |
| --- | --- |
| `{{contact.name}}` | Saved contact display name / empty |
| `{{contact.phone}}` | Inbound caller or outbound recipient / empty |
| `{{call.direction}}` | Persisted call direction / unknown |
| `{{call.purpose}}` | Current linked follow-up purpose or call-link purpose / unknown |
| `{{conversation.is_returning}}` | Earlier answered, linked call / false |
| `{{conversation.recent_summaries}}` | Latest completed summaries, newest first / empty |
| `{{conversation.latest_summary}}` | First included summary / empty |
| `{{conversation.last_outcome}}` | Latest included summary outcome / empty |
| `{{conversation.pending_questions}}` | Latest summary's `collected_data.pending_questions`, string or string array / empty |
| `{{conversation.last_call_at}}` | Earlier answered call timestamp / empty |
| `{{callback.reason}}` | Current follow-up or pending contact follow-up purpose / empty |
| `{{callback.status}}` | Follow-up status / empty |
| `{{callback.scheduled_for}}` | Effective due timestamp in UTC ISO format / empty |
| `{{callback.requested_at}}` | Task creation timestamp in UTC ISO format / empty |
| `{{current.datetime}}` | Call-start snapshot formatted in agent timezone |
| `{{current.timezone}}` | Agent timezone / UTC |

Example system instructions:

```text
Contact name: {{contact.name}}
Direction: {{call.direction}}
Current call purpose: {{call.purpose}}
Returning conversation: {{conversation.is_returning}}
Previous summaries: {{conversation.recent_summaries}}
Confirm identity before disclosing sensitive history. Do not assume this call
concerns the previous inquiry. Empty context means unknown, not a confirmed fact.
```

Expansion happens once during runtime preparation only for prompts containing
supported variables. Values are JSON-encoded context data. Expansion is not
recursive, does not evaluate expressions, and cannot access arbitrary object
properties, credentials, environment variables, or another company. Unsupported
placeholders remain untouched for compatibility. JSON encoding and model
instructions reduce ambiguity; they do not make untrusted summaries authoritative.
Existing tool authorization checks remain necessary.

Lookups require the exact company/workspace/call. Phone contacts and history
are shared across that company's workspaces by design. Follow-ups remain scoped
to the current workspace. Browser tests never look up real phone history.
Only completed summaries of earlier answered calls are included. Missing contact,
thread links or summary data remain empty when not yet available. Tasks 5 and 6
now link calls and populate completed summaries.
Summary count 0 suppresses summaries, their outcome and pending questions.
The combined summary text uses the configured character budget; final expansion
also respects the system-prompt character limit. A 1-second statement timeout
protects each context query. Lookup failures roll back and use empty history;
only variable names and error codes are logged, never context content.

Task 8 resolves the selected direction-specific system prompt and generates
contextual openings using this data. Name updates and historical linking are
implemented in Tasks 4 and 5; scheduling remains Task 9. Static welcomes retain
their existing template behavior. Summaries are generated after calls, so an immediately returning caller
may arrive before the latest summary finishes.

Apply the Task 1 and Task 2 migrations first. No new application environment
variables are required. Run `npm run verify:dynamic-prompt-values` plus runtime
regressions. Tests use controlled database fixtures; real PostgreSQL/staging
verification remains required before rollout.
