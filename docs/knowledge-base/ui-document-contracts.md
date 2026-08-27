# Generic UI-managed agent contracts

These formats are tenant data. Runtime code must not contain company names, product names, aliases, prices, stages, spoken sentences or business rules. A company configures one Master Prompt and uploads the five document types below.

## 1. Master Prompt (Agent USER IINTERFACE)

```text
ROLE: {{tenant-defined role}}
LANGUAGE_POLICY: {{tenant-defined language behaviour}}
SPEAKING_STYLE: {{tenant-defined voice style}}
GOAL: {{tenant-defined outcome}}
GROUNDING: Use only published tenant evidence.
FLOW_POLICY: Answer the latest valid question, preserve call state, and apply only Workflow-defined transitions.
UNCERTAINTY_POLICY: Use the Workflow-configured clarification or escalation response.
```

The prompt controls behaviour and style. It must not duplicate Catalog facts or Workflow transitions.

## 2. Product or Service Catalog document

One category header is followed by its items. Every item must have a price-bearing line so it is extracted as a structured item. `ATTRIBUTES` stores any tenant-defined facts such as features, inclusions, preparation or availability.

```text
CATEGORY: Service Plans | KEY=service-plans | ALIASES=Plans, Options | DESCRIPTION=Approved plans
Standard Plan INR 100 | KEY=standard-plan | ALIASES=Standard, Basic | DESCRIPTION=Standard service | ATTRIBUTES={"features":["Feature A","Feature B"],"preparation":"Tenant-approved instruction"} | RELATIONSHIPS={"alternatives":["premium-plan"]} | SELECTION_RULES={"bookable":true}
Premium Plan INR 200 | KEY=premium-plan | ALIASES=Premium, Advanced | DESCRIPTION=Premium service | ATTRIBUTES={"features":["Feature A","Feature B","Feature C"]}
```

Aliases contain only useful canonical, natural and known STT variants. The caller never needs to say the full item name.

## 3. Workflow Rules document

```text
RULE: present_overview
MATCH: tenant-approved phrase one | tenant-approved phrase two
MATCH_MODE: any_phrase
RESPONSE_MODE: exact
PRIORITY: 100
FROM_STAGE: intro
NEXT_STAGE: overview
RESPONSE: Tenant-approved caller-facing response.

RULE: begin_configured_action
MATCH: tenant-approved action request phrases
INTENT_CLASS: ACTION_TOOL_REQUEST
MATCH_MODE: any_phrase
RESPONSE_MODE: exact
FROM_STAGE: explanation | confirmation
NEXT_STAGE: collect_fields
ACTION: configured-action-key
REQUIRES_CATALOG_ITEM: true
BLOCKED_RESPONSE: Tenant-approved item clarification.
RESPONSE: Tenant-approved action opening.

`INTENT_CLASS` is optional and accepts `KNOWN_INFORMATION`, `DETAILS_OR_PRICE`,
`CATEGORY_OVERVIEW`, `COMPARISON_COMPLEX`, `ACTION_TOOL_REQUEST`,
`CLARIFICATION_ANSWER`, `ACKNOWLEDGEMENT`, `CALL_CONTROL`,
`SAFETY_EMERGENCY`, or `UNKNOWN`. Safety and call-control classes always receive
runtime priority. Their multilingual phrases remain tenant-owned `MATCH` data.

RULE: ambiguous_evidence_response
CONFIDENCE_OUTCOME: ambiguous
RESPONSE_MODE: exact
PRIORITY: 900
RESPONSE: Tenant-approved targeted clarification using the presented candidates.

RULE: no_evidence_response
CONFIDENCE_OUTCOME: none
RESPONSE_MODE: exact
PRIORITY: 910
RESPONSE: Tenant-approved safe fallback or human-support response.
```

Workflow Rules own matching phrases, stages, transitions, actions, safety rules, scenario targets and fallback responses. `CONFIDENCE_OUTCOME` accepts `ambiguous` or `none`; these rules do not require `MATCH` because the evidence ranker invokes them.

## 4. Conversation Script document

```text
STAGE: overview
FLOW: main
LANGUAGE: ta
INTENT_CLASS: KNOWN_INFORMATION
ENTRY: true
PURPOSE: Present approved categories naturally.
CATALOG_REFERENCES: Caller-facing option name => category:service-plans
RESPONSE: Tenant-approved spoken overview.
NEXT_QUESTION: Tenant-approved next question?
NEXT_STAGE: explanation

STAGE: explanation
FLOW: main
LANGUAGE: ta
PURPOSE: Explain the active Catalog item using retrieved facts.
RESPONSE: Tenant-approved natural response pattern using approved runtime values.
NEXT_QUESTION: Tenant-approved continuation question?
NEXT_STAGE: confirmation
```

The Conversation Script controls spoken wording. It does not own prices, item facts or action authority.

## 5. FAQ document

Use `|` between alternate questions. Each alias is indexed as another question with the same approved answer.

```text
QUESTION: What does the selected item include?
ALIASES: What is covered? | Explain this option | Tell me the details
INTENT_CLASS: DETAILS_OR_PRICE
CATALOG_REFERENCE: Caller-facing item name => item:standard-plan
ANSWER: Tenant-approved answer grounded in the selected Catalog item.
```

`CATALOG_REFERENCE` and `CATALOG_REFERENCES` link caller-facing wording to a
published Catalog `item` or `category` key. Use `|` for multiple mappings. An
unknown or ambiguous target blocks publication; a category overview without
declared references produces a publication warning. The caller-facing phrase
is indexed as a tenant-owned alias for the referenced Catalog record.

## 6. General Knowledge document

```text
TOPIC: Company location
ALIASES: address | directions | where are you located
ANSWER: Tenant-approved location information.

TOPIC: No confident answer
ANSWER: Tenant-approved clarification or human-support response.
```

General Knowledge is semantically chunked. Keep each topic self-contained and do not mix unrelated facts in one block.

## Ownership summary

| Source | Owns |
|---|---|
| Master Prompt | Role, style, language policy, global behavioural boundaries |
| Catalog | Categories, items, aliases, hierarchy, price and attributes |
| Workflow Rules | Matching, stages, transitions, scenarios, actions and fallbacks |
| Conversation Script | Natural spoken wording for a stage |
| FAQ | Approved answers to natural follow-up questions |
| General Knowledge | Stable tenant facts and policies |

## Runtime enforcement

- Retrieval runs the published Catalog, Workflow, Script, FAQ and General Knowledge channels together. Ranking uses call state and document metadata; it does not create tenant facts.
- Only Workflow Rules may authorize a stage transition or action. A side question is answered first, then the saved document-configured stage and pending question resume.
- Generated speech is checked sentence by sentence against its cited published evidence before TTS. Unsupported entities, numbers, technical terms, policies, actions and internal instruction text are blocked.
- Partial STT may interrupt current audio, but only final STT starts retrieval and response generation.
- The runtime records end-to-end first-audio latency. The production objective is below 1,000 ms; local retrieval tests exclude provider and network latency, so deployment monitoring must verify the complete target.
