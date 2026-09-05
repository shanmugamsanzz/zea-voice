import { AppError } from '../../middleware/errors.js';
import { instrumentTemplateEngineTurn } from './template-engine-turn-timing.js';
import { normalizedSpeechBudget, speechBudgetInstruction } from './template-engine-speech-budget.js';
import { applyMinimalTemplateEngineStateUpdate, createMinimalTemplateEngineState } from './template-engine-state.js';
import { routeTemplateEngineUtterance, respondToTemplateEngineSearch } from './template-engine-orchestrator.js';
import {
  loadTemplateEnginePublishedContext,
  retrieveTemplateEngineEvidence,
} from './template-engine-production-retrieval.js';
import { advanceTemplateEngineWorkflowTurn } from './template-engine-workflow-runtime.js';
import { validateTemplateEngineClaims } from './template-engine-claim-validator.js';
import {
  assignedToolIdentifiers,
  configuredWorkflowToolIdentifier,
} from '../../knowledge-bases/workflow-tool-authorization.js';
import { selectApplicableConversationGuidance } from './template-engine-conversation-guidance.js';
import {
  repairTemplateEngineFollowUp,
  validateAndComposeTemplateEngineSpeech,
} from './template-engine-follow-up.js';

export const TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION = 3;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function evidenceIds(decision) {
  return Array.isArray(decision?.evidenceIds) ? decision.evidenceIds : [];
}

export function templateEngineEvidenceSuppressesFollowUp(evidence = []) {
  return evidence.some((record) => {
    const data = object(record?.authoritativeData);
    const action = object(data.actionConfig);
    return String(record?.recordType ?? '').toUpperCase() === 'WORKFLOW_RULE'
      && String(data.actionType ?? '').toLowerCase() === 'respond'
      && String(action.responseMode ?? '').toLowerCase() === 'exact';
  });
}

function numericTokens(value) {
  return new Set(cleanText(value).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

function followUpClaimsSupported(decision, evidence) {
  const question = cleanText(decision?.nextQuestion?.question);
  if (!question) return true;
  const cited = new Set(evidenceIds(decision));
  const selectedEvidence = evidence.filter((record) => cited.has(record.evidenceId));
  const allowedNumbers = numericTokens(selectedEvidence.map((record) => [
    record?.content, JSON.stringify(record?.authoritativeData ?? {}),
  ].join(' ')).join(' '));
  return [...numericTokens(question)].every((number) => allowedNumbers.has(number));
}

function conversationStage(state, decision = null) {
  if (state?.activeWorkflowId) {
    return `workflow ${cleanText(state.confirmationStatus, 80) || 'active'}`;
  }
  if (state?.pendingClarification) return 'pending clarification';
  return [decision?.decision, decision?.search?.requestedFact]
    .map((value) => cleanText(value, 160)).filter(Boolean).join(' ') || 'conversation';
}

function reportGuidanceSelection(callback, phase, guidance) {
  callback?.(Object.freeze({
    phase,
    selected: Boolean(guidance),
    recordId: guidance?.recordId ?? null,
    intentClass: guidance?.intentClass ?? null,
    nodeKey: guidance?.nodeKey ?? null,
    conversationStage: guidance?.conversationStage ?? null,
    hasNextQuestion: Boolean(cleanText(guidance?.nextQuestion)),
    selectionScore: guidance?.selectionScore ?? null,
    selectionReasons: guidance?.selectionReasons ?? Object.freeze([]),
  }));
}

function activeClarificationAmbiguity(state) {
  const candidates = [...new Set((Array.isArray(state?.pendingClarification?.candidates)
    ? state.pendingClarification.candidates : [])
    .map((candidate) => cleanText(candidate, 300)).filter(Boolean))];
  return Object.freeze({
    required: candidates.length >= 2,
    kind: candidates.length >= 2 ? 'pending_clarification' : 'not_ambiguous',
    candidates: Object.freeze(candidates.length >= 2 ? candidates : []),
  });
}

function recordIdentity(value) {
  const recordId = cleanText(value?.recordId ?? value?.record_id, 160).toLocaleLowerCase();
  const recordType = cleanText(value?.recordType ?? value?.record_type, 80).toUpperCase();
  return recordId && recordType ? `${recordType}:${recordId}` : null;
}

export function publishedResolutionAmbiguity(
  resolution, evidence = [], searchClassification = null,
) {
  const searchKind = cleanText(searchClassification?.searchKind, 80).toLocaleLowerCase();
  const requested = new Set((searchClassification?.comparisonRecordIds
    ?? searchClassification?.requestedEntityRecordIds ?? [])
    .map((id) => cleanText(id, 160).toLocaleLowerCase()).filter(Boolean));
  const verified = new Set(evidence.filter((record) => record.verified === true)
    .map((record) => cleanText(record.recordId, 160).toLocaleLowerCase()));
  if (searchKind === 'comparison' && requested.size >= 2
    && [...requested].every((id) => verified.has(id))) {
    return Object.freeze({
      required: false, kind: 'resolved_comparison_set', candidates: Object.freeze([]),
    });
  }
  if (['overview', 'general_knowledge'].includes(searchKind)) {
    return Object.freeze({
      required: false, kind: 'request_does_not_require_entity_resolution',
      candidates: Object.freeze([]),
    });
  }
  const possible = resolution?.ambiguity?.detected === true
    ? resolution.ambiguity.candidates : resolution?.routingCandidates ?? [];
  const hydratedIdentities = new Set((Array.isArray(evidence) ? evidence : [])
    .map(recordIdentity).filter(Boolean));
  const hydratedCandidates = [...new Map(possible.map((candidate) => [
    recordIdentity(candidate), candidate,
  ]).filter(([identity]) => identity && hydratedIdentities.has(identity))).values()];
  if (hydratedCandidates.length === 1) {
    return Object.freeze({
      required: false, kind: 'resolved_by_exact_hydrated_evidence',
      candidates: Object.freeze([]),
    });
  }
  const candidates = [...new Set((hydratedCandidates.length >= 2
    ? hydratedCandidates : possible)
    .map((candidate) => cleanText(candidate?.label ?? candidate?.canonicalName, 300))
    .filter(Boolean))];
  if (resolution?.ambiguity?.detected === true && candidates.length >= 2) {
    return Object.freeze({
      required: true,
      kind: 'published_entity_candidates',
      candidates: Object.freeze(candidates),
    });
  }
  if (resolution?.requiresCandidateConfirmation === true && candidates.length) {
    return Object.freeze({
      required: true,
      kind: 'published_entity_confirmation',
      candidates: Object.freeze(candidates.slice(0, 1)),
    });
  }
  return Object.freeze({
    required: false,
    kind: resolution?.reason === 'no_candidate' || resolution?.action === 'CLARIFY'
      ? 'no_published_entity_match' : 'resolved_published_entity',
    candidates: Object.freeze([]),
  });
}

function searchTokens(value) {
  return new Set(cleanText(value).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').split(/\s+/u)
    .filter((token) => token.length > 1));
}

function tokenCoverage(needle, haystack) {
  const wanted = searchTokens(needle);
  const available = searchTokens(haystack);
  if (!wanted.size) return 0;
  let matched = 0;
  for (const token of wanted) if (available.has(token)) matched += 1;
  return matched / wanted.size;
}

function speculativeSearchDecision(input, state) {
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: cleanText(input.latestUtterance, 2_000),
      requestedFact: null,
      contextualReference: null,
      preferredRecordIds: state.lastReferencedRecordIds,
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function speculativeEvidenceCompatible(retrieval, decision, input) {
  if (!retrieval || retrieval.error || !Array.isArray(retrieval.evidence)) return false;
  const preferred = new Set((decision.search?.preferredRecordIds ?? []).map((id) => cleanText(id, 160)));
  const retrieved = new Set(retrieval.evidence.map((record) => cleanText(record?.recordId, 160)));
  if ([...preferred].some((recordId) => !retrieved.has(recordId))) return false;
  const contextual = preferred.size > 0;
  const queryCompatible = Math.max(
    tokenCoverage(input.latestUtterance, decision.search?.query),
    tokenCoverage(decision.search?.query, input.latestUtterance),
  ) >= 0.6;
  const requestedFact = cleanText(decision.search?.requestedFact, 500);
  const evidenceText = retrieval.evidence.map((record) => [
    record?.content,
    ...(record?.publishedAttributePaths ?? []),
    JSON.stringify(record?.authoritativeData ?? {}),
  ].join(' ')).join(' ');
  const factAvailable = !requestedFact || tokenCoverage(requestedFact, evidenceText) > 0;
  return (contextual || queryCompatible) && factAvailable;
}

async function composeWithFollowUpRepair({
  decision, mainPrompt, latestUtterance, recentCompleteTurns, conversationGuidance,
  evidence, suppressFollowUp = false, invokeStructuredLlm,
  maximumSpeechCharacters = null,
  onDiagnostics,
}) {
  let claimsValidated = followUpClaimsSupported(decision, evidence);
  let composed = validateAndComposeTemplateEngineSpeech({
    decision, recentCompleteTurns, conversationGuidance, suppressFollowUp,
    claimsValidated, maximumSpeechCharacters,
  });
  const repair = await repairTemplateEngineFollowUp({
    decision,
    mainPrompt,
    latestUtterance,
    recentCompleteTurns,
    conversationGuidance,
    initialValidation: composed.followUp,
    maximumSpeechCharacters,
    invokeStructuredLlm,
  });
  if (repair.attempted && repair.reason === null) {
    claimsValidated = followUpClaimsSupported(repair.decision, evidence);
    composed = validateAndComposeTemplateEngineSpeech({
      decision: repair.decision,
      recentCompleteTurns,
      conversationGuidance,
      suppressFollowUp,
      claimsValidated, maximumSpeechCharacters,
    });
  }
  if (maximumSpeechCharacters && composed.speech.length > maximumSpeechCharacters) {
    throw new AppError(502, 'The complete validated answer exceeds the speech budget',
      'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED');
  }
  onDiagnostics?.(Object.freeze({
    guidanceRecordId: conversationGuidance?.recordId ?? null,
    guidanceHasNextQuestion: Boolean(cleanText(conversationGuidance?.nextQuestion)),
    proposed: Boolean(cleanText(decision?.nextQuestion?.question)),
    accepted: composed.followUp.accepted,
    validationReason: composed.followUp.reason,
    repairAttempted: repair.attempted,
    repairReason: repair.reason,
  }));
  return Object.freeze({ ...composed, repair });
}

function applyDecisionState(state, decision, evidence = []) {
  let next = state;
  if (decision?.stateUpdate) next = applyMinimalTemplateEngineStateUpdate(next, decision.stateUpdate);
  const citedEvidenceIds = evidenceIds(decision);
  const recordsByEvidenceId = new Map(evidence.map((record) => [
    record.evidenceId, record.recordId,
  ]));
  const citedRecordIds = citedEvidenceIds.map((id) => recordsByEvidenceId.get(id)).filter(Boolean);
  if (citedRecordIds.length) {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: { lastReferencedRecordIds: citedRecordIds }, clear: [],
    });
  }
  if (decision?.decision === 'CLARIFY') {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: { pendingClarification: decision.clarification }, clear: [],
    });
  } else if (next.pendingClarification) {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: {}, clear: ['pendingClarification'],
    });
  }
  return next;
}

function responseProvenance({
  initialDecision, finalDecision, evidenceIds: citedEvidenceIds = [], workflowId = null,
  toolId = null, validationResult = 'valid', searchPerformed = false,
  clarificationReason = null,
} = {}) {
  return Object.freeze({
    initialDecision,
    finalDecision,
    evidenceIds: Object.freeze([...new Set(citedEvidenceIds)]),
    workflowId,
    toolId,
    validationResult,
    searchPerformed,
    clarificationReason,
  });
}

function authorizedWorkflowSummaries(workflows, tools) {
  return workflows.flatMap((workflow) => {
    const identifier = configuredWorkflowToolIdentifier(workflow);
    const matches = tools.filter((tool) => assignedToolIdentifiers(tool).has(identifier));
    if (matches.length !== 1) return [];
    return [Object.freeze({
      workflowRecordId: workflow.recordId,
      toolName: matches[0].name,
      description: workflow.description ?? workflow.name ?? matches[0].description ?? null,
      requiredFields: matches[0].configuration?.inputSchema?.required
        ?? matches[0].inputSchema?.required ?? [],
    })];
  });
}

function callerVerifiedArguments(argumentsValue, utterance, recentTurns = [], existing = {}) {
  const callerContext = [
    ...(Array.isArray(recentTurns) ? recentTurns : []).filter((turn) => (
      turn?.role === 'user'
    )).map((turn) => turn.content),
    utterance,
  ].join(' ');
  const normalizedUtterance = cleanText(callerContext, 16_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}@+.:/-]+/gu, ' ');
  return Object.fromEntries(Object.entries(object(argumentsValue)).filter(([key, value]) => {
    if (Object.hasOwn(existing, key) && existing[key] === value) return true;
    const normalizedValue = cleanText(value, 1_000).toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}@+.:/-]+/gu, ' ').trim();
    return normalizedValue && normalizedUtterance.includes(normalizedValue);
  }));
}

async function runWorkflow(input, decision, state, context, dependencies) {
  const workflows = context.publishedWorkflows;
  const candidates = callerVerifiedArguments(
    decision.tool?.arguments,
    input.latestUtterance,
    state.recentCompleteTurns,
    state.collectedToolFields,
  );
  const explicitConfirmation = state.confirmationStatus === 'awaiting_confirmation'
    && decision.stateUpdate?.set?.confirmationStatus === 'confirmed'
    && Object.keys(candidates).length === 0;
  const resultConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: context.publishedConversationGuidance ?? [],
    scope: context.scope,
    latestUtterance: input.latestUtterance,
    finalDecision: 'TOOL_RESULT',
    currentIntent: 'TOOL_RESULT',
    conversationStage: 'workflow result',
    language: input.language,
    recentCompleteTurns: state.recentCompleteTurns,
  });
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected, 'workflow_result', resultConversationGuidance,
  );
  const transition = await advanceTemplateEngineWorkflowTurn({
    toolDecision: decision,
    state,
    publishedWorkflows: workflows,
    assignedTools: input.assignedTools,
    informationFields: input.informationFields,
    scope: context.scope,
    candidateValues: candidates,
    selectedRecordIds: state.lastReferencedRecordIds,
    candidateValuesVerified: true,
    confirmation: { accepted: explicitConfirmation, explicit: explicitConfirmation },
    confirmationMessage: input.confirmationMessage,
    mainPrompt: input.mainPrompt,
    language: input.language,
    conversationGuidance: resultConversationGuidance,
  }, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    persistWorkflowState: dependencies.persistWorkflowState,
    executeAuthorizedTool: dependencies.executeAuthorizedTool,
    validateToolResultSpeechClaims: dependencies.validateToolResultSpeechClaims,
    getCachedWorkflowSpeech: dependencies.getCachedWorkflowSpeech,
    cacheWorkflowSpeech: dependencies.cacheWorkflowSpeech,
  });
  const finished = ['SUCCEEDED', 'FAILED'].includes(transition.status);
  dependencies.onWorkflowDiagnostics?.(Object.freeze({
    status: transition.status,
    workflowRecordId: transition.workflowRecordId ?? null,
    toolId: transition.toolId ?? null,
    selectedRecordIds: Object.freeze([...state.lastReferencedRecordIds]),
    acceptedFields: transition.acceptedFields ?? Object.freeze([]),
    rejectedFields: transition.rejectedFields ?? Object.freeze([]),
    collectedFieldKeys: Object.freeze(Object.keys(
      transition.state?.collectedToolFields ?? {},
    )),
    confirmationStatus: transition.state?.confirmationStatus ?? null,
    verifiedResult: transition.verifiedResult?.verified === true,
    success: transition.verifiedResult?.success ?? null,
  }));
  return Object.freeze({
    decision,
    speech: transition.speech,
    state: createMinimalTemplateEngineState({
      conversationHistory: state.recentCompleteTurns,
      lastReferencedRecordIds: state.lastReferencedRecordIds,
      comparisonRecordIds: state.comparisonRecordIds,
      pendingClarification: null,
      activeWorkflowId: transition.state.activeWorkflowId,
      collectedToolFields: transition.state.collectedToolFields,
      confirmationStatus: transition.state.confirmationStatus,
    }),
    evidence: Object.freeze([]),
    evidenceIds: [],
    workflow: transition,
    toolExecuted: finished,
    followUpValidation: transition.followUpValidation,
    provenance: responseProvenance({
      initialDecision: 'TOOL',
      finalDecision: finished ? 'TOOL_RESULT' : 'CLARIFY',
      workflowId: transition.workflowRecordId
        ?? state.activeWorkflowId ?? transition.state.activeWorkflowId,
      toolId: transition.toolId ?? decision.tool?.name,
      validationResult: finished
        ? (transition.verifiedResult?.verified === true ? 'verified_tool_result' : 'unverified_tool_result')
        : 'workflow_state_valid',
      clarificationReason: finished ? null
        : transition.status === 'AWAITING_FIELD'
          ? 'missing_workflow_field'
          : transition.status === 'AWAITING_CONFIRMATION'
            ? 'workflow_confirmation_required'
            : 'workflow_input_required',
    }),
  });
}

export async function runTemplateEngineProductionTurn(input = {}, dependencies = {}) {
  for (const dependency of [
    'invokeStructuredLlm', 'loadPublishedContext', 'retrieveEvidence',
    'persistWorkflowState', 'executeAuthorizedTool', 'validateGroundedClaims',
    'validateToolResultSpeechClaims',
  ]) {
    if (typeof dependencies[dependency] !== 'function') {
      throw new TypeError(`Template-engine production runtime requires ${dependency}`);
    }
  }
  dependencies = instrumentTemplateEngineTurn(dependencies);
  input = { ...input, maximumSpeechCharacters: normalizedSpeechBudget(input.maximumSpeechCharacters
    ?? input.runtimeProfile?.limits?.ttsMaxCharactersPerResponse) };
  const state = createMinimalTemplateEngineState({
    conversationHistory: input.conversationHistory,
    ...object(input.state),
  });
  const publishedContext = await dependencies.loadPublishedContext({
    auth: input.auth,
    scope: input.scope,
    callId: input.callId,
    usageDirection: input.usageDirection,
    language: input.language,
  });
  const workflowSummaries = authorizedWorkflowSummaries(
    publishedContext.publishedWorkflows, input.assignedTools,
  );
  // Guidance that is selected before the route is known can bias an ordinary
  // conversational turn toward whichever published record happens to score
  // highest. Route first, then select guidance against that concrete route.
  const initialConversationGuidance = null;
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected, 'initial_routing', initialConversationGuidance,
  );
  const common = {
    mainPrompt: [input.mainPrompt, speechBudgetInstruction(input.maximumSpeechCharacters)].filter(Boolean).join('\n'),
    latestUtterance: input.latestUtterance,
    conversationHistory: state.recentCompleteTurns,
    pendingClarification: state.pendingClarification,
    activeWorkflowState: state,
    lastReferencedRecordIds: state.lastReferencedRecordIds,
    comparisonRecordIds: state.comparisonRecordIds,
    activeWorkflowId: state.activeWorkflowId,
    collectedToolFields: state.collectedToolFields,
    confirmationStatus: state.confirmationStatus,
    authorizedWorkflowTools: workflowSummaries,
    conversationGuidance: initialConversationGuidance,
  };
  let completedSpeculativeResult = null;
  const speculativeRetrieval = typeof dependencies.retrieveSpeculativeEvidence === 'function'
    ? dependencies.retrieveSpeculativeEvidence({
      auth: input.auth,
      scope: publishedContext.scope,
      callId: input.callId,
      usageDirection: input.usageDirection,
      language: input.language,
      searchDecision: speculativeSearchDecision(input, state),
      state,
      runtimeProfile: input.runtimeProfile,
      preloadedArtifacts: publishedContext.artifacts,
      conversationGuidance: initialConversationGuidance,
      speculative: true,
    }).catch((error) => Object.freeze({ error })).then((value) => {
      completedSpeculativeResult = value;
      return value;
    })
    : null;
  const routingDependencies = {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    onDecisionRetry: dependencies.onRoutingDecisionRetry,
    tenantBoundaryVerified: true,
    nonFactualResponseAllowed: true,
    assignedToolSchemas: input.assignedTools,
    publishedWorkflows: publishedContext.publishedWorkflows,
    assignedTools: input.assignedTools,
    informationFields: input.informationFields,
    scope: publishedContext.scope,
    ambiguity: activeClarificationAmbiguity(state),
  };
  let routed = await routeTemplateEngineUtterance(common, routingDependencies);
  let first = routed.decision;
  let initialValidationResult = routed.outputValidation?.reason ?? 'valid';
  if (first.decision === 'RESPONSE' || first.decision === 'CLARIFY') {
    const directSpeech = first.decision === 'CLARIFY'
      ? first.clarification?.question : first.response;
    const directValidation = await dependencies.validateGroundedClaims({
      response: directSpeech,
      decision: first.decision,
      selectedEvidence: Object.freeze([]),
      latestUtterance: input.latestUtterance,
    });
    if (directValidation?.supported !== true) {
      initialValidationResult = directValidation?.reason
        ?? 'caller_speech_requires_grounding_search';
      routed = await routeTemplateEngineUtterance(common, {
        ...routingDependencies,
        factualClaimsPresent: true,
        nonFactualResponseAllowed: false,
      });
      first = routed.decision;
    }
  }
  if (first.decision === 'TOOL') {
    return runWorkflow(input, first, state, publishedContext, dependencies);
  }
  if (first.decision !== 'SEARCH') {
    const directConversationGuidance = selectApplicableConversationGuidance({
      publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
      scope: publishedContext.scope,
      latestUtterance: input.latestUtterance,
      finalDecision: first.decision,
      currentIntent: first.decision,
      recentCompleteTurns: state.recentCompleteTurns,
      conversationStage: conversationStage(state, first),
      language: input.language,
    });
    reportGuidanceSelection(
      dependencies.onConversationGuidanceSelected, 'direct_response', directConversationGuidance,
    );
    const composed = await composeWithFollowUpRepair({
      decision: first,
      mainPrompt: input.mainPrompt,
      latestUtterance: input.latestUtterance,
      recentCompleteTurns: state.recentCompleteTurns,
      conversationGuidance: directConversationGuidance,
      evidence: [],
      maximumSpeechCharacters: input.maximumSpeechCharacters,
      invokeStructuredLlm: dependencies.invokeStructuredLlm,
      onDiagnostics: (details) => dependencies.onFollowUpDiagnostics?.(Object.freeze({
        phase: 'direct_response', ...details,
      })),
    });
    first = composed.decision;
    const speech = composed.speech;
    if (!speech) throw new AppError(502, 'Template engine produced no caller speech', 'TEMPLATE_ENGINE_SILENT_TURN');
    return Object.freeze({
      decision: first, speech, state: applyDecisionState(state, first),
      evidence: Object.freeze([]), evidenceIds: Object.freeze([]),
      workflow: null, toolExecuted: false,
      provenance: responseProvenance({
        initialDecision: first.decision,
        finalDecision: first.decision,
        validationResult: initialValidationResult,
        clarificationReason: first.clarification?.reason ?? null,
      }),
      followUpValidation: composed.followUp,
    });
  }

  const preRetrievalConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
    scope: publishedContext.scope,
    latestUtterance: input.latestUtterance,
    finalDecision: first.decision,
    searchInterpretation: first.search,
    evidence: [],
    recentCompleteTurns: state.recentCompleteTurns,
    currentIntent: first.search?.requestedFact ?? first.decision,
    conversationStage: conversationStage(state, first),
    language: input.language,
  });
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected,
    'pre_retrieval', preRetrievalConversationGuidance,
  );
  const guidanceCompatible = (initialConversationGuidance?.recordId ?? null)
    === (preRetrievalConversationGuidance?.recordId ?? null);
  // Speculation is an opportunistic optimization, never a dependency of the
  // foreground answer. Reuse only completed, compatible verified evidence.
  const speculativeResult = guidanceCompatible ? completedSpeculativeResult : null;
  const usedSpeculativeRetrieval = guidanceCompatible
    && speculativeEvidenceCompatible(speculativeResult, first, input);
  const retrieval = usedSpeculativeRetrieval ? speculativeResult : await dependencies.retrieveEvidence({
    auth: input.auth,
    scope: publishedContext.scope,
    callId: input.callId,
    usageDirection: input.usageDirection,
    language: input.language,
    searchDecision: first,
    state,
    runtimeProfile: input.runtimeProfile,
    preloadedArtifacts: publishedContext.artifacts,
    conversationGuidance: preRetrievalConversationGuidance,
  });
  if (typeof dependencies.onRetrievalDiagnostics === 'function') {
    dependencies.onRetrievalDiagnostics(Object.freeze({
      ...(retrieval.diagnostics ?? {
      channelCounts: Object.freeze({}),
      retrievalCount: 0,
      hydrationCount: 0,
      verifiedEvidenceCount: retrieval.evidence?.length ?? 0,
      failedChannels: Object.freeze([]),
      }),
      speculative: Boolean(speculativeRetrieval),
      speculativeReused: usedSpeculativeRetrieval,
    }));
  }
  const hydratedRecordIds = new Set((retrieval.evidence ?? []).filter((source) => source.verified === true)
    .map((source) => cleanText(source.recordId, 160).toLocaleLowerCase()));
  if (retrieval.diagnostics?.requestedEntityHydrationIncomplete === true
    || (retrieval.requestedEntityRecordIds ?? []).some((id) => !hydratedRecordIds.has(
      cleanText(id, 160).toLocaleLowerCase(),
    ))) {
    throw new AppError(503, 'Requested evidence hydration is incomplete',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE');
  }
  const postSearchConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
    scope: publishedContext.scope,
    latestUtterance: input.latestUtterance,
    finalDecision: first.decision,
    searchInterpretation: first.search,
    evidence: retrieval.evidence,
    recentCompleteTurns: state.recentCompleteTurns,
    currentIntent: first.search?.requestedFact ?? first.decision,
    conversationStage: conversationStage(state, first),
    language: input.language,
  });
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected, 'post_search', postSearchConversationGuidance,
  );
  const answered = await respondToTemplateEngineSearch({
    ...common,
    mainPrompt: input.mainPrompt,
    state,
    searchDecision: first,
    verifiedEvidence: retrieval.evidence,
    scope: retrieval.scope,
    informationUnavailableResponse: input.informationUnavailableResponse,
    conversationGuidance: postSearchConversationGuidance,
    requestedEntityRecordIds: retrieval.requestedEntityRecordIds,
    maximumSpeechCharacters: input.maximumSpeechCharacters,
  }, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    tenantBoundaryVerified: true,
    publishedEntities: retrieval.evidence,
    ambiguity: publishedResolutionAmbiguity(
      retrieval.entityResolution, retrieval.evidence, retrieval.searchClassification,
    ),
    validateGroundedClaims: ({
      response, decision, selectedEvidence, citedEvidence, searchInterpretation, latestUtterance,
    }) => (
      dependencies.validateGroundedClaims({
        response, decision, selectedEvidence, citedEvidence, searchInterpretation, latestUtterance,
      })
    ),
    onDecisionRepair: dependencies.onPostSearchDecisionRepair,
    onPostSearchDiagnostics: dependencies.onPostSearchDiagnostics,
  });
  if (answered.decision.decision === 'SEARCH') {
    throw new AppError(502, 'Grounded answer failed validation after one search',
      'TEMPLATE_ENGINE_GROUNDING_REJECTED');
  }
  const composed = await composeWithFollowUpRepair({
    decision: answered.decision,
    mainPrompt: input.mainPrompt,
    latestUtterance: input.latestUtterance,
    recentCompleteTurns: state.recentCompleteTurns,
    conversationGuidance: postSearchConversationGuidance,
    evidence: retrieval.evidence,
    suppressFollowUp: templateEngineEvidenceSuppressesFollowUp(retrieval.evidence),
    maximumSpeechCharacters: input.maximumSpeechCharacters,
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    onDiagnostics: (details) => dependencies.onFollowUpDiagnostics?.(Object.freeze({
      phase: 'post_search', ...details,
    })),
  });
  const speech = composed.speech;
  if (!speech) throw new AppError(502, 'Template engine produced no caller speech', 'TEMPLATE_ENGINE_SILENT_TURN');
  return Object.freeze({
    decision: composed.decision,
    speech,
    state: applyDecisionState(state, answered.decision, retrieval.evidence),
    evidence: retrieval.evidence,
    evidenceIds: Object.freeze(evidenceIds(answered.decision)),
    diagnostics: Object.freeze({
      retrieval: retrieval.diagnostics ?? null,
      postSearch: answered.diagnostics ?? null,
    }),
    workflow: null,
    toolExecuted: false,
    followUpValidation: composed.followUp,
    provenance: responseProvenance({
      initialDecision: 'SEARCH',
      finalDecision: answered.decision.decision,
      evidenceIds: evidenceIds(answered.decision),
      validationResult: answered.outputValidation?.reason ?? 'valid',
      searchPerformed: true,
      clarificationReason: answered.decision.clarification?.reason ?? null,
    }),
  });
}

export const productionTemplateEngineDependencies = Object.freeze({
  loadPublishedContext: loadTemplateEnginePublishedContext,
  retrieveEvidence: retrieveTemplateEngineEvidence,
  validateClaims: validateTemplateEngineClaims,
});
