# Generic Workflow Stage Flow Format

The runtime never hardcodes an industry flow. Each tenant creates its own ordered stages through approved Workflow Rules.

```text
RULE: advance_to_overview
MATCH: approved positive response phrases
MATCH_MODE: any_phrase
FROM_STAGE: intro
NEXT_STAGE: overview
RESPONSE_MODE: exact
RESPONSE: Approved overview response from this tenant.

RULE: begin_booking
MATCH: tenant-approved booking request phrases
MATCH_MODE: any_phrase
FROM_STAGE: confirmation
NEXT_STAGE: booking_details
ACTION: complete_booking
REQUIRES_CATALOG_ITEM: true
BLOCKED_RESPONSE: Please select an approved option before booking.
RESPONSE_MODE: exact
RESPONSE: Approved booking opening response.
```

Rules may only move a call from their configured `FROM_STAGE` to `NEXT_STAGE`. A booking action can require a selected approved Catalog item. Information fields linked to that action remain locked until the action becomes active.

Use a Scenario Rule when a caller describes a need without naming an item:

```text
RULE: scenario_needs_guidance
SCENARIO: true
MATCH: tenant-approved scenario phrases
MATCH_MODE: any_phrase
TARGET_CATEGORY: tenant-category-key
RESPONSE_MODE: exact
RESPONSE: Tenant-approved safe guidance.
```

Scenario Rules require `TARGET_CATEGORY` or `TARGET_ITEM`; otherwise they are rejected during document processing. The caller may ask a valid side question at any stage. The runtime answers it, preserves the pending question and resumes the configured stage.
