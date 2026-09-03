import assert from 'node:assert/strict';
import {
  templateEnginePostSearchJsonSchema,
  validateTemplateEnginePostSearchDecision,
} from '../src/voice/interaction/template-engine-post-search-contract.js';
import { respondToTemplateEngineSearch } from '../src/voice/interaction/template-engine-orchestrator.js';

const mainPrompt = 'Use concise natural speech. Explain missing information naturally.';
const latestUtterance = 'What is its current price?';
const state = Object.freeze({
  recentCompleteTurns: Object.freeze([
    Object.freeze({ role: 'user', content: 'Explain the selected service.' }),
    Object.freeze({ role: 'assistant', content: 'Here is the verified explanation.' }),
  ]),
  lastReferencedRecordIds: Object.freeze(['record-1']),
  comparisonRecordIds: Object.freeze([]), pendingClarification: null,
  activeWorkflowId: null, collectedToolFields: Object.freeze({}), confirmationStatus: null,
});
const searchDecision = Object.freeze({
  decision: 'SEARCH', response: '', clarification: null,
  search: Object.freeze({
    query: 'selected service current price', requestedFact: 'price',
    contextualReference: 'selected service', preferredRecordIds: ['record-1'],
  }),
  tool: null, stateUpdate: null,
});
const scope = Object.freeze({
  tenantId: 'tenant-a', agentId: 'agent-a',
  publications: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-a', publicationRevision: 2 }),
  ]),
});
const verifiedEvidence = Object.freeze([
  Object.freeze({
    verified: true, callerFacing: true, evidenceId: 'evidence-1', recordId: 'record-1',
    recordType: 'ITEM', tenantId: 'tenant-a', agentId: 'agent-a',
    knowledgeBaseId: 'kb-a', publicationRevision: 2,
    content: 'The selected service currently costs 3200 currency units.',
  }),
]);

assert.deepEqual(templateEnginePostSearchJsonSchema.properties.decision.enum,
  ['RESPONSE', 'CLARIFY', 'NO_MATCH']);
assert.equal(Object.hasOwn(templateEnginePostSearchJsonSchema.properties, 'tool'), false);
assert.equal(Object.hasOwn(templateEnginePostSearchJsonSchema.properties, 'search'), false);

let calls = 0;
let providerRequest;
const result = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true }),
  invokeStructuredLlm: async (request) => {
    calls += 1;
    providerRequest = request;
    return {
      outputParsed: {
        decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
        clarification: null, evidenceIds: ['evidence-1'], stateUpdate: null,
      },
    };
  },
});
assert.equal(calls, 1);
assert.equal(result.decision.decision, 'RESPONSE');
assert.deepEqual(result.decision.evidenceIds, ['evidence-1']);
assert.equal(result.input.verifiedEvidence.length, 1);
assert.equal(result.input.searchInterpretation.requestedFact, 'price');
assert.match(providerRequest.messages[0].content, /template_engine_post_search_decision|post-search phase/u);
assert.match(providerRequest.messages[0].content, /Explain the selected service/u);
assert.match(providerRequest.messages[0].content, /The selected service currently costs/u);
assert.equal(providerRequest.responseFormat.schema, templateEnginePostSearchJsonSchema);

assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Unsupported.', clarification: null,
  evidenceIds: [], stateUpdate: null,
}, ['evidence-1']).reason, 'mixed_decision_payload');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Wrong citation.', clarification: null,
  evidenceIds: ['unknown'], stateUpdate: null,
}, ['evidence-1']).reason, 'unknown_evidence_id');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'NO_MATCH', response: 'I do not have that information right now.',
  clarification: null, evidenceIds: [], stateUpdate: null,
}, []).valid, true);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'CLARIFY', response: '',
  clarification: { question: 'Which service do you mean?', reason: null, candidates: [] },
  evidenceIds: [], stateUpdate: null,
}, []).valid, true);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'TOOL', response: '', clarification: null,
  evidenceIds: [], stateUpdate: null,
}, []).reason, 'invalid_decision');

await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision,
  verifiedEvidence: [{ ...verifiedEvidence[0], tenantId: 'tenant-b' }], scope,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => { throw new Error('must not be invoked'); },
}), (error) => error.code === 'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_VIOLATION');

console.log('Template-engine post-search Orchestrator verification passed.');
