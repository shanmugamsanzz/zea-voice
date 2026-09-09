import assert from 'node:assert/strict';
import {
  assertSingleLlmTurnArchitecture,
  createSingleLlmTurnInvoker,
  deterministicAcknowledgementDecision,
  deterministicIdentityQuestionDecision,
  deterministicPendingWorkflowFieldDecision,
  deterministicWelcomeContinuation,
  enforceVerifiedFactualArchitecture,
  runTemplateEngineProductionTurn,
} from '../src/voice/interaction/template-engine-production-runtime.js';
import { assertVerifiedFactualStageArchitecture } from '../src/voice/interaction/template-engine-turn-timing.js';
import { welcomeContinuationContext } from '../src/voice/interaction/template-engine-conversation-guidance.js';

let providerCalls = 0;
const guarded = createSingleLlmTurnInvoker(async () => {
  providerCalls += 1;
  return { outputParsed: { decision: 'RESPONSE' } };
});
const request = Object.freeze({ responseFormat: Object.freeze({
  type: 'json_schema', name: 'template_engine_post_search_decision',
}) });
await guarded.invoke(request);
await assert.rejects(() => guarded.invoke(request), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.equal(providerCalls, 1);
assert.equal(guarded.count(), 1);

assert.deepEqual(assertSingleLlmTurnArchitecture({
  invocationCount: 0, turnKind: 'conversational_control',
}), {
  enforced: true, invocationCount: 0, maximumInvocations: 1,
  exactlyOneRequired: false, turnKind: 'conversational_control',
});
assert.equal(assertSingleLlmTurnArchitecture({
  invocationCount: 1, requireExactlyOne: true, turnKind: 'factual',
}).invocationCount, 1);
assert.throws(() => assertSingleLlmTurnArchitecture({ invocationCount: 2 }), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.throws(() => assertSingleLlmTurnArchitecture({
  invocationCount: 0, requireExactlyOne: true, turnKind: 'factual',
}), { code: 'TEMPLATE_ENGINE_ARCHITECTURE_VIOLATION' });

const architecture = enforceVerifiedFactualArchitecture({
  deterministicAnswerPath: true,
  answered: {
    decision: { decision: 'RESPONSE' },
    diagnostics: { verifiedAnswerFastPath: true, answerGenerationCalls: 1 },
  },
});
assert.equal(architecture.path, 'verified_factual_one_llm');
assert.deepEqual(architecture.stages, [
  'deterministic_resolution', 'focused_retrieval', 'grounded_answer_generation',
  'deterministic_validation', 'tts_ready',
]);

const measured = assertVerifiedFactualStageArchitecture({
  architecture,
  stageTimings: {
    publication: { operations: { publication_load: { calls: 1 } } },
    retrieval: { operations: { retrieval: { calls: 1 } } },
    generation: { operations: { answer_generation: { calls: 1 } } },
  },
});
assert.equal(measured.calls.answerGeneration, 1);
assert.equal(measured.calls.otherLlm, 0);

const acknowledgement = deterministicAcknowledgementDecision({
  utterance: 'சொல்லுங்க Madam.', acknowledgementPhrases: [],
});
assert.equal(acknowledgement.decision, 'RESPONSE');
assert.match(acknowledgement.response, /சொல்லுங்க/u);

const identity = deterministicIdentityQuestionDecision({
  utterance: 'எங்கிருந்து பேசுறீங்க?',
  runtimeProfile: { agent: { name: 'Configured Care Team' } },
});
assert.equal(identity.decision, 'RESPONSE');
assert.match(identity.response, /Configured Care Team/u);
assert.equal(deterministicPendingWorkflowFieldDecision({
  pendingFieldKey: 'patient_name', awaitingConfirmation: false,
  interruptedRequest: null, toolName: 'create_booking', collectedFields: {},
  fields: [{ key: 'patient_name', type: 'string', question: 'What is the patient name?' }],
}, 'எங்கிருந்து பேசுறீங்க?', { excludedPhrases: [] }), null,
'An identity question must not be captured as a pending text field');

const scope = {
  tenantId: 'tenant-a', agentId: 'agent-a',
  publications: [{ knowledgeBaseId: 'kb-a', publicationRevision: 4 }],
};
const overviewGuidance = {
  recordId: 'welcome-overview', recordType: 'CONVERSATION_NODE',
  tenantId: scope.tenantId, agentId: scope.agentId,
  knowledgeBaseId: 'kb-a', publicationRevision: 4, published: true,
  isEntry: true, nodeKey: 'package_overview', intentClass: 'overview',
  purpose: 'Present the published options overview.',
  content: 'Published overview', catalogReferences: ['category: published-options'],
  examples: [], applicableRoutes: [], configuredStages: [],
};
const continuationContext = welcomeContinuationContext({
  pendingQuestion: null, latestUtterance: 'சொல்லுங்க Madam.',
  publishedConversationGuidance: [overviewGuidance], scope,
  recentCompleteTurns: [{ role: 'assistant', content: 'Configured welcome.' }],
});
assert.equal(continuationContext.candidates.length, 1);
assert.equal(deterministicWelcomeContinuation({
  latestUtterance: 'சொல்லுங்க Madam.', welcomeContinuation: continuationContext,
  acknowledgementPhrases: [],
})?.kind, 'published_welcome_continuation');

let identityRetrievals = 0;
let identityLlmCalls = 0;
const identityTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId: scope.tenantId }, scope, callId: 'identity-turn',
  usageDirection: 'inbound', language: 'ta', mainPrompt: 'Configured prompt.',
  latestUtterance: 'எங்கிருந்து பேசுறீங்க?', conversationHistory: [],
  state: {}, assignedTools: [], informationFields: [],
  runtimeProfile: { agent: { name: 'Configured Care Team' } },
}, {
  invokeStructuredLlm: async () => { identityLlmCalls += 1; throw new Error('unexpected LLM'); },
  loadPublishedContext: async () => ({
    scope, artifacts: { bundles: [] }, publicationIndex: null,
    publishedWorkflows: [], publishedConversationGuidance: [],
  }),
  retrieveEvidence: async () => { identityRetrievals += 1; throw new Error('unexpected retrieval'); },
  persistWorkflowState: async () => {}, executeAuthorizedTool: async () => {},
});
assert.equal(identityTurn.decision.decision, 'RESPONSE');
assert.equal(identityTurn.llmInvocationCount, 0);
assert.equal(identityRetrievals, 0);
assert.equal(identityLlmCalls, 0);

console.log(JSON.stringify({
  suite: 'template-engine-production-runtime', passed: true,
  deterministicResolution: true, focusedRetrieval: true,
  maximumLlmCallsPerTurn: 1, deterministicValidation: true,
}));
