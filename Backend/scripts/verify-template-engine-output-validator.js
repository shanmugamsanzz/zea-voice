import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateTemplateEngineOutput,
  validateTemplateEngineToolResultSpeech,
} from '../src/voice/interaction/template-engine-output-validator.js';
import {
  templateEngineClaimValidationJsonSchema,
  validateTemplateEngineClaims,
  validateTemplateEngineSearchClaims,
} from '../src/voice/interaction/template-engine-claim-validator.js';
import { respondToTemplateEngineSearch } from '../src/voice/interaction/template-engine-orchestrator.js';

const response = (text, evidenceIds = []) => ({
  decision: 'RESPONSE', response: text, clarification: null,
  evidenceIds, nextQuestion: null, stateUpdate: null,
});
const firstResponse = (text) => ({
  decision: 'RESPONSE', response: text, clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
});
const clarify = (question, candidates) => ({
  decision: 'CLARIFY', response: '',
  clarification: { question, reason: 'ambiguous reference', candidates },
  evidenceIds: [], nextQuestion: null, stateUpdate: null,
});

const evidence = [{
  verified: true, callerFacing: true, evidenceId: 'e-1', recordId: 'r-1',
  recordType: 'ITEM', tenantId: 'tenant-a', agentId: 'agent-a',
  knowledgeBaseId: 'kb-a', publicationRevision: 7,
  canonicalName: 'Service Alpha', aliases: ['Alpha'],
  requestedFact: 'price',
  publishedAttributePaths: ['price'],
  authoritativeData: { price: 3200, includedFeature: 'Delta' },
  content: 'Service Alpha costs 3200 units and includes feature Delta.',
}];
const entities = [{ recordId: 'r-1', canonicalName: 'Service Alpha', aliases: ['Alpha'] }];
const comparisonEvidence = [evidence[0], {
  verified: true, callerFacing: true, evidenceId: 'e-2', recordId: 'r-2',
  recordType: 'ITEM', tenantId: 'tenant-a', agentId: 'agent-a',
  knowledgeBaseId: 'kb-a', publicationRevision: 7,
  canonicalName: 'Service Beta', aliases: ['Beta'],
  content: 'Service Beta costs 4100 units and includes feature Omega.',
}];
const comparisonEntities = [
  ...entities,
  { recordId: 'r-2', canonicalName: 'Service Beta', aliases: ['Beta'] },
];

let result = validateTemplateEngineOutput({
  decision: firstResponse('Hello, how can I help?'),
  nonFactualResponseAllowed: true,
});
assert.equal(result.valid, true);
assert.equal(result.ttsAllowed, true);

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Alpha costs 3200 units.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence, publishedEntities: entities,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
  searchInterpretation: { requestedFact: 'price' },
});
assert.equal(result.valid, true);
assert.equal(result.route, 'TTS');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Alpha costs 3200 units.'),
  factualClaimsPresent: true, selectedEvidence: evidence, publishedEntities: entities,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
  searchInterpretation: { requestedFact: 'price' },
});
assert.equal(result.valid, false);
assert.equal(result.reason, 'mixed_decision_payload');
assert.equal(result.retrySearch, true);

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Beta costs 3200 units.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence,
  publishedEntities: comparisonEntities,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.valid, false);
assert.equal(result.reason, 'unsupported_entity_claim');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Alpha has an unpublished attribute.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence, publishedEntities: entities,
  semanticClaimValidation: { supported: false, requestedFactAddressed: false },
});
assert.equal(result.valid, false);
assert.equal(result.reason, 'unsupported_factual_claim');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Alpha costs 3200 units.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence, publishedEntities: entities,
  semanticClaimValidation: { supported: true, requestedFactAddressed: false },
  searchInterpretation: { requestedFact: 'included feature' },
});
assert.equal(result.valid, false,
  'A supported statement about another attribute must not satisfy the requested fact');
assert.equal(result.reason, 'requested_fact_not_addressed');
assert.equal(result.retrySearch, true);

assert.equal(
  templateEngineClaimValidationJsonSchema.required.includes('requestedFactAddressed'),
  true,
);
let claimValidationRequest;
const relevanceValidation = await validateTemplateEngineClaims({
  speech: 'Service Alpha costs 3200 units.',
  evidence,
  decision: 'RESPONSE',
  searchInterpretation: { requestedFact: 'included feature' },
  latestUtterance: 'Which feature is included?',
}, {
  invokeStructuredLlm: async (request) => {
    claimValidationRequest = request;
    return { outputParsed: {
      supported: true,
      successClaimed: false,
      requestedFactAddressed: false,
      reason: 'requested_fact_not_addressed',
    } };
  },
});
assert.equal(relevanceValidation.supported, true);
assert.equal(relevanceValidation.requestedFactAddressed, false);
assert.match(claimValidationRequest.messages[0].content, /included feature/u);
assert.match(claimValidationRequest.messages[0].content,
  /Non-factual conversational speech.+may be supported without published evidence/u);
assert.match(claimValidationRequest.messages[0].content,
  /tenant or business fact.+unsupported when no published evidence is supplied/u);

const deterministicPrice = validateTemplateEngineSearchClaims({
  speech: 'Service Alpha costs 3200 units.', evidence,
  decision: 'RESPONSE', searchInterpretation: { requestedFact: 'price' },
});
assert.equal(deterministicPrice.supported, true);
assert.equal(deterministicPrice.requestedFactAddressed, true);
const deterministicWrongFact = validateTemplateEngineSearchClaims({
  speech: 'Service Alpha costs 3200 units.', evidence,
  decision: 'RESPONSE', searchInterpretation: { requestedFact: 'included feature' },
});
assert.equal(deterministicWrongFact.supported, true);
assert.equal(deterministicWrongFact.requestedFactAddressed, false,
  'Deterministic requested-fact validation must reject a price-only answer to a detail request');

result = validateTemplateEngineOutput({
  phase: 'post_search',
  decision: response(
    'Service Alpha costs 3200 units while Service Beta costs 4100 units.',
    ['e-1', 'e-2'],
  ),
  factualClaimsPresent: true,
  selectedEvidence: comparisonEvidence,
  publishedEntities: comparisonEntities,
  semanticClaimValidation: { supported: true },
});
assert.equal(result.valid, true,
  'A comparison supported across the complete cited record set must not be rejected');

for (const [decision, reason] of [
  [response('Service Alpha costs 9900 units.', ['e-1']), 'unsupported_numeric_claim'],
  [response('Service Alpha costs 3200 units.', ['missing']), 'unknown_evidence_id'],
  [response('{"decision":"RESPONSE"}', ['e-1']), 'internal_or_json_speech'],
]) {
  result = validateTemplateEngineOutput({
    phase: 'post_search', decision, factualClaimsPresent: true,
    selectedEvidence: evidence, publishedEntities: entities,
    semanticClaimValidation: { supported: true },
  });
  assert.equal(result.valid, false);
  assert.equal(result.ttsAllowed, false);
  assert.equal(result.retrySearch, true);
  assert.equal(result.reason, reason);
}

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Beta costs 3200 units.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence,
  claimedNames: ['Service Beta'], retryCount: 1,
  semanticClaimValidation: { supported: true },
});
assert.equal(result.valid, false);
assert.equal(result.retrySearch, false);
assert.equal(result.route, 'REJECT');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Service Alpha includes feature Delta.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence,
});
assert.equal(result.reason, 'grounding_validation_missing');
assert.equal(result.retrySearch, true);

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Did you mean Alpha or Beta?', ['Alpha', 'Beta']),
  ambiguity: { required: true, kind: 'entity', candidates: ['Alpha', 'Beta'] },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true },
});
assert.equal(result.valid, true);
assert.equal(result.ttsAllowed, true);

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Did you mean Alpha?', ['Alpha']),
  ambiguity: { required: true, kind: 'entity', candidates: ['Alpha'] },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.reason, 'clarification_candidates_required',
  'A single possible record must never be treated as genuine ambiguity');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Did you mean Alpha?', ['Alpha']),
  ambiguity: {
    required: true, kind: 'published_entity_confirmation', candidates: ['Alpha'],
  },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.valid, true,
  'One non-strong published match may be confirmed without inventing alternatives');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Which configured option did you mean?', []),
  ambiguity: { required: true, kind: 'unresolved_published_entity', candidates: [] },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.valid, true,
  'No credible published match must allow a candidate-free neutral clarification');

result = validateTemplateEngineOutput({
  phase: 'post_search',
  decision: {
    decision: 'NO_MATCH', response: 'That information is unavailable.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  },
  ambiguity: { required: true, kind: 'unresolved_published_entity', candidates: [] },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.reason, 'clarification_required_for_entity_resolution');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: response('Alpha is configured.', ['e-1']),
  factualClaimsPresent: true, selectedEvidence: evidence,
  ambiguity: {
    required: true, kind: 'published_entity_candidates', candidates: ['Alpha', 'Beta'],
  },
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.reason, 'clarification_required_for_entity_resolution',
  'A factual answer must not choose arbitrarily among genuine published matches');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Which one? Should I continue?', ['Alpha', 'Beta']),
  ambiguity: { required: true, kind: 'entity', candidates: ['Alpha', 'Beta'] },
});
assert.equal(result.reason, 'multiple_clarification_questions');
assert.equal(result.ttsAllowed, false);

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Did you mean Alpha or Gamma?', ['Alpha', 'Gamma']),
  ambiguity: { required: true, kind: 'entity', candidates: ['Alpha', 'Beta'] },
});
assert.equal(result.reason, 'invented_clarification_candidate');

result = validateTemplateEngineOutput({
  phase: 'post_search', decision: clarify('Did you mean Alpha or Beta?', ['Alpha', 'Beta']),
  ambiguity: { required: true, kind: 'entity', candidates: ['Alpha', 'Beta'] },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: false },
  factualClaimsPresent: true,
});
assert.equal(result.reason, 'irrelevant_or_unsupported_clarification');
assert.equal(result.ttsAllowed, false);

result = validateTemplateEngineOutput({
  phase: 'post_search',
  decision: {
    decision: 'NO_MATCH', response: 'That attribute is not required.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: false },
  factualClaimsPresent: true,
});
assert.equal(result.reason, 'unsupported_no_match_claim');
assert.equal(result.ttsAllowed, false);

result = validateTemplateEngineOutput({
  phase: 'post_search',
  decision: {
    decision: 'NO_MATCH', response: 'The published information does not provide that detail.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  },
  claimValidationRequired: true,
  semanticClaimValidation: { supported: true },
  factualClaimsPresent: true,
});
assert.equal(result.valid, true);
assert.equal(result.ttsAllowed, true);

const scope = {
  tenantId: 'tenant-a', agentId: 'agent-a',
  publications: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
};
const workflow = {
  recordId: 'w-1', recordType: 'WORKFLOW_RULE', tenantId: 'tenant-a',
  knowledgeBaseId: 'kb-a', publicationRevision: 7, published: true,
  actionConfig: { toolIdentifier: 'configured_action' },
};
const tool = {
  name: 'configured_action', status: 'active',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['field_one'],
    properties: { field_one: { type: 'string', minLength: 1 } },
  },
};
const informationFields = [{
  key: 'field_one', label: 'Field one', question: 'Please provide field one.',
  type: 'text', requiredAction: 'configured_action',
}];
const toolDecision = {
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'configured_action', arguments: {} }, nextQuestion: null, stateUpdate: null,
};
const toolInput = {
  decision: toolDecision, state: {}, publishedWorkflows: [workflow], assignedTools: [tool],
  informationFields, scope,
};
result = validateTemplateEngineOutput(toolInput);
assert.equal(result.valid, true);
assert.equal(result.route, 'WORKFLOW');
assert.equal(result.ttsAllowed, false);

result = validateTemplateEngineOutput({ ...toolInput, toolExecutionRequested: true });
assert.equal(result.reason, 'tool_execution_not_ready');
result = validateTemplateEngineOutput({
  ...toolInput,
  state: {
    activeWorkflowId: 'w-1', collectedToolFields: { field_one: 'value' },
    confirmationStatus: 'awaiting_confirmation',
  },
  toolExecutionRequested: true,
  confirmation: { accepted: true, explicit: true },
});
assert.equal(result.valid, true);
assert.equal(result.route, 'EXECUTE_TOOL');

result = validateTemplateEngineOutput({
  ...toolInput, assignedTools: [{ ...tool, status: 'inactive' }],
});
assert.equal(result.valid, false);
assert.equal(result.ttsAllowed, false);

result = validateTemplateEngineToolResultSpeech({
  speech: 'Completed with reference 42.',
  verifiedResult: { verified: true, success: true, output: { reference: 42 } },
  semanticClaimValidation: { supported: true },
});
assert.equal(result.valid, true);
result = validateTemplateEngineToolResultSpeech({
  speech: 'The action succeeded.', successIndicators: ['succeeded'],
  verifiedResult: { verified: true, success: false, error: { code: 'timeout' } },
  semanticClaimValidation: { supported: true },
});
assert.equal(result.reason, 'success_claim_after_failed_tool');
result = validateTemplateEngineToolResultSpeech({
  speech: 'The configured action is now done.',
  verifiedResult: { verified: true, success: false, error: { code: 'declined' } },
  semanticClaimValidation: { supported: true, successClaimed: true },
});
assert.equal(result.reason, 'success_claim_after_failed_tool');
result = validateTemplateEngineToolResultSpeech({
  speech: 'Completed.', verifiedResult: { verified: false, success: true },
  semanticClaimValidation: { supported: true },
});
assert.equal(result.reason, 'tool_result_unverified');

let invalidGroundingCalls = 0;
const invalidGroundingRecovery = await respondToTemplateEngineSearch({
  mainPrompt: 'Use evidence for facts.', latestUtterance: 'What is the price?',
  state: {
    recentCompleteTurns: [], lastReferencedRecordIds: ['r-1'], comparisonRecordIds: [],
    pendingClarification: null, activeWorkflowId: null, collectedToolFields: {},
    confirmationStatus: null,
  },
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'Service Alpha price', requestedFact: 'price',
      contextualReference: 'Service Alpha', preferredRecordIds: ['r-1'],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: evidence, scope,
  informationUnavailableResponse: 'That information is not available.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true }),
  invokeStructuredLlm: async () => {
    invalidGroundingCalls += 1;
    return { outputParsed: response('Service Alpha costs 9999 units.', ['E1']) };
  },
});
assert.equal(invalidGroundingCalls, 2);
assert.equal(invalidGroundingRecovery.decision.decision, 'RESPONSE');
assert.doesNotMatch(invalidGroundingRecovery.decision.response, /9999/u,
  'Repeated unsupported output must recover from verified evidence, not reach technical fallback');
assert.deepEqual(invalidGroundingRecovery.decision.evidenceIds, ['e-1']);

result = validateTemplateEngineOutput({
  phase: 'post_search', factualClaimsPresent: true, claimValidationRequired: true,
  decision: response('Service Alpha and Service Beta are configured.', ['e-1']),
  selectedEvidence: comparisonEvidence,
  requiredEvidenceRecordIds: ['r-1', 'r-2'],
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.reason, 'comparison_requires_exact_requested_records');

result = validateTemplateEngineOutput({
  phase: 'post_search', factualClaimsPresent: true, claimValidationRequired: true,
  decision: {
    decision: 'NO_MATCH', response: 'That published detail is unavailable.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  },
  selectedEvidence: evidence,
  requestedFactAvailable: true,
  semanticClaimValidation: { supported: true, requestedFactAddressed: true },
});
assert.equal(result.reason, 'no_match_rejected_when_requested_fact_is_available');

let citedRecoveryCalls = 0;
const citedRecovery = await respondToTemplateEngineSearch({
  mainPrompt: 'Use supplied published evidence.', latestUtterance: 'What is the price?',
  state: {
    recentCompleteTurns: [], lastReferencedRecordIds: ['r-1'], comparisonRecordIds: [],
    pendingClarification: null, activeWorkflowId: null, collectedToolFields: {},
    confirmationStatus: null,
  },
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'Service Alpha price', requestedFact: 'price',
      contextualReference: 'Service Alpha', preferredRecordIds: ['r-1'],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: evidence, scope,
  informationUnavailableResponse: 'That information is not published.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({
    supported: true, requestedFactAddressed: true, successClaimed: false,
  }),
  invokeStructuredLlm: async () => {
    citedRecoveryCalls += 1;
    return { outputParsed: response('Service Alpha costs 3200 units.', ['E9']) };
  },
});
assert.equal(citedRecoveryCalls, 2, 'Invalid citations receive exactly one model repair');
assert.equal(citedRecovery.decision.decision, 'RESPONSE');
assert.deepEqual(citedRecovery.decision.evidenceIds, ['e-1']);
assert.equal(citedRecovery.decision.response, evidence[0].content);
assert.equal(citedRecovery.diagnostics.extractiveRecoveryApplied, true);

const sources = [
  '../src/voice/interaction/template-engine-output-validator.js',
  '../src/voice/interaction/template-engine-tool-result-validator.js',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8').toLocaleLowerCase()).join('\n');
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(sources.includes(forbidden), false, `Validator contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine grounding and output validator verification passed.');
