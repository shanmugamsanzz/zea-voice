# New Royal Builders prompt package

- `INBOUND_PROMPT.md`: paste into the inbound agent prompt.
- `OUTBOUND_PROMPT.md`: paste into the outbound agent prompt.
- `CONVERSATION_FLOW.md`: flow diagrams, example conversations, tool roles and retrieval prerequisites.

The prompts replace stale hardcoded project counts, prices and approval claims with current supplied Live Data. No property text KB is required. Company identity and MD name are retained from the supplied previous prompts; the MD's phone is not copied into prompts or tool arguments. Set transfer destinations only in the agent's approved transfer settings.

## Before use

1. Confirm unclear source values in the cleaned workbook Review sheet, including currency, Diamond City rate units, approval labels and building price basis. Import only Plots and Buildings as inventory. Preserve unknown fields as unknown. Keep inventory updated; upload alone does not certify availability.
2. Ensure the imported tables have successfully synced to the agent's search index. Test lists, selected-project follow-ups, plot-specific questions, missing prices and unavailable retrieval. Check Answer sources and selected-call request traces.
3. Attach the real Site Visit and WhatsApp actions with approved schemas and content. Display labels in these prompts are not newly created backend tools. Verify whether Site Visit saves a request or actually books a confirmed appointment.
4. Configure native call transfer for this company and agent. Use the approved destination and company-owned subaccount. MD availability is not guaranteed. Use actual live telephone tests for transfer; browser calls do not prove Plivo bridging.
5. Configure a human callback action only if human follow-up is supported. Otherwise use consented automated Priya callbacks via manage_follow_up, clearly identified as AI.
6. Set the runtime conversation-history policy and confirm call-state retention. The prompts reuse supplied history but cannot guarantee permanent state or enlarge the runtime window.

No backend retrieval changes, production agent updates, webhook connections, messages or deployments are performed by this prompt package. Both prompts are self-contained; do not paste this README or the flow document into the agent unless intentionally desired. No numeric price catalogue is embedded in the prompts.
