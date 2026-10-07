# Conversation tab

The Conversations navigation item is available to Company Users, Company Developers and Super Admin. Company roles see only calls and pending tasks in their authenticated company/workspace. Super Admin must select a company; its history may span that company's workspaces. Threads remain company-wide storage, but a company's user cannot view a call from a different workspace through this screen.

Contacts can be searched by name or phone. Selecting a contact shows calls oldest first, including missed/failed calls, summary status, completed summary/outcome, pending questions and follow-up notes. Pending scheduled follow-up tasks appear separately with purpose, status, due time and agent. A summary's follow-up note does not imply a scheduled task. Task 9 schedules new callback requests and mirrors new campaign callbacks; older campaign callbacks continue through their existing campaign tasks.

Each call has View conversation. The dialog fetches that call's final transcript in sequence, including caller, agent and system messages. Failed/skipped/unconfigured summaries do not prevent transcript viewing. No transcript available is shown for missed calls or calls without persisted final messages. Search results, history, follow-ups and transcripts use bounded pagination; Refresh updates the current history.

Read-only endpoints:

- `GET /conversations`: authenticated company workspace contact list.
- `GET /conversations/:conversationId`: contact, paged calls and pending follow-ups.
- `GET /conversations/:conversationId/calls/:callId/transcript`: transcript after verifying thread membership.
- Super Admin uses the corresponding `/admin/conversations` endpoints with required `companyId` query parameter.

API keys require `calls:read` or `*`. Company/workspace identifiers are derived from authenticated membership; cross-company overrides are rejected. Every transcript call lookup checks company, workspace and selected thread. The endpoints expose conversation content, not provider credentials, webhook responses, internal worker tokens or debugging sources. Task 9 adds session-authenticated cancellation of pending follow-ups for Super Admin and Company Developers through `POST /conversations/:conversationId/follow-ups/:taskId/cancel` (or its admin counterpart). Company Users and API keys cannot use this management action. See [follow-up scheduling](follow-up-scheduling.md).

Deploy the Tasks 1–6 migrations before using this tab. New phone calls link automatically; older records appear after the Task 5 bounded backfill. No environment changes are required. Run `npm run verify:conversation-view` from Backend, and `npm run lint` / `npm run build` from Frontend. Local API fixtures and frontend compilation do not replace staging checks with separate company accounts, transcript pagination and actual PostgreSQL RLS.
