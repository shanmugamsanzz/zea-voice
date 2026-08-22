import { createKnowledgeEngineDecision, knowledgeEngineDecisionTypes } from './engine-contract.js';
import { knowledgeQueryClasses } from './query-classifier.js';
import { validateGroundedClaims } from '../voice/interaction/grounded-claim-validator.js';
import { validateToolArguments } from '../voice/tools/tool-security.js';
import { executeAgentTool } from '../voice/tools/tool-executor.service.js';

export const SAFE_RESPONSE_TOOL_RUNTIME_VERSION = 1;

const directIntentClasses = new Set([
  knowledgeQueryClasses.KNOWN_INFORMATION,
  knowledgeQueryClasses.DETAILS_OR_PRICE,
  knowledgeQueryClasses.CATEGORY_OVERVIEW,
  knowledgeQueryClasses.CLARIFICATION_ANSWER,
  knowledgeQueryClasses.ACKNOWLEDGEMENT,
  knowledgeQueryClasses.CALL_CONTROL,
  knowledgeQueryClasses.SAFETY_EMERGENCY,
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizedId(value) {
  return cleanText(value, 200).toLocaleLowerCase();
}

function toolIdentity(value) {
  return cleanText(value, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function toolIdentifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return new Set([
    tool.id, tool.name, configuration.identifier, configuration.toolIdentifier,
    configuration.actionKey, configuration.key, ...(tool.identifiers ?? []),
  ].map(toolIdentity).filter(Boolean));
}

function configuredToolSchema(tool = {}) {
  const configuration = object(tool.configuration);
  return object(tool.inputSchema ?? configuration.inputSchema ?? configuration.input_schema
    ?? configuration.parametersSchema ?? configuration.parameters_schema);
}

function workflowToolIdentifier(source) {
  const data = object(source?.authoritativeData);
  const configuration = object(data.actionConfig);
  return toolIdentity(configuration.toolIdentifier ?? configuration.actionKey);
}

function sameScope(input, hydrated) {
  return normalizedId(input?.tenantId) === normalizedId(hydrated?.tenantId)
    && normalizedId(input?.agentId) === normalizedId(hydrated?.agentId)
    && String(input?.callId ?? '') === String(hydrated?.callId ?? '');
}

function evidenceIds(evidence) {
  return [...new Set((evidence ?? []).map((source) => cleanText(source?.id, 300)).filter(Boolean))];
}

function clarification(kind, reason, prompt = null, evidence = []) {
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.CLARIFY, {
    reason,
    evidenceIds: evidenceIds(evidence),
    clarification: { kind, prompt: cleanText(prompt, 800) || null },
  });
}

function targetedAmbiguityPrompt(ambiguity) {
  const labels = (ambiguity?.candidates ?? []).map((candidate) => (
    cleanText(candidate.name ?? candidate.itemKey, 120)
  )).filter(Boolean).slice(0, 3);
  return labels.length
    ? `Please confirm which one you mean: ${labels.join(', ')}.`
    : 'Please clarify which published option you mean.';
}

function directText(source) {
  const data = object(source?.authoritativeData);
  if (source?.recordType === 'FAQ') return cleanText(data.answer ?? source.content);
  if (source?.recordType === 'CONVERSATION_NODE') return cleanText(data.content ?? source.content);
  if (source?.recordType === 'WORKFLOW_RULE') return cleanText(data.responseTemplate ?? source.content);
  return cleanText(data.sourceText ?? source?.content);
}

function searchableEvidenceText(source) {
  let structured = '';
  try { structured = JSON.stringify(source?.authoritativeData ?? {}); } catch { structured = ''; }
  return cleanText(`${source?.content ?? ''} ${structured}`, 32_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function responseSentences(value) {
  const normalized = cleanText(value);
  if (!normalized) return [];
  if (globalThis.Intl?.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(normalized)]
      .map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return normalized.split(/(?<=[.!?])\s+/u).map((entry) => entry.trim()).filter(Boolean);
}

function unsupportedClaimSentence(answer, selected) {
  const evidenceText = selected.map(searchableEvidenceText).join(' ');
  const evidenceTokens = new Set(evidenceText.split(' ').filter((token) => (
    token.length >= 3 || /\d/u.test(token)
  )));
  return responseSentences(answer).find((sentence) => {
    const normalized = cleanText(sentence).toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
    if (!normalized || evidenceText.includes(normalized)) return false;
    const claimTokens = [...new Set(normalized.split(' ').filter((token) => (
      token.length >= 3 || /\d/u.test(token)
    )))];
    if (!claimTokens.length) return true;
    const coverage = claimTokens.filter((token) => evidenceTokens.has(token)).length / claimTokens.length;
    return coverage < 0.5;
  }) ?? null;
}

export function validateFinalKnowledgeResponse({
  input, answer, selectedEvidenceIds, evidence = [], knownEntities = [],
} = {}) {
  const text = cleanText(answer);
  if (!text) return Object.freeze({ valid: false, reason: 'empty_response' });
  const available = new Map(evidence.map((source) => [normalizedId(source?.id), source]));
  const citations = [...new Set((selectedEvidenceIds ?? []).map(normalizedId).filter(Boolean))];
  if (!citations.length) return Object.freeze({ valid: false, reason: 'citations_required' });
  const unknownCitation = citations.find((id) => !available.has(id));
  if (unknownCitation) return Object.freeze({
    valid: false, reason: 'unknown_citation', citationId: unknownCitation,
  });
  const selected = citations.map((id) => available.get(id));
  if (selected.some((source) => (
    normalizedId(source.tenantId) !== normalizedId(input?.tenantId)
    || normalizedId(source.agentId) !== normalizedId(input?.agentId)
    || (String(source.recordType).toUpperCase() !== 'TOOL_RESULT'
      && (source.hydrationValidated !== true || source.publicationValidated !== true))
  ))) return Object.freeze({ valid: false, reason: 'non_authoritative_evidence_selected' });
  if (selected.some((source) => source.callerFacing === false
    && String(source.recordType).toUpperCase() !== 'TOOL_RESULT')) {
    return Object.freeze({ valid: false, reason: 'instruction_evidence_selected' });
  }
  const claims = validateGroundedClaims(text, selected, {
    finalizedUtterance: input?.utterance,
    knownEntities: knownEntities.length ? knownEntities : input?.memory?.knownEntities,
  });
  if (!claims.valid) return claims;
  const unsupportedSentence = unsupportedClaimSentence(text, selected);
  if (unsupportedSentence) return Object.freeze({
    valid: false, reason: 'unsupported_claim', sentence: unsupportedSentence,
  });
  return Object.freeze({
    valid: true,
    answer: text,
    evidenceIds: Object.freeze(selected.map((source) => source.id)),
    evidence: Object.freeze(selected),
  });
}

function withWorkflow(decision, workflow) {
  return Object.freeze({ ...decision, toolWorkflow: Object.freeze(workflow) });
}

function fieldPrompt(key, schema) {
  const property = object(object(schema.properties)[key]);
  const label = cleanText(property.title ?? property.label, 120)
    || cleanText(key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' '), 120);
  return cleanText(property.question ?? property['x-question'] ?? property['ui:question']
    ?? property.prompt ?? property.description, 600) || `Please provide ${label}.`;
}

function assignedWorkflowTool(evidence, runtimeProfile) {
  const workflows = evidence.filter((source) => (
    source.recordType === 'WORKFLOW_RULE'
    && source.hydrationValidated === true
    && String(source.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && workflowToolIdentifier(source)
  ));
  const matches = [];
  for (const workflow of workflows) {
    const identifier = workflowToolIdentifier(workflow);
    const requiresCatalogItem = workflow.authoritativeData?.actionConfig?.requiresCatalogItem === true;
    const catalogMatches = evidence.filter((source) => (
      source.recordType === 'CATALOG_ITEM'
      && source.hydrationValidated === true
      && source.authoritativeData?.selectionRules?.selectable === true
    ));
    if (requiresCatalogItem && catalogMatches.length !== 1) continue;
    for (const tool of runtimeProfile?.tools ?? []) {
      if (toolIdentifiers(tool).has(identifier)) matches.push({
        workflow, tool, catalogItem: requiresCatalogItem ? catalogMatches[0] : null,
      });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function collectedArguments(input, tool, schema) {
  const active = object(input?.memory?.activeTool);
  const sameTool = !active.name || toolIdentifiers(tool).has(toolIdentity(active.name));
  const supplied = sameTool ? object(input?.memory?.collectedToolFields) : {};
  const properties = object(schema.properties);
  return Object.fromEntries(Object.entries(supplied).filter(([key]) => (
    Object.hasOwn(properties, key) || schema.additionalProperties === true
  )));
}

export function planAuthorizedToolWorkflow({
  input, authoritative, runtimeProfile, confirmation = false,
} = {}) {
  const evidence = authoritative?.evidence ?? [];
  const authorized = assignedWorkflowTool(evidence, runtimeProfile);
  if (!authorized) return clarification(
    'no_evidence', 'authorized_assigned_tool_unavailable',
    'I cannot safely start that action because no single assigned tool is authorized by the published workflow.',
    evidence.filter((source) => source.recordType === 'WORKFLOW_RULE'),
  );
  const { workflow, tool, catalogItem } = authorized;
  const schema = configuredToolSchema(tool);
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => (
    typeof key === 'string' && key
  )) : [];
  const inputArguments = collectedArguments(input, tool, schema);
  const missingFields = required.filter((key) => (
    inputArguments[key] === undefined || inputArguments[key] === null
    || (typeof inputArguments[key] === 'string' && !inputArguments[key].trim())
  ));
  const baseTool = {
    name: tool.name,
    authorizationEvidenceId: workflow.id,
    input: inputArguments,
  };
  const decision = createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.TOOL, {
    reason: missingFields.length ? 'collect_required_tool_fields'
      : (confirmation ? 'authorized_tool_ready' : 'tool_confirmation_required'),
    evidenceIds: [workflow.id, catalogItem?.id].filter(Boolean),
    tool: baseTool,
  });
  if (missingFields.length) return withWorkflow(decision, {
    status: 'COLLECTING_FIELDS',
    missingFields: Object.freeze(missingFields),
    prompt: fieldPrompt(missingFields[0], schema),
    inputSchema: Object.freeze(schema),
  });
  try {
    validateToolArguments(inputArguments, schema);
  } catch (error) {
    return clarification('ambiguity', 'invalid_collected_tool_fields', error.message, [workflow]);
  }
  const requiresConfirmation = schema['x-requires-confirmation'] !== false;
  if (requiresConfirmation && confirmation !== true) return withWorkflow(decision, {
    status: 'AWAITING_CONFIRMATION',
    missingFields: Object.freeze([]),
    prompt: cleanText(schema['x-confirmation-message'], 800)
      || 'Please confirm whether I should perform this action now.',
    inputSchema: Object.freeze(schema),
  });
  return withWorkflow(decision, {
    status: 'READY_TO_EXECUTE',
    missingFields: Object.freeze([]),
    prompt: null,
    inputSchema: Object.freeze(schema),
  });
}

export function planSafeKnowledgeResponse({
  input, classification, resolution, authoritative, runtimeProfile, confirmation = false,
} = {}) {
  if (!sameScope(input, authoritative)) {
    throw new TypeError('Safe response planning requires same-tenant, same-agent and same-call evidence');
  }
  const evidence = authoritative.evidence ?? [];
  if (authoritative.conflict?.detected) return clarification(
    'conflict', 'conflicting_authoritative_evidence',
    'I found conflicting published information. Please clarify the requested option.', evidence,
  );
  const isComparison = classification?.intentClass === knowledgeQueryClasses.COMPARISON_COMPLEX;
  if (authoritative.ambiguity?.detected
    || (classification?.requiresConfirmation === true && !isComparison)) {
    return clarification('ambiguity', 'ambiguous_authoritative_entity',
      targetedAmbiguityPrompt(authoritative.ambiguity), evidence);
  }
  if (classification?.intentClass === knowledgeQueryClasses.ACTION_TOOL_REQUEST) {
    return planAuthorizedToolWorkflow({ input, authoritative, runtimeProfile, confirmation });
  }
  const callerFacing = evidence.filter((source) => source.callerFacing === true);
  if (classification?.intentClass === knowledgeQueryClasses.COMPARISON_COMPLEX) {
    if (!callerFacing.length) return clarification(
      'no_evidence', 'grounded_reasoning_evidence_unavailable',
      'Please clarify the options you want compared.', evidence,
    );
    return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.LLM, {
      reason: 'grounded_multi_evidence_reasoning_required',
      confidence: classification.confidence,
      evidenceIds: evidenceIds(callerFacing),
    });
  }
  if (directIntentClasses.has(classification?.intentClass) && callerFacing.length === 1) {
    const source = callerFacing[0];
    const answer = directText(source);
    const validation = validateFinalKnowledgeResponse({
      input, answer, selectedEvidenceIds: [source.id], evidence,
    });
    if (validation.valid) return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.DIRECT, {
      reason: 'approved_authoritative_direct_response',
      confidence: classification.confidence,
      evidenceIds: validation.evidenceIds,
      response: { text: validation.answer, recordId: source.recordId, recordType: source.recordType },
    });
    return clarification('ambiguity', validation.reason, null, [source]);
  }
  return clarification(callerFacing.length ? 'ambiguity' : 'no_evidence',
    callerFacing.length ? 'single_authoritative_response_not_resolved' : 'weak_or_missing_evidence',
    callerFacing.length
      ? 'Please clarify which published answer you want.'
      : 'Please provide a little more detail so I can find the correct published information.',
    callerFacing);
}

export function finalizeGroundedLlmResponse({
  input, plan, answer, selectedEvidenceIds, authoritative,
} = {}) {
  if (plan?.type !== knowledgeEngineDecisionTypes.LLM) {
    throw new TypeError('Only an LLM plan may be finalized as a grounded LLM response');
  }
  const allowed = new Set(plan.evidenceIds ?? []);
  const selected = [...new Set(selectedEvidenceIds ?? [])];
  if (!selected.length || selected.some((id) => !allowed.has(id))) {
    return clarification('technical', 'llm_selected_unplanned_citation',
      'I could not safely validate that response against the selected published information.');
  }
  const validation = validateFinalKnowledgeResponse({
    input, answer, selectedEvidenceIds: selected,
    evidence: (authoritative?.evidence ?? []).filter((source) => allowed.has(source.id)),
  });
  if (!validation.valid) return clarification('technical', validation.reason,
    'I could not safely validate that response against the selected published information.');
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.DIRECT, {
    reason: 'validated_grounded_llm_response',
    evidenceIds: validation.evidenceIds,
    response: { text: validation.answer, recordId: null, recordType: 'GROUNDED_LLM' },
  });
}

function toolResultEvidence(input, plan, result, configuredSuccessMessage) {
  const outputText = (() => {
    try { return JSON.stringify(result.output ?? {}); } catch { return ''; }
  })();
  return Object.freeze({
    id: `tool-result:${result.toolId ?? plan.tool.name}:${input.callId}`,
    recordId: String(result.toolId ?? plan.tool.name),
    recordType: 'TOOL_RESULT',
    tenantId: input.tenantId,
    agentId: input.agentId,
    callerFacing: true,
    content: cleanText(`${configuredSuccessMessage ?? ''} ${outputText}`, 8_000),
    authoritativeData: Object.freeze({ verified: true, success: true, output: result.output }),
  });
}

export async function executeAuthorizedToolWorkflow({
  input, plan, runtimeProfile, call,
} = {}, dependencies = {}) {
  if (plan?.type !== knowledgeEngineDecisionTypes.TOOL
    || plan?.toolWorkflow?.status !== 'READY_TO_EXECUTE') {
    throw new TypeError('Only a confirmed, complete TOOL plan may execute');
  }
  const executor = dependencies.executor ?? executeAgentTool;
  const result = await executor(runtimeProfile, call, {
    name: plan.tool.name,
    arguments: plan.tool.input,
    authorizationRecordId: plan.tool.authorizationEvidenceId,
  }, {
    ...(dependencies.executorDependencies ?? {}),
    requireWorkflowAuthorization: true,
    workflowAuthorization: {
      recordId: plan.tool.authorizationEvidenceId,
      toolName: plan.tool.name,
    },
  });
  if (result?.verified !== true || result?.success !== true) return Object.freeze({
    result,
    decision: clarification('technical', 'tool_success_not_verified',
      'I could not verify that the requested action completed. I have not confirmed success.'),
  });
  const assigned = (runtimeProfile?.tools ?? []).find((tool) => (
    toolIdentifiers(tool).has(toolIdentity(plan.tool.name))
  ));
  const schema = configuredToolSchema(assigned);
  const configuredSuccess = cleanText(schema['x-success-message'], 800);
  const output = object(result.output);
  const answer = cleanText(output.callerMessage ?? output.message ?? configuredSuccess, 1_200)
    || 'The requested action was completed successfully.';
  const source = toolResultEvidence(input, plan, result, configuredSuccess);
  const validation = validateFinalKnowledgeResponse({
    input, answer, selectedEvidenceIds: [source.id], evidence: [source],
  });
  if (!validation.valid) return Object.freeze({
    result,
    decision: clarification('technical', validation.reason,
      'The action completed, but I could not safely validate the response details.'),
  });
  return Object.freeze({
    result,
    evidence: source,
    decision: createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.DIRECT, {
      reason: 'verified_tool_success', evidenceIds: validation.evidenceIds,
      response: {
        text: validation.answer, recordId: source.recordId, recordType: source.recordType,
      },
    }),
  });
}
