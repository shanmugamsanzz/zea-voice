import { AppError } from '../../middleware/errors.js';
import { speechBudgetInstruction } from './template-engine-speech-budget.js';
import { templateEngineDecisionJsonSchema } from './template-engine-decision-contract.js';
import { createMinimalTemplateEngineState } from './template-engine-state.js';
import { normalizeTemplateEngineSearchDecision } from './template-engine-search-request.js';
import {
  templateEnginePostSearchJsonSchema,
  templateEnginePostSearchJsonSchemaForEvidenceAliases,
  templateEnginePostSearchDecisionDiagnostics,
  validateTemplateEnginePostSearchDecision,
} from './template-engine-post-search-contract.js';
import {
  buildTemplateEngineRoutingPrompt,
  enforceTemplateEngineRuntimeInvariants,
} from './template-engine-routing-control.js';
import { validateTemplateEngineOutput } from './template-engine-output-validator.js';
import {
  sanitizeConversationGuidance,
} from './template-engine-conversation-guidance.js';

const maximumRecentPairs = 5;

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function cleanList(value, maximumItems = 50) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, 160)).filter(Boolean))].slice(0, maximumItems));
}

function authorizedSummaries(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const summaries = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = cleanText(entry.toolName ?? entry.name, 160);
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    const requiredFields = [...new Set((Array.isArray(entry.requiredFields)
      ? entry.requiredFields : entry.inputSchema?.required ?? [])
      .map((field) => cleanText(field, 160)).filter(Boolean))].slice(0, 50);
    summaries.push(Object.freeze({
      workflowRecordId: cleanText(entry.workflowRecordId ?? entry.recordId, 160) || null,
      toolName,
      description: cleanText(entry.description, 500) || null,
      requiredFields: Object.freeze(requiredFields),
    }));
    if (summaries.length >= 20) break;
  }
  return Object.freeze(summaries);
}

function completionOutput(completion) {
  if (completion && typeof completion === 'object') {
    return completion.outputParsed ?? completion.output_parsed ?? completion.parsed
      ?? completion.answer ?? completion.output ?? completion.text ?? completion;
  }
  return completion;
}

function decisionRetryMessages(messages, reason, phase) {
  return Object.freeze([
    ...(Array.isArray(messages) ? messages : []),
    Object.freeze({
      role: 'system',
      content: [
        `The previous ${phase} decision failed runtime validation: ${cleanText(reason, 160) || 'invalid_decision'}.`,
        'Re-evaluate the same finalized caller utterance using the tenant prompt, supplied published guidance and relevant recent conversation.',
        'Return exactly one decision branch and set every field belonging to other branches to null or empty as required by the supplied schema.',
        'Do not change, discard, summarize, or replace the caller utterance.',
        'Return only one complete JSON object with no Markdown or commentary.',
      ].join(' '),
    }),
  ]);
}

async function invokeValidatedDecision({
  invokeStructuredLlm, request, messages, validateCompletion, phase, onRetry,
  recoverInvalid,
}) {
  let completion = await invokeStructuredLlm(request(messages));
  let validated = validateCompletion(completion);
  let retryAttempted = false;
  let initialReason = null;
  let recoveryApplied = false;
  if (!validated.valid && typeof recoverInvalid === 'function') {
    const recovered = recoverInvalid(completion, validated);
    if (recovered?.valid) {
      validated = recovered;
      recoveryApplied = true;
    }
  }
  if (!validated.valid) {
    retryAttempted = true;
    initialReason = validated.reason;
    const retryMessages = decisionRetryMessages(messages, validated.reason, phase);
    onRetry?.(Object.freeze({
      phase,
      reason: validated.reason,
      originalMessageCount: messages.length,
      retryMessageCount: retryMessages.length,
    }));
    completion = await invokeStructuredLlm(request(retryMessages));
    validated = validateCompletion(completion);
    if (!validated.valid && typeof recoverInvalid === 'function') {
      const recovered = recoverInvalid(completion, validated);
      if (recovered?.valid) {
        validated = recovered;
        recoveryApplied = true;
      }
    }
  }
  return Object.freeze({
    completion, validated, retryAttempted, initialReason, recoveryApplied,
  });
}

function redirectFactualResponseToSearch(completion, validation, orchestratorInput) {
  if (validation?.reason !== 'factual_response_requires_evidence') return validation;
  const raw = completionOutput(completion);
  let supplied = raw;
  if (typeof supplied === 'string') {
    try { supplied = JSON.parse(supplied); } catch { supplied = null; }
  }
  const fallbackSearch = {
    query: orchestratorInput.latestUtterance,
    requestedFact: orchestratorInput.latestUtterance,
    contextualReference: null,
    preferredRecordIds: [],
  };
  const suppliedSearch = supplied?.search && typeof supplied.search === 'object'
    ? supplied.search : fallbackSearch;
  const redirected = (search) => ({
    decision: 'SEARCH', response: '', clarification: null,
    search,
    tool: null, nextQuestion: null,
    stateUpdate: supplied?.stateUpdate ?? null,
  });
  const recovered = enforceTemplateEngineRuntimeInvariants(redirected(suppliedSearch), {
    tenantBoundaryVerified: true,
  });
  return recovered.valid || suppliedSearch === fallbackSearch
    ? recovered
    : enforceTemplateEngineRuntimeInvariants(redirected(fallbackSearch), {
      tenantBoundaryVerified: true,
    });
}

function outputValidationInput(decision, orchestratorInput, dependencies, additions = {}) {
  return Object.freeze({
    decision,
    state: orchestratorInput.state,
    currentUtterance: orchestratorInput.latestUtterance,
    factualClaimsPresent: dependencies.factualClaimsPresent === true,
    nonFactualResponseAllowed: dependencies.nonFactualResponseAllowed === true,
    selectedEvidence: dependencies.verifiedEvidence ?? [],
    publishedEntities: dependencies.publishedEntities ?? [],
    claimedNames: dependencies.claimedNames ?? [],
    callerProvidedValues: dependencies.callerProvidedValues ?? {},
    semanticClaimValidation: dependencies.semanticClaimValidation ?? null,
    allowMultipleEntities: dependencies.allowMultipleEntities === true,
    ambiguity: dependencies.ambiguity ?? null,
    retryCount: Number.isInteger(dependencies.validationRetryCount)
      ? dependencies.validationRetryCount : 0,
    publishedWorkflows: dependencies.publishedWorkflows ?? [],
    assignedTools: dependencies.assignedTools ?? [],
    informationFields: dependencies.informationFields ?? [],
    scope: dependencies.scope ?? {},
    confirmation: dependencies.confirmation ?? null,
    toolExecutionRequested: dependencies.toolExecutionRequested === true,
    requiredEvidenceRecordIds: dependencies.requiredEvidenceRecordIds ?? [],
    requestedFactAvailable: dependencies.requestedFactAvailable === true,
    maximumSpeechCharacters: dependencies.maximumSpeechCharacters,
    ...additions,
  });
}

export function createTemplateEngineOrchestratorInput({
  mainPrompt,
  latestUtterance,
  conversationHistory = [],
  recentPairLimit = maximumRecentPairs,
  pendingClarification = null,
  activeWorkflowState = null,
  citedRecordReferences = [],
  lastReferencedRecordIds = null,
  comparisonRecordIds = [],
  activeWorkflowId = null,
  collectedToolFields = null,
  confirmationStatus = null,
  authorizedWorkflowTools = [],
  conversationGuidance = null,
} = {}) {
  const utterance = cleanText(latestUtterance);
  if (!utterance) throw new TypeError('A finalized caller utterance is required');
  const prompt = cleanText(mainPrompt, 24_000);
  if (!prompt) throw new TypeError('A tenant main prompt is required');
  const minimalState = createMinimalTemplateEngineState({
    conversationHistory,
    recentPairLimit,
    lastReferencedRecordIds: lastReferencedRecordIds ?? citedRecordReferences,
    comparisonRecordIds,
    pendingClarification,
    activeWorkflowId,
    activeWorkflowState,
    collectedToolFields,
    confirmationStatus,
  });
  return Object.freeze({
    mainPrompt: prompt,
    latestUtterance: utterance,
    state: minimalState,
    authorizedWorkflowTools: authorizedSummaries(authorizedWorkflowTools),
    conversationGuidance: sanitizeConversationGuidance(conversationGuidance),
  });
}

export async function routeTemplateEngineUtterance(input = {}, dependencies = {}) {
  const orchestratorInput = createTemplateEngineOrchestratorInput(input);
  const invokeStructuredLlm = dependencies.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('The template-engine Orchestrator requires one structured LLM invoker');
  }

  const turnInput = Object.freeze({
    latestUtterance: orchestratorInput.latestUtterance,
    state: orchestratorInput.state,
    authorizedWorkflowTools: orchestratorInput.authorizedWorkflowTools,
    conversationGuidance: orchestratorInput.conversationGuidance,
  });
  const routingPrompt = buildTemplateEngineRoutingPrompt({
    mainPrompt: orchestratorInput.mainPrompt,
  });
  const systemPrompt = [
    routingPrompt,
    '<orchestrator_turn_input>',
    JSON.stringify(turnInput),
    '</orchestrator_turn_input>',
  ].join('\n');
  const baseMessages = Object.freeze([
    Object.freeze({ role: 'system', content: systemPrompt }),
    Object.freeze({ role: 'user', content: orchestratorInput.latestUtterance }),
  ]);
  const request = (messages) => Object.freeze({
    messages: Object.freeze(messages),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'template_engine_orchestrator_decision',
      strict: true,
      schema: templateEngineDecisionJsonSchema,
    }),
  });

  const authorizedNames = orchestratorInput.authorizedWorkflowTools
    .map((summary) => summary.toolName);
  const validateCompletion = (completion) => enforceTemplateEngineRuntimeInvariants(
    completionOutput(completion), {
    tenantBoundaryVerified: dependencies.tenantBoundaryVerified === true,
    factualClaimsPresent: dependencies.factualClaimsPresent === true,
    verifiedEvidence: dependencies.verifiedEvidence ?? [],
    workflowAuthorizedTools: authorizedNames,
    assignedToolSchemas: dependencies.assignedToolSchemas ?? authorizedNames,
    toolSuccessClaimed: dependencies.toolSuccessClaimed === true,
    verifiedToolResult: dependencies.verifiedToolResult ?? null,
    },
  );
  const invocation = await invokeValidatedDecision({
    invokeStructuredLlm,
    request,
    messages: baseMessages,
    validateCompletion,
    phase: 'initial_routing',
    onRetry: dependencies.onDecisionRetry,
    recoverInvalid: (completion, validation) => redirectFactualResponseToSearch(
      completion, validation, orchestratorInput,
    ),
  });
  const { validated } = invocation;
  const decisionRepairAttempted = invocation.retryAttempted || invocation.recoveryApplied;
  if (!validated.valid) {
    throw new AppError(502, 'The template-engine Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', {
        reason: validated.reason,
        attempts: 2,
        initialReason: invocation.initialReason,
      });
  }
  const routingReviewAttempted = false;
  const contextualDecision = normalizeTemplateEngineSearchDecision(
    validated.value, orchestratorInput.state,
    { latestUtterance: orchestratorInput.latestUtterance },
  );
  if (!contextualDecision.valid) {
    throw new AppError(502, 'The template-engine Orchestrator returned an invalid search decision',
      'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', {
        reason: contextualDecision.reason,
      });
  }
  const outputValidation = validateTemplateEngineOutput(outputValidationInput(
    contextualDecision.value, orchestratorInput, dependencies,
  ));
  if (!outputValidation.valid) {
    throw new AppError(502, 'The template-engine output failed delivery validation',
      'TEMPLATE_ENGINE_OUTPUT_INVALID', { reason: outputValidation.reason });
  }
  return Object.freeze({
    decision: contextualDecision.value,
    input: turnInput,
    verifiedEvidenceIds: validated.verifiedEvidenceIds,
    outputValidation,
    routingReviewAttempted,
    decisionRepairAttempted,
  });
}

function sameScopeValue(value, expected) {
  return cleanText(value, 160).toLocaleLowerCase()
    === cleanText(expected, 160).toLocaleLowerCase();
}

function verifiedEvidenceForPostSearch(values, scope = {}) {
  const scopeTenantId = cleanText(scope.tenantId, 160);
  const scopeAgentId = cleanText(scope.agentId, 160);
  const publications = new Set((Array.isArray(scope.publications) ? scope.publications : [])
    .map((publication) => (
      `${cleanText(publication?.knowledgeBaseId, 160).toLocaleLowerCase()}`
      + `:${Number(publication?.publicationRevision)}`
    )));
  if (!scopeTenantId || !scopeAgentId || !publications.size) {
    throw new TypeError('Post-search evidence requires tenant, agent and publication scope');
  }
  const evidence = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const evidenceId = cleanText(value?.evidenceId ?? value?.sourceId ?? value?.id, 160);
    const recordId = cleanText(value?.recordId, 160);
    const recordType = cleanText(value?.recordType, 80).toLocaleUpperCase();
    const tenantId = cleanText(value?.tenantId, 160);
    const agentId = cleanText(value?.agentId, 160);
    const knowledgeBaseId = cleanText(value?.knowledgeBaseId, 160);
    const publicationRevision = Number(value?.publicationRevision);
    const content = cleanText(value?.content, 8_000);
    const publicationKey = `${knowledgeBaseId.toLocaleLowerCase()}:${publicationRevision}`;
    if (value?.verified !== true || value?.callerFacing === false) continue;
    if (!evidenceId || !recordId || !recordType || !tenantId || !knowledgeBaseId
      || !Number.isInteger(publicationRevision) || !content
      || !sameScopeValue(tenantId, scopeTenantId)
      || (agentId && !sameScopeValue(agentId, scopeAgentId))
      || !publications.has(publicationKey)) {
      throw new AppError(500, 'Verified post-search evidence is outside its runtime scope',
        'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_VIOLATION', {
          evidenceId: evidenceId || null, recordId: recordId || null,
        });
    }
    if (seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    evidence.push(Object.freeze({
      verified: true, callerFacing: true,
      evidenceId, recordId, recordType, tenantId,
      agentId: agentId || scopeAgentId,
      knowledgeBaseId, publicationRevision, content,
      canonicalName: cleanText(value?.canonicalName, 300) || null,
      aliases: cleanList(value?.aliases, 50),
      relationships: Object.freeze([...(Array.isArray(value?.relationships)
        ? value.relationships : [])]),
      authoritativeData: value?.authoritativeData
        && typeof value.authoritativeData === 'object'
        && !Array.isArray(value.authoritativeData)
        ? Object.freeze({ ...value.authoritativeData }) : Object.freeze({}),
      requestedFact: cleanText(value?.requestedFact, 500) || null,
      publishedAttributePaths: Object.freeze(cleanList(
        value?.publishedAttributePaths, 120,
      )),
    }));
    if (evidence.length >= 20) break;
  }
  return Object.freeze(evidence);
}

function aliasPostSearchEvidence(evidence) {
  const aliasToEvidenceId = new Map();
  const aliasedEvidence = evidence.map((entry, index) => {
    const evidenceId = `E${index + 1}`;
    aliasToEvidenceId.set(evidenceId, entry.evidenceId);
    return Object.freeze({
      ...entry,
      // Provider-facing citations are intentionally short and turn-scoped.
      // The real identifier never has to be reproduced by the LLM.
      evidenceId,
    });
  });
  return Object.freeze({
    evidence: Object.freeze(aliasedEvidence),
    aliases: Object.freeze([...aliasToEvidenceId.keys()]),
    aliasToEvidenceId,
  });
}

function recordId(value) {
  return cleanText(value, 160).toLocaleLowerCase();
}

function evidenceForRequestedEntities(evidence, requestedRecordIds = []) {
  const required = new Set(cleanList(requestedRecordIds, 100).map(recordId).filter(Boolean));
  if (!required.size) return evidence;
  return Object.freeze(evidence.filter((source) => required.has(recordId(source?.recordId))));
}

function candidateIdentity(value) {
  return cleanText(value, 300).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function evidenceProvidesRequestedFact(evidence, requestedFact) {
  const normalizedFact = candidateIdentity(requestedFact);
  if (!normalizedFact) return false;
  const wanted = new Set(normalizedFact.split(/\s+/u).filter(Boolean));
  return evidence.some((source) => {
    const searchable = candidateIdentity([
      ...(source?.publishedAttributePaths ?? []),
      source?.content,
      JSON.stringify(source?.authoritativeData ?? {}),
    ].join(' '));
    const available = new Set(searchable.split(/\s+/u).filter(Boolean));
    let matches = 0;
    for (const token of wanted) if (available.has(token)) matches += 1;
    return matches > 0 && matches / wanted.size >= 0.5;
  });
}

function evidenceSupportingRequestedFact(evidence, requestedFact) {
  const normalizedFact = candidateIdentity(requestedFact);
  if (!normalizedFact) return Object.freeze([]);
  const wanted = new Set(normalizedFact.split(/\s+/u).filter(Boolean));
  return Object.freeze(evidence.filter((source) => {
    const searchable = candidateIdentity([
      ...(source?.publishedAttributePaths ?? []),
      source?.content,
      JSON.stringify(source?.authoritativeData ?? {}),
    ].join(' '));
    const available = new Set(searchable.split(/\s+/u).filter(Boolean));
    let matches = 0;
    for (const token of wanted) if (available.has(token)) matches += 1;
    return matches > 0 && matches / wanted.size >= 0.5;
  }));
}

function extractiveGroundedRecovery(evidence, requestedFact) {
  const supporting = evidenceSupportingRequestedFact(evidence, requestedFact);
  if (!supporting.length) return null;
  const speechParts = [...new Set(supporting.map((source) => cleanText(
    source?.authoritativeData?.callerFacingAnswer
      ?? source?.authoritativeData?.answer
      ?? source?.content,
    4_000,
  )).filter(Boolean))];
  const response = cleanText(speechParts.join(' '), 4_000);
  if (!response) return null;
  return Object.freeze({
    decision: 'RESPONSE', response, clarification: null,
    evidenceIds: Object.freeze(supporting.map((source) => source.evidenceId)),
    nextQuestion: null, stateUpdate: null,
  });
}

function evidenceCandidateNames(source) {
  return cleanList([source?.canonicalName, ...(source?.aliases ?? [])], 60)
    .map(candidateIdentity).filter(Boolean);
}

function verifiedClarificationAmbiguity(decision, evidence, searchInterpretation, supplied) {
  const preferred = new Set((searchInterpretation?.preferredRecordIds ?? [])
    .map(recordId).filter(Boolean));
  const resolvedPreferred = new Set(evidence.filter((source) => source.verified === true)
    .map((source) => recordId(source?.recordId)).filter((id) => preferred.has(id)));
  if (preferred.size > 0 && resolvedPreferred.size === preferred.size) {
    return Object.freeze({
      required: false, kind: 'resolved_context', candidates: Object.freeze([]),
    });
  }
  if (decision?.decision !== 'CLARIFY') return supplied ?? null;

  if (supplied?.required === true && supplied?.kind === 'unresolved_published_entity') {
    return Object.freeze({
      required: true, kind: supplied.kind, candidates: Object.freeze([]),
    });
  }

  const suppliedCandidates = new Set((supplied?.candidates ?? [])
    .map(candidateIdentity).filter(Boolean));
  const proposed = cleanList(decision.clarification?.candidates, 10);
  const resolved = [];
  const resolvedRecordIds = new Set();
  for (const candidate of proposed) {
    const normalized = candidateIdentity(candidate);
    if (!normalized || (suppliedCandidates.size && !suppliedCandidates.has(normalized))) continue;
    const matches = evidence.filter((source) => evidenceCandidateNames(source).includes(normalized));
    if (matches.length !== 1) continue;
    const matchedRecordId = recordId(matches[0].recordId);
    if (!matchedRecordId || resolvedRecordIds.has(matchedRecordId)) continue;
    resolvedRecordIds.add(matchedRecordId);
    resolved.push(candidate);
  }
  const confirmation = supplied?.kind === 'published_entity_confirmation'
    && resolvedRecordIds.size === 1;
  const genuine = resolvedRecordIds.size >= 2 || confirmation;
  return Object.freeze({
    required: genuine,
    kind: genuine ? cleanText(supplied?.kind, 80) || 'verified_candidates' : 'not_ambiguous',
    candidates: Object.freeze(genuine ? resolved : []),
  });
}

function restorePostSearchEvidenceIds(decision, aliasToEvidenceId) {
  const restored = decision.evidenceIds.map((alias) => aliasToEvidenceId.get(alias));
  if (restored.some((evidenceId) => !evidenceId)) {
    throw new AppError(500, 'A post-search citation alias could not be resolved',
      'TEMPLATE_ENGINE_EVIDENCE_ALIAS_INVALID');
  }
  return Object.freeze({
    ...decision,
    evidenceIds: Object.freeze(restored),
  });
}

function citationRepairRequired(reason, diagnostics, evidenceCount) {
  return evidenceCount > 0
    && diagnostics.decision === 'RESPONSE'
    && diagnostics.responsePresent === true
    && ['unknown_evidence_id', 'mixed_decision_payload', 'invalid_payload'].includes(reason);
}

function postSearchSchemaForDecision(schema, decision) {
  if (!decision) return schema;
  return Object.freeze({
    ...schema,
    properties: Object.freeze({
      ...schema.properties,
      decision: Object.freeze({ type: 'string', enum: Object.freeze([decision]) }),
    }),
  });
}

export async function respondToTemplateEngineSearch(input = {}, dependencies = {}) {
  if (dependencies.tenantBoundaryVerified !== true) {
    throw new AppError(500, 'The post-search tenant boundary is not verified',
      'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_UNVERIFIED');
  }
  const base = createTemplateEngineOrchestratorInput({
    mainPrompt: input.mainPrompt,
    latestUtterance: input.latestUtterance,
    conversationHistory: input.state?.recentCompleteTurns ?? [],
    lastReferencedRecordIds: input.state?.lastReferencedRecordIds ?? [],
    comparisonRecordIds: input.state?.comparisonRecordIds ?? [],
    pendingClarification: input.state?.pendingClarification ?? null,
    activeWorkflowId: input.state?.activeWorkflowId ?? null,
    collectedToolFields: input.state?.collectedToolFields ?? {},
    confirmationStatus: input.state?.confirmationStatus ?? null,
    authorizedWorkflowTools: [],
    conversationGuidance: input.conversationGuidance,
  });
  const search = normalizeTemplateEngineSearchDecision(input.searchDecision, base.state);
  if (!search.valid || search.value.decision !== 'SEARCH') {
    throw new TypeError('The post-search Orchestrator requires a valid SEARCH interpretation');
  }
  const requiredEntityRecordIds = cleanList(input.requestedEntityRecordIds, 100);
  const evidence = evidenceForRequestedEntities(
    verifiedEvidenceForPostSearch(input.verifiedEvidence, input.scope),
    requiredEntityRecordIds,
  );
  const requestedFactAvailable = evidenceProvidesRequestedFact(
    evidence, search.value.search.requestedFact,
  );
  dependencies = { ...dependencies, maximumSpeechCharacters: input.maximumSpeechCharacters,
    ambiguity: verifiedClarificationAmbiguity(
    { decision: 'RESPONSE' }, evidence,
    { ...search.value.search, preferredRecordIds: requiredEntityRecordIds.length
      ? requiredEntityRecordIds : search.value.search.preferredRecordIds },
    dependencies.ambiguity,
  ) };
  const citations = aliasPostSearchEvidence(evidence);
  const allowedEvidenceIds = citations.aliases;
  const responseSchema = templateEnginePostSearchJsonSchemaForEvidenceAliases(
    allowedEvidenceIds,
  );
  const invokeStructuredLlm = dependencies.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('The post-search Orchestrator requires one structured LLM invoker');
  }
  const turnInput = Object.freeze({
    latestUtterance: base.latestUtterance,
    state: base.state,
    searchInterpretation: search.value.search,
    requestedEntityRecordIds: requiredEntityRecordIds,
    verifiedEvidence: citations.evidence,
    conversationGuidance: base.conversationGuidance,
  });
  const systemPrompt = [
    buildTemplateEngineRoutingPrompt({
      mainPrompt: base.mainPrompt,
      outputSchema: templateEnginePostSearchJsonSchema,
      phase: 'post_search',
    }),
    'Runtime grounding rules: authoritativeData, content, and publishedAttributePaths contain the only published facts available for each record.',
    speechBudgetInstruction(input.maximumSpeechCharacters),
    'Answer the requestedFact only when it is explicitly supported by those supplied facts.',
    'A RESPONSE must directly answer searchInterpretation.requestedFact before adding any other supported information. A true answer about a different attribute is incomplete.',
    'An absent attribute means the published evidence does not provide that information. Absence never proves a negative value, non-existence, non-requirement, non-availability, or zero.',
    'For NO_MATCH, describe only that the requested information is not present in the supplied published evidence; do not assert that the underlying real-world attribute is false.',
    'CLARIFY speech must follow the supplied ambiguity object and must not introduce any unsupported factual claim.',
    'For multiple supplied published candidates, ask one question identifying those candidates. For one confirmation candidate, ask whether the caller meant it. For unresolved_published_entity with no candidates, ask one neutral clarification without inventing or naming an entity.',
    'When preferredRecordIds resolves one previously cited record, answer from that record; do not ask which record the caller means.',
    'When preferredRecordIds contains an intentional comparison set, compare those records; do not reinterpret the set as ambiguity.',
    '<orchestrator_turn_input>',
    JSON.stringify(turnInput),
    '</orchestrator_turn_input>',
  ].join('\n');
  const baseMessages = Object.freeze([
    Object.freeze({ role: 'system', content: systemPrompt }),
    Object.freeze({ role: 'user', content: base.latestUtterance }),
  ]);
  const request = (messages, requiredDecision = null) => Object.freeze({
    messages: Object.freeze(messages),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'template_engine_post_search_decision',
      strict: true,
      schema: postSearchSchemaForDecision(responseSchema, requiredDecision),
    }),
  });
  let completion = await invokeStructuredLlm(request(baseMessages));
  let output = completionOutput(completion);
  let validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
  const firstDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  let firstInvalidReason = null;
  let repairingCitation = false;
  let groundingRepairAttempted = false;
  let configuredFallbackApplied = false;
  let extractiveRecoveryApplied = false;
  if (!validated.valid) {
    firstInvalidReason = validated.reason;
    repairingCitation = citationRepairRequired(
      validated.reason, firstDiagnostics, evidence.length,
    );
    const repairInstruction = [
      `Your previous JSON object was rejected: ${validated.reason}.`,
      'Return one corrected JSON object matching the supplied schema.',
      'RESPONSE requires non-empty response, null clarification, and one or more supplied evidenceIds.',
      'RESPONSE may include one nullable nextQuestion generated in this same call.',
      'CLARIFY requires empty response, one clarification object, no evidenceIds, and null nextQuestion.',
      'NO_MATCH requires a natural non-empty unavailable response, null clarification, no evidenceIds, and null nextQuestion.',
      `Allowed evidenceIds for this turn: ${allowedEvidenceIds.join(', ') || 'none'}.`,
      repairingCitation
        ? 'This is a citation-only repair. Keep decision RESPONSE and cite only the allowed evidenceIds that support the response; do not change it to NO_MATCH.'
        : null,
      requestedFactAvailable
        ? 'Verified evidence contains the requested fact. The corrected decision must be RESPONSE, must directly answer it, and must cite the exact supporting allowed aliases. Do not return CLARIFY or NO_MATCH.'
        : null,
      'Do not add facts, citations, or candidates that were not supplied.',
    ].filter(Boolean).join(' ');
    const requiredRepairDecision = requestedFactAvailable
      ? 'RESPONSE' : dependencies.ambiguity?.required === true ? 'CLARIFY' : null;
    completion = await invokeStructuredLlm(request([
      ...baseMessages,
      Object.freeze({ role: 'user', content: repairInstruction }),
    ], requiredRepairDecision));
    output = completionOutput(completion);
    validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
    if (repairingCitation && validated.valid && validated.value.decision !== 'RESPONSE') {
      validated = Object.freeze({
        valid: false,
        reason: 'citation_repair_changed_decision',
      });
    }
    if (requestedFactAvailable && validated.valid
      && validated.value.decision !== 'RESPONSE') {
      validated = Object.freeze({
        valid: false,
        reason: 'grounded_repair_requires_response',
      });
    }
  }
  let finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  if (!validated.valid) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    const initialAmbiguity = verifiedClarificationAmbiguity(
      validated.valid ? validated.value : null,
      evidence, search.value.search, dependencies.ambiguity,
    );
    const extractiveRecovery = requestedFactAvailable
      && initialAmbiguity?.required !== true
      ? extractiveGroundedRecovery(citations.evidence, search.value.search.requestedFact)
      : null;
    if (extractiveRecovery) {
      validated = validateTemplateEnginePostSearchDecision(
        extractiveRecovery, allowedEvidenceIds,
      );
      extractiveRecoveryApplied = validated.valid;
      if (validated.valid) {
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(validated.value);
      }
    } else if (evidence.length === 0 && unavailableResponse) {
      validated = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      configuredFallbackApplied = validated.valid;
      if (validated.valid) {
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(validated.value);
      }
    }
  }
  if (firstInvalidReason && typeof dependencies.onDecisionRepair === 'function') {
    dependencies.onDecisionRepair(Object.freeze({
      initialReason: firstInvalidReason,
      finalReason: validated.valid ? null : validated.reason,
      recovered: validated.valid,
      configuredFallbackApplied,
      extractiveRecoveryApplied,
      first: firstDiagnostics,
      final: finalDiagnostics,
    }));
  }
  if (!validated.valid) {
    if (typeof dependencies.onPostSearchDiagnostics === 'function') {
      dependencies.onPostSearchDiagnostics(Object.freeze({
        evidenceCount: evidence.length,
        allowedAliases: citations.aliases,
        returnedAliases: finalDiagnostics.evidenceAliases,
        initialValidationReason: firstInvalidReason,
        validationReason: validated.reason,
        finalDecision: finalDiagnostics.decision,
        repairAttempted: Boolean(firstInvalidReason),
      }));
    }
    throw new AppError(502, 'The post-search Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID', {
        reason: validated.reason,
        attempts: 2,
        first: firstDiagnostics,
        final: finalDiagnostics,
      });
  }
  let groundedDecision = restorePostSearchEvidenceIds(
    validated.value, citations.aliasToEvidenceId,
  );
  let semanticClaimValidation = dependencies.semanticClaimValidation ?? null;
  const validateClaims = async (decision) => {
    if (configuredFallbackApplied && decision.decision === 'NO_MATCH') {
      return Object.freeze({
        supported: true,
        successClaimed: false,
        requestedFactAddressed: true,
        reason: 'configured_validation_recovery',
      });
    }
    if (typeof dependencies.validateGroundedClaims !== 'function') {
      return dependencies.semanticClaimValidation ?? null;
    }
    const citedIds = new Set(decision.evidenceIds ?? []);
    const citedEvidence = decision.decision === 'RESPONSE'
      ? evidence.filter((source) => citedIds.has(source.evidenceId))
      : evidence;
    const speech = decision.decision === 'CLARIFY'
      ? decision.clarification?.question : decision.response;
    return dependencies.validateGroundedClaims(Object.freeze({
      response: speech,
      decision: decision.decision,
      evidenceIds: decision.evidenceIds ?? [],
      // Complete evidence detects false absence claims; only cited evidence
      // may support the facts spoken in a RESPONSE.
      selectedEvidence: evidence,
      citedEvidence: Object.freeze(citedEvidence),
      latestUtterance: base.latestUtterance,
      searchInterpretation: search.value.search,
    }));
  };
  semanticClaimValidation = await validateClaims(groundedDecision);
  let clarificationAmbiguity = verifiedClarificationAmbiguity(
    groundedDecision, evidence, search.value.search, dependencies.ambiguity,
  );
  let outputValidation = validateTemplateEngineOutput(outputValidationInput(
    groundedDecision, base, dependencies, {
      phase: 'post_search',
      factualClaimsPresent: true,
      claimValidationRequired: true,
      selectedEvidence: evidence,
      semanticClaimValidation,
      searchInterpretation: search.value.search,
      ambiguity: clarificationAmbiguity,
      requiredEvidenceRecordIds: requiredEntityRecordIds.length
        ? requiredEntityRecordIds : base.state.comparisonRecordIds,
      requestedFactAvailable: !configuredFallbackApplied && requestedFactAvailable,
    },
  ));
  let answerableEvidence = clarificationAmbiguity?.required !== true && (
    requestedFactAvailable || (
      groundedDecision.decision === 'RESPONSE'
      && semanticClaimValidation?.supported === true
    )
  );
  if (!outputValidation.valid && !firstInvalidReason) {
    groundingRepairAttempted = true;
    firstInvalidReason = outputValidation.reason;
    const groundingRepairInstruction = [
      `Your previous caller-facing decision failed grounding validation: ${outputValidation.reason}.`,
      outputValidation.reason === 'speech_budget_exceeded'
        ? `Rewrite the complete answer within ${input.maximumSpeechCharacters} characters. Preserve the requested facts and exact supporting citations. The revised answer will be grounded and validated again; do not truncate it.`
        : null,
      outputValidation.reason === 'unsupported_numeric_claim'
        ? `Numeric validation feedback: ${JSON.stringify({
          unsupportedNumbers: outputValidation.details?.unsupportedNumbers ?? [],
          checkedEvidenceAliases: [...citations.aliasToEvidenceId]
            .filter(([, id]) => outputValidation.details?.checkedEvidenceIds?.includes(id))
            .map(([alias]) => alias),
        })}. These numbers were not supported by the cited records. Correct their formatting or cite a supplied record that supports the actual claim; otherwise remove the claim. Never change a number merely to pass validation.`
        : null,
      'Return one corrected JSON object matching the supplied post-search schema.',
      'Validate against the complete verified evidence set. A multi-record comparison may combine only attributes supported by its cited records.',
      'The corrected RESPONSE must directly answer searchInterpretation.requestedFact. Do not substitute another true but unrequested attribute.',
      'Cite every evidence alias used for an entity, number, attribute or relationship.',
      'Generate any applicable nextQuestion in the same corrected response; do not add unsupported facts.',
      'Remove unsupported claims. If the supplied evidence cannot answer the request, return NO_MATCH with natural unavailable-information speech.',
      clarificationAmbiguity?.required === true
        ? 'Multiple genuine published candidates remain unresolved. Return CLARIFY with one natural question using only the supplied ambiguity candidates; RESPONSE and NO_MATCH are forbidden.'
        : null,
      answerableEvidence
        ? 'The verified evidence does answer the requested fact. Return RESPONSE and cite its exact supporting aliases; NO_MATCH is forbidden for this repair.'
        : null,
      `Allowed evidenceIds for this turn: ${allowedEvidenceIds.join(', ') || 'none'}.`,
      'Do not invent facts, identifiers or citations.',
    ].filter(Boolean).join(' ');
    const requiredRepairDecision = clarificationAmbiguity?.required === true
      ? 'CLARIFY' : answerableEvidence ? 'RESPONSE'
        : requestedFactAvailable ? 'RESPONSE' : 'NO_MATCH';
    completion = await invokeStructuredLlm(request([
      ...baseMessages,
      Object.freeze({ role: 'user', content: groundingRepairInstruction }),
    ], requiredRepairDecision));
    output = completionOutput(completion);
    finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
    validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
    if (answerableEvidence && validated.valid
      && validated.value.decision !== 'RESPONSE') {
      validated = Object.freeze({
        valid: false, reason: 'grounded_repair_requires_response',
      });
    }
    if (validated.valid) {
      groundedDecision = restorePostSearchEvidenceIds(
        validated.value, citations.aliasToEvidenceId,
      );
      semanticClaimValidation = await validateClaims(groundedDecision);
      clarificationAmbiguity = verifiedClarificationAmbiguity(
        groundedDecision, evidence, search.value.search, dependencies.ambiguity,
      );
      outputValidation = validateTemplateEngineOutput(outputValidationInput(
        groundedDecision, base, dependencies, {
          phase: 'post_search',
          factualClaimsPresent: true,
          claimValidationRequired: true,
          selectedEvidence: evidence,
          semanticClaimValidation,
          searchInterpretation: search.value.search,
          ambiguity: clarificationAmbiguity,
          requiredEvidenceRecordIds: requiredEntityRecordIds.length
            ? requiredEntityRecordIds : base.state.comparisonRecordIds,
          requestedFactAvailable,
          retryCount: 1,
        },
      ));
      answerableEvidence = answerableEvidence || (
        groundedDecision.decision === 'RESPONSE'
        && semanticClaimValidation?.supported === true
        && clarificationAmbiguity?.required !== true
      );
    } else {
      outputValidation = Object.freeze({
        valid: false, reason: validated.reason, retrySearch: false, ttsAllowed: false,
      });
    }
  }
  if (!outputValidation.valid) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    const extractiveRecovery = answerableEvidence
      && clarificationAmbiguity?.required !== true
      ? extractiveGroundedRecovery(citations.evidence, search.value.search.requestedFact)
      : null;
    if (extractiveRecovery) {
      const recovered = validateTemplateEnginePostSearchDecision(
        extractiveRecovery, allowedEvidenceIds,
      );
      if (recovered.valid) {
        extractiveRecoveryApplied = true;
        groundedDecision = restorePostSearchEvidenceIds(
          recovered.value, citations.aliasToEvidenceId,
        );
        semanticClaimValidation = await validateClaims(groundedDecision);
        outputValidation = validateTemplateEngineOutput(outputValidationInput(
          groundedDecision, base, dependencies, {
            phase: 'post_search', factualClaimsPresent: true,
            claimValidationRequired: true, selectedEvidence: evidence,
            semanticClaimValidation, searchInterpretation: search.value.search,
            ambiguity: dependencies.ambiguity,
            requiredEvidenceRecordIds: requiredEntityRecordIds.length
              ? requiredEntityRecordIds : base.state.comparisonRecordIds,
            requestedFactAvailable: true, retryCount: 1,
          },
        ));
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(recovered.value);
      }
    } else if (evidence.length === 0 && unavailableResponse) {
      const noMatch = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      if (noMatch.valid) {
        configuredFallbackApplied = true;
        groundedDecision = restorePostSearchEvidenceIds(
          noMatch.value, citations.aliasToEvidenceId,
        );
        outputValidation = validateTemplateEngineOutput(outputValidationInput(
          groundedDecision, base, dependencies, {
            phase: 'post_search', factualClaimsPresent: true,
            claimValidationRequired: true,
            selectedEvidence: evidence,
            semanticClaimValidation: await validateClaims(groundedDecision),
            searchInterpretation: search.value.search,
            requiredEvidenceRecordIds: requiredEntityRecordIds.length
              ? requiredEntityRecordIds : base.state.comparisonRecordIds,
            requestedFactAvailable: false,
            ambiguity: verifiedClarificationAmbiguity(
              groundedDecision, evidence, search.value.search, dependencies.ambiguity,
            ),
            retryCount: 1,
          },
        ));
        configuredFallbackApplied = outputValidation.valid;
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(noMatch.value);
      }
    }
  }
  if (groundingRepairAttempted && typeof dependencies.onDecisionRepair === 'function') {
    dependencies.onDecisionRepair(Object.freeze({
      initialReason: firstInvalidReason,
      finalReason: outputValidation.valid ? null : outputValidation.reason,
      recovered: outputValidation.valid,
      configuredFallbackApplied,
      extractiveRecoveryApplied,
      first: firstDiagnostics,
      final: finalDiagnostics,
    }));
  }
  if (!outputValidation.valid) {
    if (typeof dependencies.onPostSearchDiagnostics === 'function') {
      dependencies.onPostSearchDiagnostics(Object.freeze({
        evidenceCount: evidence.length,
        allowedAliases: citations.aliases,
        returnedAliases: finalDiagnostics.evidenceAliases,
        initialValidationReason: firstInvalidReason,
        validationReason: outputValidation.reason,
        finalDecision: outputValidation.retrySearch ? 'SEARCH' : groundedDecision.decision,
        repairAttempted: Boolean(firstInvalidReason),
      }));
    }
    throw new AppError(502, 'The post-search output failed delivery validation',
      'TEMPLATE_ENGINE_OUTPUT_INVALID', { reason: outputValidation.reason });
  }
  const diagnostics = Object.freeze({
    evidenceCount: evidence.length,
    allowedAliases: citations.aliases,
    returnedAliases: finalDiagnostics.evidenceAliases,
    initialValidationReason: firstInvalidReason,
    validationReason: null,
    finalDecision: groundedDecision.decision,
    repairAttempted: Boolean(firstInvalidReason),
    extractiveRecoveryApplied,
  });
  if (typeof dependencies.onPostSearchDiagnostics === 'function') {
    dependencies.onPostSearchDiagnostics(diagnostics);
  }
  return Object.freeze({
    decision: groundedDecision,
    input: turnInput,
    outputValidation,
    diagnostics,
  });
}
