import { AppError } from '../../middleware/errors.js';
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
  validateAndComposeTemplateEngineSpeech,
} from './template-engine-follow-up.js';

export const TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION = 2;

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

async function followUpClaimsSupported(decision, evidence, validateGroundedClaims) {
  const question = cleanText(decision?.nextQuestion?.question);
  if (!question) return true;
  const cited = new Set(evidenceIds(decision));
  const selectedEvidence = evidence.filter((record) => cited.has(record.evidenceId));
  const validation = await validateGroundedClaims({
    response: question,
    selectedEvidence: Object.freeze(selectedEvidence),
  });
  return validation?.supported === true;
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
    recentCompleteTurns: state.recentCompleteTurns,
  });
  const transition = await advanceTemplateEngineWorkflowTurn({
    toolDecision: decision,
    state,
    publishedWorkflows: workflows,
    assignedTools: input.assignedTools,
    informationFields: input.informationFields,
    scope: context.scope,
    candidateValues: candidates,
    candidateValuesVerified: true,
    confirmation: { accepted: explicitConfirmation, explicit: explicitConfirmation },
    confirmationMessage: input.confirmationMessage,
    mainPrompt: input.mainPrompt,
    conversationGuidance: resultConversationGuidance,
  }, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    persistWorkflowState: dependencies.persistWorkflowState,
    executeAuthorizedTool: dependencies.executeAuthorizedTool,
    validateToolResultSpeechClaims: dependencies.validateToolResultSpeechClaims,
  });
  const workflow = context.publishedWorkflows.find((entry) => (
    configuredWorkflowToolIdentifier(entry) === decision.tool?.name
  ));
  const assignedTool = input.assignedTools.find((entry) => (
    assignedToolIdentifiers(entry).has(decision.tool?.name)
  ));
  const finished = ['SUCCEEDED', 'FAILED'].includes(transition.status);
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
      workflowId: workflow?.recordId ?? state.activeWorkflowId ?? transition.state.activeWorkflowId,
      toolId: assignedTool?.id ?? decision.tool?.name,
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
  const initialConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
    scope: publishedContext.scope,
    latestUtterance: input.latestUtterance,
    evidence: [],
    recentCompleteTurns: state.recentCompleteTurns,
  });
  const common = {
    mainPrompt: input.mainPrompt,
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
  const routed = await routeTemplateEngineUtterance(common, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    tenantBoundaryVerified: true,
    nonFactualResponseAllowed: true,
    assignedToolSchemas: input.assignedTools,
    publishedWorkflows: publishedContext.publishedWorkflows,
    assignedTools: input.assignedTools,
    informationFields: input.informationFields,
    scope: publishedContext.scope,
    ambiguity: { required: true },
  });
  let first = routed.decision;
  let initialValidationResult = routed.outputValidation?.reason ?? 'valid';
  if (first.decision === 'RESPONSE') {
    const directValidation = await dependencies.validateGroundedClaims({
      response: first.response,
      selectedEvidence: Object.freeze([]),
    });
    if (directValidation?.supported !== true) {
      initialValidationResult = directValidation?.reason ?? 'factual_response_requires_search';
      first = Object.freeze({
        decision: 'SEARCH', response: '', clarification: null,
        search: Object.freeze({
          query: cleanText(input.latestUtterance, 2_000),
          requestedFact: null,
          contextualReference: null,
          preferredRecordIds: state.lastReferencedRecordIds,
        }),
        tool: null, nextQuestion: null, stateUpdate: first.stateUpdate,
      });
    }
  }
  if (first.decision === 'TOOL') {
    return runWorkflow(input, first, state, publishedContext, dependencies);
  }
  if (first.decision !== 'SEARCH') {
    const followUpSupported = await followUpClaimsSupported(
      first, [], dependencies.validateGroundedClaims,
    );
    const composed = validateAndComposeTemplateEngineSpeech({
      decision: first,
      recentCompleteTurns: state.recentCompleteTurns,
      conversationGuidance: initialConversationGuidance,
      claimsValidated: followUpSupported,
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

  const retrieval = await dependencies.retrieveEvidence({
    auth: input.auth,
    scope: publishedContext.scope,
    callId: input.callId,
    usageDirection: input.usageDirection,
    language: input.language,
    searchDecision: first,
    state,
    runtimeProfile: input.runtimeProfile,
    preloadedArtifacts: publishedContext.artifacts,
  });
  if (typeof dependencies.onRetrievalDiagnostics === 'function') {
    dependencies.onRetrievalDiagnostics(retrieval.diagnostics ?? Object.freeze({
      channelCounts: Object.freeze({}),
      retrievalCount: 0,
      hydrationCount: 0,
      verifiedEvidenceCount: retrieval.evidence?.length ?? 0,
      failedChannels: Object.freeze([]),
    }));
  }
  const postSearchConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
    scope: publishedContext.scope,
    latestUtterance: input.latestUtterance,
    finalDecision: first.decision,
    searchInterpretation: first.search,
    evidence: retrieval.evidence,
    recentCompleteTurns: state.recentCompleteTurns,
  });
  const answered = await respondToTemplateEngineSearch({
    ...common,
    state,
    searchDecision: first,
    verifiedEvidence: retrieval.evidence,
    scope: retrieval.scope,
    informationUnavailableResponse: input.informationUnavailableResponse,
    conversationGuidance: postSearchConversationGuidance,
  }, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    tenantBoundaryVerified: true,
    publishedEntities: retrieval.evidence,
    ambiguity: { required: true },
    validateGroundedClaims: ({ response, selectedEvidence }) => (
      dependencies.validateGroundedClaims({ response, selectedEvidence })
    ),
    onDecisionRepair: dependencies.onPostSearchDecisionRepair,
    onPostSearchDiagnostics: dependencies.onPostSearchDiagnostics,
  });
  if (answered.decision.decision === 'SEARCH') {
    throw new AppError(502, 'Grounded answer failed validation after one search',
      'TEMPLATE_ENGINE_GROUNDING_REJECTED');
  }
  const followUpSupported = await followUpClaimsSupported(
    answered.decision, retrieval.evidence, dependencies.validateGroundedClaims,
  );
  const composed = validateAndComposeTemplateEngineSpeech({
    decision: answered.decision,
    recentCompleteTurns: state.recentCompleteTurns,
    conversationGuidance: postSearchConversationGuidance,
    suppressFollowUp: templateEngineEvidenceSuppressesFollowUp(retrieval.evidence),
    claimsValidated: followUpSupported,
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
