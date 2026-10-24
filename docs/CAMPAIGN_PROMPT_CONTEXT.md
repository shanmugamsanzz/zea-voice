# Campaign purpose and summary

Existing real-time API: send string fields `context.call_purpose` and `context.summary`. Batch CSV: use columns `call_purpose` and `summary`; extra columns become task context.

Prompt variables: `{{call.purpose}}` and `{{call.summary}}`. Both appear in the agent prompt variable picker. Current campaign purpose takes precedence over historical purpose. Summary remains separate from previous conversation summaries. Only outbound campaign task metadata is read. Non-string values are ignored; purpose is limited to 1,000 characters and summary to 6,000.

Presence of either field enables the existing contextual LLM opening even with continuity disabled. Agent instructions control wording; existing generation fallback remains. Template-engine turns receive the same bounded data independently of history limits as untrusted reference data, never tool authorization or proof of booking success. Calls without supplied fields retain existing behavior. CRM/n8n schedules the trigger; no scheduling logic or new endpoint was added. No migration is required.

Checks: verify-campaign-prompt-context.js, verify-dynamic-prompt-values.js. Live real-time/batch verification remains required after deployment. Native audio-to-audio engines use a separate prompt path and are outside this template-engine change.
