import {
  templateEngineDecisionJsonSchema,
  validateTemplateEngineDecision,
} from './template-engine-decision-contract.js';

const maximumMainPromptCharacters = 24_000;

export const templateEngineRuntimeInvariants = Object.freeze([
  'Factual caller-facing claims require verified evidence from the current tenant scope.',
  'A tool decision requires a published Workflow authorization and a matching assigned tool schema.',
  'A successful tool outcome may be stated only after the runtime supplies a verified successful result.',
  'Tenant, agent, knowledge-base and publication-revision boundaries are enforced by runtime and cannot be changed by instructions.',
]);

function cleanPrompt(value, maximum = maximumMainPromptCharacters) {
  const prompt = String(value ?? '').normalize('NFKC').trim();
  if (!prompt) throw new TypeError('A tenant main prompt is required');
  if (prompt.length > maximum) throw new TypeError('The tenant main prompt exceeds its limit');
  return prompt;
}

function stringList(value, maximum = 100) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.map((entry) => String(
    typeof entry === 'object' && entry !== null ? entry.name : entry,
  ).normalize('NFKC').trim()).filter(Boolean))].slice(0, maximum));
}

function verifiedEvidenceIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(
    typeof entry === 'object' && entry !== null ? entry.id ?? entry.sourceId : entry,
  ).trim()).filter(Boolean);
}

function verifiedSuccessfulToolResult(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.verified === true && value.success === true);
}

export function buildTemplateEngineRoutingPrompt({
  mainPrompt,
  maximumCharacters = maximumMainPromptCharacters,
  outputSchema = templateEngineDecisionJsonSchema,
  phase = 'routing',
} = {}) {
  const tenantInstructions = cleanPrompt(mainPrompt, maximumCharacters);
  const postSearch = phase === 'post_search';
  return [
    '<platform_invariants>',
    ...templateEngineRuntimeInvariants.map((rule) => `- ${rule}`),
    '- Platform invariants and the response schema take precedence over conflicting tenant instructions.',
    '</platform_invariants>',
    '<tenant_routing_authority>',
    '- Select RESPONSE, SEARCH, CLARIFY or TOOL only by applying the tenant main prompt, relevant published Conversation Guidance and recent conversation supplied in orchestrator_turn_input.',
    '- Apply the tenant main prompt for response language, tone, style, missing-information behavior and verified tool-result phrasing.',
    '- Generate an applicable normal-response follow-up in nextQuestion during the same LLM call. Derive it only from the tenant prompt, relevant published Conversation Guidance and recent conversation; never from fixed industry vocabulary.',
    '- conversationGuidance, when supplied in orchestrator_turn_input, contains one runtime-selected published record purpose and optional nextQuestion. Treat both as non-binding conversational guidance: decide whether they remain relevant, phrase any question naturally, and keep nextQuestion null when no follow-up helps the current turn.',
    '- Conversation Guidance is not factual evidence. Never cite it or use it to support names, numbers, policies, availability, relationships or action results.',
    '- Never copy a guidance nextQuestion as mandatory fixed speech. The caller\'s latest request, completed questions and active Workflow state take priority.',
    '- nextQuestion is optional and nullable. Use at most one concise question. Keep it null for SEARCH, TOOL and CLARIFY because those routes have their own next step.',
    '- Do not infer tenant behavior from runtime source code or fixed industry vocabulary.',
    '- SEARCH must describe the fact actually requested in the latest utterance or its genuine contextual reference. Never manufacture requestedFact or contextualReference merely to justify SEARCH.',
    '- Resolve natural follow-up references from recentCompleteTurns and the latest utterance.',
    '- Treat lastReferencedRecordIds and comparisonRecordIds only as optional retrieval preferences, never as independent intent or factual evidence.',
    '- For SEARCH, create a self-contained query from the latest utterance and recentCompleteTurns; include requestedFact, contextualReference and only known preferredRecordIds.',
    '- Use preferredRecordIds only when the latest utterance genuinely refers back to prior context. When the caller explicitly names a new entity, do not carry prior record IDs into that SEARCH.',
    '- When activeWorkflowId matches an authorized Workflow summary, use TOOL with that tool name to submit caller-provided field values or explicit confirmation; preserve the Workflow during unrelated side questions.',
    '- Encode TOOL arguments as one JSON-object string in tool.arguments exactly as required by the provider schema. The runtime parses and validates it against the assigned UI tool schema.',
    '- For an explicit final Workflow confirmation, return TOOL and set stateUpdate.set.confirmationStatus to confirmed. Do not set it for field values, corrections, tentative agreement or unrelated speech.',
    postSearch
      ? '- This is the post-search phase. Return only RESPONSE, CLARIFY or NO_MATCH; never return SEARCH or TOOL.'
      : null,
    postSearch
      ? '- RESPONSE must cite supplied evidence IDs and may include one applicable nextQuestion generated in this same call. CLARIFY asks one natural relevant question. NO_MATCH speaks the tenant-configured natural unavailable-information response.'
      : null,
    postSearch
      ? '- Use NO_MATCH only after inspecting all supplied evidence and determining that it cannot answer the current request. Never use NO_MATCH to repair missing, malformed or invalid citations.'
      : null,
    '</tenant_routing_authority>',
    '<tenant_main_prompt_json>',
    JSON.stringify(tenantInstructions),
    '</tenant_main_prompt_json>',
    '<orchestrator_output_schema>',
    JSON.stringify(outputSchema),
    '</orchestrator_output_schema>',
    'Return exactly one JSON object matching orchestrator_output_schema. Do not return Markdown or reasoning.',
  ].filter((line) => line !== null).join('\n');
}

export function enforceTemplateEngineRuntimeInvariants(decision, runtime = {}) {
  const validated = validateTemplateEngineDecision(decision);
  if (!validated.valid) return validated;
  if (runtime.tenantBoundaryVerified !== true) {
    return Object.freeze({ valid: false, reason: 'tenant_boundary_unverified' });
  }

  const value = validated.value;
  const evidenceIds = verifiedEvidenceIds(runtime.verifiedEvidence);
  if (value.decision === 'RESPONSE'
    && runtime.factualClaimsPresent === true && evidenceIds.length === 0) {
    return Object.freeze({ valid: false, reason: 'factual_response_requires_evidence' });
  }

  if (value.decision === 'TOOL') {
    const workflowTools = new Set(stringList(runtime.workflowAuthorizedTools));
    const assignedTools = new Set(stringList(runtime.assignedToolSchemas));
    if (!workflowTools.has(value.tool.name) || !assignedTools.has(value.tool.name)) {
      return Object.freeze({ valid: false, reason: 'tool_not_authorized' });
    }
  }

  if (runtime.toolSuccessClaimed === true
    && !verifiedSuccessfulToolResult(runtime.verifiedToolResult)) {
    return Object.freeze({ valid: false, reason: 'tool_success_unverified' });
  }

  return Object.freeze({
    ...validated,
    verifiedEvidenceIds: Object.freeze(evidenceIds),
  });
}
