import {
  createKnowledgeEngineDecision,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from './engine-contract.js';
import { knowledgeQueryClasses } from './query-classifier.js';
import { validateGroundedClaims } from '../voice/interaction/grounded-claim-validator.js';
import { validateToolArguments } from '../voice/tools/tool-security.js';
import { executeAgentTool } from '../voice/tools/tool-executor.service.js';

export const SAFE_RESPONSE_TOOL_RUNTIME_VERSION = 1;

const deterministicIntentClasses = new Set([
  knowledgeQueryClasses.CALL_CONTROL,
  knowledgeQueryClasses.SAFETY_EMERGENCY,
]);

const approvedDirectRecordTypes = new Set([
  'FAQ',
  'CONVERSATION_NODE',
  'CATALOG_CATEGORY',
  'CATALOG_ITEM',
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

function joinSpokenFragments(values) {
  const parts = values.map((value) => cleanText(value)).filter(Boolean);
  return cleanText(parts.map((part, index) => (
    index < parts.length - 1 && !/[.!?…]$/u.test(part) ? `${part}.` : part
  )).join(' '));
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
  return toolIdentity(configuration.toolIdentifier ?? configuration.actionKey
    ?? configuration.tool ?? configuration.action);
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

function targetedAmbiguityPrompt(ambiguity, resolution, input) {
  const authoritativeCandidates = ambiguity?.candidates ?? [];
  const candidates = (authoritativeCandidates.length
    ? authoritativeCandidates
    : [resolution?.candidate, ...(resolution?.alternatives ?? [])]
  ).filter((candidate) => candidate?.recordType !== 'WORKFLOW_RULE'
    && candidate?.entityType !== 'WORKFLOW');
  const labels = candidates.map((candidate) => (
    cleanText(candidate?.name ?? candidate?.label, 120)
      || cleanText(candidate?.matchedPhrase, 120)
      || cleanText(candidate?.itemKey ?? candidate?.categoryKey, 120)
  )).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).slice(0, 3);
  if (!labels.length) return 'Please clarify which published option you mean.';
  const tamil = String(input?.language ?? '').toLocaleLowerCase().startsWith('ta')
    || /\p{Script=Tamil}/u.test(String(input?.utterance ?? ''));
  if (labels.length === 1) {
    return tamil ? `${labels[0]}-ஐ சொல்றீங்களா?` : `Did you mean ${labels[0]}?`;
  }
  return tamil
    ? `இதில் எதை சொல்றீங்க: ${labels.join(', ')}?`
    : `Please confirm which one you mean: ${labels.join(', ')}.`;
}

function renderAttributeValue(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'number', 'boolean'].includes(typeof value)) return cleanText(value, 300);
  if (Array.isArray(value)) {
    const values = value.map(renderAttributeValue).filter(Boolean);
    return values.length ? values.join(', ') : null;
  }
  return null;
}

function catalogFacts(source) {
  const data = object(source?.authoritativeData);
  return Object.freeze({
    itemKey: data.itemKey ?? null,
    name: cleanText(data.name, 200),
    category: cleanText(data.category, 200),
    categoryKey: data.categoryKey ?? null,
    categoryDescription: cleanText(data.categoryDescription, 800),
    description: cleanText(data.description, 800),
    price: data.price ?? null,
    currency: cleanText(data.currency, 20),
    attributes: Object.freeze((Array.isArray(data.attributes) ? data.attributes : []).flatMap((attribute) => {
      const value = renderAttributeValue(attribute?.value);
      const name = cleanText(attribute?.name ?? attribute?.key, 160);
      return name && value ? [Object.freeze({ name, value })] : [];
    })),
  });
}

function renderCatalogItem(source) {
  const facts = catalogFacts(source);
  const price = facts.price === null || facts.price === undefined ? null
    : `${facts.price}${facts.currency ? ` ${facts.currency}` : ''}`;
  const attributes = facts.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`);
  return joinSpokenFragments([
    facts.name,
    facts.description,
    price ? `Price: ${price}.` : null,
    attributes.length ? attributes.join('. ') : null,
  ]);
}

function renderCatalogCategory(source) {
  const data = object(source?.authoritativeData);
  const names = [...new Set((data.children ?? [])
    .map((child) => cleanText(child?.name, 200)).filter(Boolean))];
  return joinSpokenFragments([
    cleanText(data.category, 200),
    cleanText(data.categoryDescription, 800),
    names.length ? `Available options: ${names.join(', ')}.` : null,
  ]);
}

function directText(source) {
  const data = object(source?.authoritativeData);
  if (source?.recordType === 'FAQ') return cleanText(data.answer ?? source.content);
  if (source?.recordType === 'CONVERSATION_NODE') return cleanText(data.content ?? source.content);
  if (source?.recordType === 'WORKFLOW_RULE') return cleanText(data.responseTemplate ?? source.content);
  if (source?.recordType === 'CATALOG_ITEM') return renderCatalogItem(source);
  if (source?.recordType === 'CATALOG_CATEGORY') return renderCatalogCategory(source);
  return cleanText(source?.content);
}

function categoryText(resolution, evidence) {
  const candidate = resolution?.candidate;
  if (candidate?.entityType !== 'CATEGORY') return null;
  const categoryKey = normalizedId(candidate.categoryKey);
  const category = evidence.find((source) => source.recordType === 'CATALOG_CATEGORY'
    && normalizedId(source.authoritativeData?.categoryKey) === categoryKey);
  if (category) return { text: renderCatalogCategory(category), evidence: [category] };
  const items = evidence.filter((source) => source.recordType === 'CATALOG_ITEM'
    && normalizedId(source.authoritativeData?.categoryKey) === categoryKey);
  if (!items.length) return null;
  const facts = items.map(catalogFacts);
  const names = [...new Set(facts.map((item) => item.name).filter(Boolean))];
  const categories = [...new Set(facts.map((item) => item.category).filter(Boolean))];
  const descriptions = [...new Set(facts.map((item) => item.categoryDescription).filter(Boolean))];
  // Category speech is derived only from the hydrated PostgreSQL rows. Index
  // metadata selects the category but is never allowed to introduce a fact.
  if (categories.length > 1 || descriptions.length > 1) return null;
  const label = categories[0] ?? cleanText(candidate.label, 200);
  const description = descriptions[0] ?? null;
  const text = joinSpokenFragments([
    label,
    description,
    names.length ? `Available options: ${names.join(', ')}.` : null,
  ]);
  return {
    text,
    evidence: items,
  };
}

function searchableEvidenceText(source) {
  if (source?.recordType === 'CATALOG_CATEGORY') {
    const data = object(source.authoritativeData);
    return cleanText([
      data.category, data.categoryDescription,
      ...(data.children ?? []).flatMap((child) => [
        child?.name, child?.description, child?.price, child?.currency,
      ]),
    ].filter((value) => value !== null && value !== undefined).join(' '), 32_000)
      .toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  }
  if (source?.recordType === 'CATALOG_ITEM') {
    const facts = catalogFacts(source);
    return cleanText([
      facts.name, facts.category, facts.categoryDescription, facts.description,
      facts.price, facts.currency,
      ...facts.attributes.flatMap((attribute) => [attribute.name, attribute.value]),
    ].filter((value) => value !== null && value !== undefined).join(' '), 32_000)
      .toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  }
  let structured = '';
  try { structured = JSON.stringify(source?.authoritativeData ?? {}); } catch { structured = ''; }
  return cleanText(`${source?.content ?? ''} ${structured}`, 32_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function validationEvidence(source) {
  if (source?.recordType === 'CATALOG_CATEGORY') return Object.freeze({
    ...source,
    content: renderCatalogCategory(source),
  });
  if (source?.recordType !== 'CATALOG_ITEM') return source;
  const facts = catalogFacts(source);
  return Object.freeze({
    ...source,
    content: renderCatalogItem(source),
    authoritativeData: facts,
  });
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
  const alignedEvidence = selected.map(validationEvidence);
  const claims = validateGroundedClaims(text, alignedEvidence, {
    finalizedUtterance: input?.utterance,
    knownEntities: knownEntities.length ? knownEntities : input?.memory?.knownEntities,
  });
  if (!claims.valid) return claims;
  const unsupportedSentence = unsupportedClaimSentence(text, alignedEvidence);
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

function explicitComparisonEvidence(resolution, evidence) {
  const explicitIds = new Set((resolution?.namespaceCandidates?.CATALOG
    ?? resolution?.routingCandidates ?? []).filter((candidate) => (
    candidate.explicit === true && ['ITEM', 'CATEGORY'].includes(candidate.entityType)
  )).map((candidate) => candidate.recordId).map(normalizedId));
  if (!explicitIds.size) return [];
  return evidence.filter((source) => ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(source.recordType)
    && explicitIds.has(normalizedId(source.recordId)));
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

function assignedWorkflowTool(evidence, runtimeProfile, input) {
  const active = object(input?.memory?.activeTool);
  const activeAuthorization = normalizedId(active.authorizationRecordId
    ?? active.authorizationEvidenceId ?? active.workflowRecordId);
  const activeToolName = toolIdentity(active.name);
  const workflows = evidence.filter((source) => (
    source.recordType === 'WORKFLOW_RULE'
    && source.hydrationValidated === true
    && String(source.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && workflowToolIdentifier(source)
    && (!activeAuthorization || normalizedId(source.recordId) === activeAuthorization)
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
    for (const tool of runtimeProfile?.tools ?? []) {
      if (activeToolName && !toolIdentifiers(tool).has(activeToolName)) continue;
      if (toolIdentifiers(tool).has(identifier)) matches.push({
        workflow, tool, requiresCatalogItem, catalogMatches,
        catalogItem: requiresCatalogItem && catalogMatches.length === 1 ? catalogMatches[0] : null,
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
  const authorized = assignedWorkflowTool(evidence, runtimeProfile, input);
  if (!authorized) return clarification(
    'no_evidence', 'authorized_assigned_tool_unavailable',
    'I cannot safely start that action because no single assigned tool is authorized by the published workflow.',
    evidence.filter((source) => source.recordType === 'WORKFLOW_RULE'),
  );
  const { workflow, tool, requiresCatalogItem, catalogMatches, catalogItem } = authorized;
  if (requiresCatalogItem && catalogMatches.length !== 1) {
    const names = [...new Set(catalogMatches.map((source) => (
      cleanText(source.authoritativeData?.name, 120)
    )).filter(Boolean))].slice(0, 3);
    return clarification('ambiguity', 'selectable_catalog_item_required',
      names.length > 1
        ? `Please confirm which published option you want: ${names.join(', ')}.`
        : 'Please select one published option before I start that action.',
      [workflow, ...catalogMatches]);
  }
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
  if (isComparison && authoritative.comparisonCoverage?.complete !== true) {
    return clarification('no_evidence', 'comparison_evidence_incomplete',
      null, evidence);
  }
  if (classification?.intentClass === knowledgeQueryClasses.ACTION_TOOL_REQUEST) {
    const authorizedPlan = planAuthorizedToolWorkflow({
      input, authoritative, runtimeProfile, confirmation,
    });
    return authorizedPlan;
  }
  if (authoritative.ambiguity?.detected && !isComparison) {
    return clarification('ambiguity', 'ambiguous_authoritative_entity',
      targetedAmbiguityPrompt(authoritative.ambiguity, resolution, input), evidence);
  }
  const allCallerFacing = evidence.filter((source) => source.callerFacing === true);
  const resolvedIds = new Set([
    resolution?.candidate?.recordId,
    ...(resolution?.candidate?.evidenceRecordIds ?? []),
  ].map(normalizedId).filter(Boolean));
  const resolvedCallerFacing = resolvedIds.size
    ? allCallerFacing.filter((source) => resolvedIds.has(normalizedId(source.recordId)))
    : [];
  // Once a route/entity is resolved, additional BM25 or semantic records must
  // not turn that answer into a false clarification. They remain available to
  // grounded reasoning, but direct rendering uses only the selected record(s).
  const multiEvidenceIntent = [
    knowledgeQueryClasses.CATEGORY_OVERVIEW,
    knowledgeQueryClasses.COMPARISON_COMPLEX,
    knowledgeQueryClasses.UNKNOWN,
  ].includes(classification?.intentClass);
  const callerFacing = multiEvidenceIntent
    ? allCallerFacing
    : (resolvedCallerFacing.length ? resolvedCallerFacing : allCallerFacing);
  const resolvedCategoryRequest = resolution?.candidate?.entityType === 'CATEGORY'
    && (resolution?.candidate?.explicit === true || resolution?.contextDependent === true);
  if (classification?.intentClass === knowledgeQueryClasses.CATEGORY_OVERVIEW
    || resolvedCategoryRequest) {
    const resolvedCategoryKey = normalizedId(resolution?.candidate?.categoryKey);
    const categoryEvidence = resolvedCategoryKey ? allCallerFacing.filter((source) => (
      ['CATALOG_CATEGORY', 'CATALOG_ITEM'].includes(source.recordType)
      && normalizedId(source.authoritativeData?.categoryKey) === resolvedCategoryKey
    )) : [];
    const rendered = categoryText(resolution, categoryEvidence.length
      ? categoryEvidence : (resolvedCallerFacing.length ? resolvedCallerFacing : callerFacing));
    if (rendered) {
      const selectedEvidenceIds = evidenceIds(rendered.evidence);
      const validation = validateFinalKnowledgeResponse({
        input, answer: rendered.text, selectedEvidenceIds, evidence,
      });
      if (validation.valid) {
        const categorySource = rendered.evidence.find((source) => (
          source.recordType === 'CATALOG_CATEGORY'
        )) ?? rendered.evidence[0];
        return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
          reason: 'approved_deterministic_category_response',
          confidence: classification.confidence,
          evidenceIds: validation.evidenceIds,
          mode: knowledgeEngineResponseModes.DETERMINISTIC,
          response: {
            text: validation.answer,
            recordId: categorySource.recordId,
            recordType: categorySource.recordType,
          },
        });
      }
      return clarification('ambiguity', validation.reason, null, rendered.evidence);
    }
  }
  if (classification?.intentClass === knowledgeQueryClasses.COMPARISON_COMPLEX) {
    const compared = explicitComparisonEvidence(resolution, callerFacing);
    const requestedComparisonCount = authoritative.comparisonCoverage?.requestedRecordKeys?.length
      ?? authoritative.comparisonCoverage?.requestedRecordIds?.length
      ?? 0;
    if (requestedComparisonCount < 2 || compared.length !== requestedComparisonCount) return clarification(
      'no_evidence', 'grounded_reasoning_evidence_unavailable',
      'Please clarify the options you want compared.', evidence,
    );
    return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'grounded_multi_evidence_reasoning_required',
      confidence: classification.confidence,
      evidenceIds: evidenceIds(compared),
      mode: knowledgeEngineResponseModes.GROUNDED_LLM,
    });
  }
  if (classification?.intentClass === knowledgeQueryClasses.UNKNOWN && callerFacing.length) {
    return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'grounded_published_reasoning_required',
      confidence: classification.confidence,
      evidenceIds: evidenceIds(callerFacing.slice(0, 3)),
      mode: knowledgeEngineResponseModes.GROUNDED_LLM,
    });
  }
  const approvedResolvedRoute = resolvedCallerFacing.length === 1
    && resolution?.candidate?.explicit === true
    && resolution?.confidence === 'HIGH'
    && resolution?.action === 'CONTINUE'
    && approvedDirectRecordTypes.has(String(resolvedCallerFacing[0]?.recordType).toUpperCase());
  if ((deterministicIntentClasses.has(classification?.intentClass) && callerFacing.length === 1)
    || approvedResolvedRoute) {
    const source = approvedResolvedRoute ? resolvedCallerFacing[0] : callerFacing[0];
    const answer = directText(source);
    const validation = validateFinalKnowledgeResponse({
      input, answer, selectedEvidenceIds: [source.id], evidence,
    });
    if (validation.valid) return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'approved_deterministic_priority_response',
      confidence: classification.confidence,
      evidenceIds: validation.evidenceIds,
      mode: knowledgeEngineResponseModes.DETERMINISTIC,
      response: { text: validation.answer, recordId: source.recordId, recordType: source.recordType },
    });
    return clarification('ambiguity', validation.reason, null, [source]);
  }
  if (callerFacing.length > 1) {
    return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'grounded_multi_evidence_reasoning_required',
      confidence: classification.confidence,
      evidenceIds: evidenceIds(callerFacing.slice(0, 5)),
      mode: knowledgeEngineResponseModes.GROUNDED_LLM,
    });
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
  if (plan?.type !== knowledgeEngineDecisionTypes.RESPONSE
    || plan?.mode !== knowledgeEngineResponseModes.GROUNDED_LLM) {
    throw new TypeError('Only a grounded RESPONSE plan may be finalized');
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
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
    reason: 'validated_grounded_llm_response',
    evidenceIds: validation.evidenceIds,
    mode: knowledgeEngineResponseModes.GROUNDED_LLM,
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

export function finalizeVerifiedToolResults({
  input, results, runtimeProfile,
} = {}) {
  const values = Array.isArray(results) ? results : [];
  if (!values.length || values.some((result) => (
    result?.verified !== true || result?.success !== true
  ))) {
    return Object.freeze({
      evidence: Object.freeze([]),
      decision: clarification('technical', 'tool_success_not_verified',
        'I could not verify that the requested action completed. I have not confirmed success.'),
    });
  }
  const evidence = [];
  const responseParts = [];
  for (const result of values) {
    const assigned = (runtimeProfile?.tools ?? []).find((tool) => (
      toolIdentifiers(tool).has(toolIdentity(result.name))
    ));
    const schema = configuredToolSchema(assigned);
    const configuredSuccess = cleanText(schema['x-success-message'], 800);
    const output = object(result.output);
    const callerMessage = cleanText(output.callerMessage ?? output.message ?? configuredSuccess, 1_200);
    if (callerMessage) responseParts.push(callerMessage);
    evidence.push(toolResultEvidence(input, {
      tool: { name: result.name },
    }, result, configuredSuccess));
  }
  const answer = cleanText(responseParts.join(' '), 1_500)
    || 'The requested action was completed successfully.';
  const validation = validateFinalKnowledgeResponse({
    input,
    answer,
    selectedEvidenceIds: evidence.map((source) => source.id),
    evidence,
  });
  if (!validation.valid) {
    return Object.freeze({
      evidence: Object.freeze(evidence),
      decision: clarification('technical', validation.reason,
        'The action completed, but I could not safely validate the response details.'),
    });
  }
  return Object.freeze({
    evidence: Object.freeze(evidence),
    decision: createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'verified_tool_success',
      evidenceIds: validation.evidenceIds,
      mode: knowledgeEngineResponseModes.DETERMINISTIC,
      response: {
        text: validation.answer,
        recordId: evidence[0]?.recordId ?? null,
        recordType: 'TOOL_RESULT',
      },
    }),
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
  const finalized = finalizeVerifiedToolResults({
    input, results: [{ ...result, name: plan.tool.name }], runtimeProfile,
  });
  return Object.freeze({
    result,
    evidence: finalized.evidence[0] ?? null,
    decision: finalized.decision,
  });
}
