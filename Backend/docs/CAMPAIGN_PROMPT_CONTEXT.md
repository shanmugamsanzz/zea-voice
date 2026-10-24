# Campaign prompt context

Real-time tasks accept `context.call_purpose` and `context.summary` as strings. Batch CSV imports accept extra columns named `call_purpose` and `summary`; they become the same context fields. Existing endpoint and event-ID deduplication are unchanged.

Outbound campaign calls expose `{{call.purpose}}` (trigger purpose overrides older purpose) and `{{call.summary}}` (current trigger summary, distinct from conversation summaries). Both are listed in the agent prompt editor. Purpose is bounded to 1,000 characters and summary to 6,000; non-string values are ignored. Only outbound call metadata linked to a campaign task is accepted.

When either field is present, a contextual LLM opening is requested even when conversation continuity is disabled. Existing opening normalization and failure fallback remain in place. The agent prompt controls wording; CRM/n8n handles scheduling. The data is also supplied as untrusted reference context to every template-engine turn, independently of history limits. It does not authorize tools or verify appointment/message success. No automatic transfer, scheduling or business-specific greeting was added.

Calls without these fields retain the prior opening path. Browser tests and inbound calls do not consume campaign trigger metadata. No database migration is needed. Existing task/call persistence and tenant-scoped loading are reused; this feature adds no cross-tenant query.

Example context: `{"call_purpose":"appointment_reminder","summary":"Customer has an appointment tomorrow at 3 PM."}`.

Run `node scripts/verify-campaign-prompt-context.js` and `node scripts/verify-dynamic-prompt-values.js` from Backend with test environment configuration. Live real-time and CSV campaign calls must still be verified after deployment. Native audio-to-audio engines have their own prompt path and are not covered by the template-engine injection.
