import { AppError } from '../../middleware/errors.js';
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
        'Re-evaluate the same finalized caller utterance and relevant recent conversation.',
        'Return exactly one decision branch and set every field belonging to other branches to null or empty as required by the supplied schema.',
        'Do not change, discard, summarize, or replace the caller utterance.',
        'Do not turn conversational interaction management into missing-information speech.',
        'Return only one complete JSON object with no Markdown or commentary.',
      ].join(' '),
    }),
  ]);
}

async function invokeValidatedDecision({
  invokeStructuredLlm, request, messages, validateCompletion, phase, onRetry,
}) {
  let completion = await invokeStructuredLlm(request(messages));
  let validated = validateCompletion(completion);
  let retryAttempted = false;
  let initialReason = null;
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
  }
  return Object.freeze({ completion, validated, retryAttempted, initialReason });
}

function forcedSearchDecision(orchestratorInput, dependencies = {}) {
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: orchestratorInput.latestUtterance,
      requestedFact: cleanText(dependencies.requestedFact, 500) || null,
      contextualReference: cleanText(dependencies.contextualReference, 500) || null,
      preferredRecordIds: orchestratorInput.state.lastReferencedRecordIds,
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function searchNeedsRoutingReview(decision) {
  if (decision?.decision !== 'SEARCH') return false;
  const search = decision.search ?? {};
  return !cleanText(search.requestedFact, 500)
    && !cleanText(search.contextualReference, 500);
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
  let invocation = await invokeValidatedDecision({
    invokeStructuredLlm,
    request,
    messages: baseMessages,
    validateCompletion,
    phase: 'initial_routing',
    onRetry: dependencies.onDecisionRetry,
  });
  let { validated } = invocation;
  let decisionRepairAttempted = invocation.retryAttempted;
  if (!validated.valid) {
    throw new AppError(502, 'The template-engine Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', {
        reason: validated.reason,
        attempts: 2,
        initialReason: invocation.initialReason,
      });
  }
  let routingReviewAttempted = false;
  if (searchNeedsRoutingReview(validated.value)) {
    routingReviewAttempted = true;
    const reviewMessages = Object.freeze([
      ...baseMessages,
      Object.freeze({
        role: 'user',
        content: [
          'Review the route because SEARCH does not identify a fact or genuine contextual reference requested by the caller.',
          'Use RESPONSE when the complete utterance only manages the conversation, including a greeting, acknowledgement, courtesy, pause, wait, presence check, hearing check, brief confirmation, or resumption.',
          'If it requests externally verifiable information, keep SEARCH and populate requestedFact or contextualReference from the latest utterance and relevant recentCompleteTurns.',
          'Use CLARIFY only for multiple genuinely plausible meanings. Use TOOL only for an explicit action matching an authorized Workflow summary.',
          'Stored record IDs alone never make the latest utterance factual. Do not use phrase matching or invent a fact, entity, action, or context.',
        ].join(' '),
      }),
    ]);
    invocation = await invokeValidatedDecision({
      invokeStructuredLlm,
      request,
      messages: reviewMessages,
      validateCompletion,
      phase: 'routing_review',
      onRetry: dependencies.onDecisionRetry,
    });
    validated = invocation.validated;
    decisionRepairAttempted ||= invocation.retryAttempted;
    if (!validated.valid) {
      throw new AppError(502, 'The template-engine routing review returned an invalid decision',
        'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', {
          reason: validated.reason,
          attempts: 2,
          initialReason: invocation.initialReason,
        });
    }
  }
  const contextualDecision = normalizeTemplateEngineSearchDecision(
    validated.value, orchestratorInput.state,
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
    const rejectedClarification = contextualDecision.value.decision === 'CLARIFY'
      && ['clarification_not_required', 'clarification_candidates_required']
        .includes(outputValidation.reason);
    if (outputValidation.retrySearch || rejectedClarification) {
      return Object.freeze({
        decision: forcedSearchDecision(orchestratorInput, dependencies),
        input: turnInput,
        verifiedEvidenceIds: validated.verifiedEvidenceIds,
        outputValidation,
        routingReviewAttempted,
        decisionRepairAttempted,
      });
    }
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
    if (evidence.length >= 5) break;
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

function evidenceCandidateNames(source) {
  return cleanList([source?.canonicalName, ...(source?.aliases ?? [])], 60)
    .map(candidateIdentity).filter(Boolean);
}

function verifiedClarificationAmbiguity(decision, evidence, searchInterpretation, supplied) {
  if (decision?.decision !== 'CLARIFY') return supplied ?? null;

  const preferred = new Set((searchInterpretation?.preferredRecordIds ?? [])
    .map(recordId).filter(Boolean));
  const resolvedPreferred = new Set(evidence.map((source) => recordId(source?.recordId))
    .filter((id) => preferred.has(id)));
  // A singular remembered record resolves "this/it". Multiple preferences
  // represent an intentional comparison and must be answered together.
  if (resolvedPreferred.size === 1 || preferred.size > 1) {
    return Object.freeze({
      required: false, kind: 'resolved_context', candidates: Object.freeze([]),
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
  const genuine = resolvedRecordIds.size >= 2;
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
  const evidence = verifiedEvidenceForPostSearch(input.verifiedEvidence, input.scope);
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
    'Answer the requestedFact only when it is explicitly supported by those supplied facts.',
    'An absent attribute means the published evidence does not provide that information. Absence never proves a negative value, non-existence, non-requirement, non-availability, or zero.',
    'For NO_MATCH, describe only that the requested information is not present in the supplied published evidence; do not assert that the underlying real-world attribute is false.',
    'CLARIFY speech may identify supplied ambiguity candidates but must not introduce any unsupported factual claim.',
    'Use CLARIFY only when at least two distinct supplied published records are genuinely possible, and name both candidates.',
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
  const request = (messages) => Object.freeze({
    messages: Object.freeze(messages),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'template_engine_post_search_decision',
      strict: true,
      schema: responseSchema,
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
      'Do not add facts, citations, or candidates that were not supplied.',
    ].filter(Boolean).join(' ');
    completion = await invokeStructuredLlm(request([
      ...baseMessages,
      Object.freeze({ role: 'user', content: repairInstruction }),
    ]));
    output = completionOutput(completion);
    validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
    if (repairingCitation && validated.valid && validated.value.decision !== 'RESPONSE') {
      validated = Object.freeze({
        valid: false,
        reason: 'citation_repair_changed_decision',
      });
    }
  }
  let finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  if (!validated.valid && evidence.length === 0) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    if (unavailableResponse) {
      validated = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      configuredFallbackApplied = validated.valid;
    }
  }
  if (firstInvalidReason && typeof dependencies.onDecisionRepair === 'function') {
    dependencies.onDecisionRepair(Object.freeze({
      initialReason: firstInvalidReason,
      finalReason: validated.valid ? null : validated.reason,
      recovered: validated.valid,
      configuredFallbackApplied,
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
    if (typeof dependencies.validateGroundedClaims !== 'function') {
      return dependencies.semanticClaimValidation ?? null;
    }
    const citedIds = new Set(decision.evidenceIds ?? []);
    const completeCitedEvidence = decision.decision === 'RESPONSE'
      ? evidence.filter((source) => citedIds.has(source.evidenceId))
      : evidence;
    const speech = decision.decision === 'CLARIFY'
      ? decision.clarification?.question : decision.response;
    return dependencies.validateGroundedClaims(Object.freeze({
      response: speech,
      decision: decision.decision,
      evidenceIds: decision.evidenceIds ?? [],
      selectedEvidence: Object.freeze(completeCitedEvidence),
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
      requiredEvidenceRecordIds: base.state.comparisonRecordIds.length > 1
        ? base.state.comparisonRecordIds : [],
      requestedFactAvailable: evidenceProvidesRequestedFact(
        evidence, search.value.search.requestedFact,
      ),
    },
  ));
  if (!outputValidation.valid && !firstInvalidReason) {
    groundingRepairAttempted = true;
    firstInvalidReason = outputValidation.reason;
    const groundingRepairInstruction = [
      `Your previous caller-facing decision failed grounding validation: ${outputValidation.reason}.`,
      'Return one corrected JSON object matching the supplied post-search schema.',
      'Validate against the complete verified evidence set. A multi-record comparison may combine only attributes supported by its cited records.',
      'The corrected RESPONSE must directly answer searchInterpretation.requestedFact. Do not substitute another true but unrequested attribute.',
      'Cite every evidence alias used for an entity, number, attribute or relationship.',
      'Generate any applicable nextQuestion in the same corrected response; do not add unsupported facts.',
      'Remove unsupported claims. If the supplied evidence cannot answer the request, return NO_MATCH with natural unavailable-information speech.',
      `Allowed evidenceIds for this turn: ${allowedEvidenceIds.join(', ') || 'none'}.`,
      'Do not invent facts, identifiers or citations.',
    ].join(' ');
    completion = await invokeStructuredLlm(request([
      ...baseMessages,
      Object.freeze({ role: 'user', content: groundingRepairInstruction }),
    ]));
    output = completionOutput(completion);
    finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
    validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
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
          requiredEvidenceRecordIds: base.state.comparisonRecordIds.length > 1
            ? base.state.comparisonRecordIds : [],
          requestedFactAvailable: evidenceProvidesRequestedFact(
            evidence, search.value.search.requestedFact,
          ),
          retryCount: 1,
        },
      ));
    } else {
      outputValidation = Object.freeze({
        valid: false, reason: validated.reason, retrySearch: false, ttsAllowed: false,
      });
    }
  }
  if (!outputValidation.valid) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    if (unavailableResponse) {
      const noMatch = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      if (noMatch.valid) {
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
            requiredEvidenceRecordIds: base.state.comparisonRecordIds.length > 1
              ? base.state.comparisonRecordIds : [],
            requestedFactAvailable: evidenceProvidesRequestedFact(
              evidence, search.value.search.requestedFact,
            ),
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
