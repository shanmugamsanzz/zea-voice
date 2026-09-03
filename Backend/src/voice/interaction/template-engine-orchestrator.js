import { AppError } from '../../middleware/errors.js';
import { templateEngineDecisionJsonSchema } from './template-engine-decision-contract.js';
import { createMinimalTemplateEngineState } from './template-engine-state.js';
import { normalizeTemplateEngineSearchDecision } from './template-engine-search-request.js';
import {
  templateEnginePostSearchJsonSchema,
  templateEnginePostSearchDecisionDiagnostics,
  validateTemplateEnginePostSearchDecision,
} from './template-engine-post-search-contract.js';
import {
  buildTemplateEngineRoutingPrompt,
  enforceTemplateEngineRuntimeInvariants,
} from './template-engine-routing-control.js';
import { validateTemplateEngineOutput } from './template-engine-output-validator.js';

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

function forcedSearchDecision(orchestratorInput, dependencies = {}) {
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: orchestratorInput.latestUtterance,
      requestedFact: cleanText(dependencies.requestedFact, 500) || null,
      contextualReference: cleanText(dependencies.contextualReference, 500) || null,
      preferredRecordIds: orchestratorInput.state.lastReferencedRecordIds,
    }),
    tool: null, stateUpdate: null,
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
  const completion = await invokeStructuredLlm(Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: 'system', content: systemPrompt }),
      Object.freeze({ role: 'user', content: orchestratorInput.latestUtterance }),
    ]),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'template_engine_orchestrator_decision',
      strict: true,
      schema: templateEngineDecisionJsonSchema,
    }),
  }));

  const authorizedNames = orchestratorInput.authorizedWorkflowTools
    .map((summary) => summary.toolName);
  const validated = enforceTemplateEngineRuntimeInvariants(completionOutput(completion), {
    tenantBoundaryVerified: dependencies.tenantBoundaryVerified === true,
    factualClaimsPresent: dependencies.factualClaimsPresent === true,
    verifiedEvidence: dependencies.verifiedEvidence ?? [],
    workflowAuthorizedTools: authorizedNames,
    assignedToolSchemas: dependencies.assignedToolSchemas ?? authorizedNames,
    toolSuccessClaimed: dependencies.toolSuccessClaimed === true,
    verifiedToolResult: dependencies.verifiedToolResult ?? null,
  });
  if (!validated.valid) {
    throw new AppError(502, 'The template-engine Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', {
        reason: validated.reason,
      });
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
    if (outputValidation.retrySearch) {
      return Object.freeze({
        decision: forcedSearchDecision(orchestratorInput, dependencies),
        input: turnInput,
        verifiedEvidenceIds: validated.verifiedEvidenceIds,
        outputValidation,
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
    }));
    if (evidence.length >= 5) break;
  }
  return Object.freeze(evidence);
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
  });
  const search = normalizeTemplateEngineSearchDecision(input.searchDecision, base.state);
  if (!search.valid || search.value.decision !== 'SEARCH') {
    throw new TypeError('The post-search Orchestrator requires a valid SEARCH interpretation');
  }
  const evidence = verifiedEvidenceForPostSearch(input.verifiedEvidence, input.scope);
  const invokeStructuredLlm = dependencies.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('The post-search Orchestrator requires one structured LLM invoker');
  }
  const turnInput = Object.freeze({
    latestUtterance: base.latestUtterance,
    state: base.state,
    searchInterpretation: search.value.search,
    verifiedEvidence: evidence,
  });
  const systemPrompt = [
    buildTemplateEngineRoutingPrompt({
      mainPrompt: base.mainPrompt,
      outputSchema: templateEnginePostSearchJsonSchema,
      phase: 'post_search',
    }),
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
      schema: templateEnginePostSearchJsonSchema,
    }),
  });
  const allowedEvidenceIds = evidence.map((entry) => entry.evidenceId);
  let completion = await invokeStructuredLlm(request(baseMessages));
  let output = completionOutput(completion);
  let validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
  const firstDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  let firstInvalidReason = null;
  let configuredFallbackApplied = false;
  if (!validated.valid) {
    firstInvalidReason = validated.reason;
    const repairInstruction = [
      `Your previous JSON object was rejected: ${validated.reason}.`,
      'Return one corrected JSON object matching the supplied schema.',
      'RESPONSE requires non-empty response, null clarification, and one or more supplied evidenceIds.',
      'CLARIFY requires empty response, one clarification object, and no evidenceIds.',
      'NO_MATCH requires a natural non-empty unavailable response, null clarification, and no evidenceIds.',
      'Do not add facts, citations, or candidates that were not supplied.',
    ].join(' ');
    completion = await invokeStructuredLlm(request([
      ...baseMessages,
      Object.freeze({ role: 'user', content: repairInstruction }),
    ]));
    output = completionOutput(completion);
    validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
  }
  const finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  if (!validated.valid) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    if (unavailableResponse) {
      validated = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], stateUpdate: null,
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
    throw new AppError(502, 'The post-search Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID', {
        reason: validated.reason,
        attempts: 2,
        first: firstDiagnostics,
        final: finalDiagnostics,
      });
  }
  let semanticClaimValidation = dependencies.semanticClaimValidation ?? null;
  if (validated.value.decision === 'RESPONSE'
    && typeof dependencies.validateGroundedClaims === 'function') {
    semanticClaimValidation = await dependencies.validateGroundedClaims(Object.freeze({
      response: validated.value.response,
      evidenceIds: validated.value.evidenceIds,
      selectedEvidence: evidence,
      latestUtterance: base.latestUtterance,
      searchInterpretation: search.value.search,
    }));
  }
  const outputValidation = validateTemplateEngineOutput(outputValidationInput(
    validated.value, base, dependencies, {
      phase: 'post_search',
      factualClaimsPresent: validated.value.decision === 'RESPONSE',
      selectedEvidence: evidence,
      semanticClaimValidation,
    },
  ));
  if (!outputValidation.valid) {
    if (outputValidation.retrySearch) {
      return Object.freeze({
        decision: search.value,
        input: turnInput,
        outputValidation,
      });
    }
    throw new AppError(502, 'The post-search output failed delivery validation',
      'TEMPLATE_ENGINE_OUTPUT_INVALID', { reason: outputValidation.reason });
  }
  return Object.freeze({
    decision: validated.value,
    input: turnInput,
    outputValidation,
  });
}
