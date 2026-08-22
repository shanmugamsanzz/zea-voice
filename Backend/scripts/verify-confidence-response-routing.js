import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groundedLlmReasoningRequired,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import {
  knowledgeEngineDecisionTypes,
  resolveKnowledgeEngineDecision,
} from '../src/knowledge-engine/engine-contract.js';

const callerMessage = {
  id: 'published:conversation_node:message-1',
  recordId: 'message-1', recordType: 'CONVERSATION_NODE', content: 'Approved response.',
  semanticScore: 0.94, retrievalScore: 0.93,
};
const catalogEvidence = {
  id: 'published:catalog_item:item-1',
  recordId: 'item-1', recordType: 'CATALOG_ITEM', content: 'Complete item facts.',
  semanticScore: 0.9, retrievalScore: 0.89,
};

const directDecision = resolveKnowledgeEngineDecision({
  directResponse: callerMessage, evidence: [callerMessage], conflict: { detected: false },
});
assert.equal(directDecision.type, knowledgeEngineDecisionTypes.DIRECT);
assert.equal(directDecision.reason, 'strong_unambiguous_caller_response');
assert.equal(directDecision.confidence, 0.94);
assert.deepEqual(directDecision.evidenceIds, [callerMessage.id]);

const llmDecision = resolveKnowledgeEngineDecision({
  evidence: [catalogEvidence], conflict: { detected: false },
});
assert.equal(llmDecision.type, knowledgeEngineDecisionTypes.LLM);
assert.equal(llmDecision.reason, 'reasoning_required');
assert.deepEqual(llmDecision.evidenceIds, [catalogEvidence.id]);

const conflicting = resolveKnowledgeEngineDecision({
  evidence: [catalogEvidence, { ...catalogEvidence, id: 'published:catalog_item:item-2', recordId: 'item-2' }],
  conflict: { detected: true, type: 'conflicting_facts' },
});
assert.equal(conflicting.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(conflicting.reason, 'conflicting_facts');

const weak = resolveKnowledgeEngineDecision({
  evidence: [], conflict: { detected: false }, rejectedCandidates: 3,
});
assert.equal(weak.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(weak.reason, 'weak_evidence');

const multipleRelevant = resolveKnowledgeEngineDecision({
  evidence: [
    catalogEvidence,
    { ...catalogEvidence, id: 'published:catalog_item:item-2', recordId: 'item-2', content: 'Additional relevant facts.' },
  ],
  conflict: { detected: false },
});
assert.equal(multipleRelevant.type, knowledgeEngineDecisionTypes.LLM);
assert.equal(multipleRelevant.evidenceIds.length, 2);

const deterministicOnly = resolveKnowledgeEngineDecision({
  evidence: [catalogEvidence], conflict: { detected: false }, reasoningRequired: false,
});
assert.equal(deterministicOnly.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(deterministicOnly.reason, 'deterministic_match_required');

assert.equal(groundedLlmReasoningRequired({
  evidence: [catalogEvidence], directResponse: catalogEvidence,
}), false, 'known single-record requests must bypass the LLM');
assert.equal(groundedLlmReasoningRequired({
  evidence: [catalogEvidence, { ...catalogEvidence, recordId: 'item-2' }],
  explicitCatalogRecordIds: ['item-1', 'item-2'],
}), true, 'comparisons must retain grounded LLM reasoning');
assert.equal(groundedLlmReasoningRequired({
  evidence: [catalogEvidence],
  catalogIdentityResolution: { status: 'uncertain', ambiguous: true },
}), true, 'ambiguous entity requests must retain grounded LLM reasoning');

const orchestrator = readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
const clarificationBranch = orchestrator.indexOf('engineDecision.type === knowledgeEngineDecisionTypes.CLARIFY');
const llmBranch = orchestrator.indexOf('this.#llm(query, history, knowledge', clarificationBranch);
assert.ok(clarificationBranch >= 0 && llmBranch > clarificationBranch);
assert.match(orchestrator.slice(clarificationBranch, llmBranch), /configuredSafeFailureResponse/u);
assert.match(orchestrator, /requireHydratedEvidence:\s*true/u);
assert.doesNotMatch(orchestrator, /if \(directResponseValidated\)/u);
assert.match(orchestrator, /Resolve only the ambiguity, comparison, action, or multi-source question/u);
assert.doesNotMatch(orchestrator, /compatibility_route|responseRouting/u);

console.log(JSON.stringify({
  task: 'confidence-response-routing', passed: true,
  outcomes: Object.values(knowledgeEngineDecisionTypes),
  strictHydratedEvidence: true, configuredSafeResponse: true,
}));
