import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveConfidenceResponseRoute } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';

const callerMessage = {
  recordId: 'message-1', recordType: 'CONVERSATION_NODE', content: 'Approved response.',
  semanticScore: 0.94, retrievalScore: 0.93,
};
const catalogEvidence = {
  recordId: 'item-1', recordType: 'CATALOG_ITEM', content: 'Complete item facts.',
  semanticScore: 0.9, retrievalScore: 0.89,
};

assert.deepEqual(resolveConfidenceResponseRoute({
  directMessage: callerMessage, evidence: [callerMessage], conflict: { detected: false },
}), {
  outcome: 'direct', reason: 'strong_unambiguous_caller_response',
  confidence: 0.94, evidenceCount: 1,
});

assert.deepEqual(resolveConfidenceResponseRoute({
  evidence: [catalogEvidence], conflict: { detected: false },
}), {
  outcome: 'grounded_llm', reason: 'reasoning_required',
  confidence: 0.9, evidenceCount: 1,
});

const conflicting = resolveConfidenceResponseRoute({
  evidence: [catalogEvidence, { ...catalogEvidence, recordId: 'item-2' }],
  conflict: { detected: true, type: 'conflicting_facts' },
});
assert.equal(conflicting.outcome, 'clarify');
assert.equal(conflicting.reason, 'conflicting_facts');

const weak = resolveConfidenceResponseRoute({
  evidence: [], conflict: { detected: false }, rejectedCandidates: 3,
});
assert.equal(weak.outcome, 'clarify');
assert.equal(weak.reason, 'weak_evidence');

const multipleRelevant = resolveConfidenceResponseRoute({
  evidence: [
    catalogEvidence,
    { ...catalogEvidence, recordId: 'item-2', content: 'Additional relevant facts.' },
  ],
  conflict: { detected: false },
});
assert.equal(multipleRelevant.outcome, 'grounded_llm');
assert.equal(multipleRelevant.evidenceCount, 2);

const orchestrator = readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
const directBranch = orchestrator.indexOf('if (directResponseValidated)');
const clarificationBranch = orchestrator.indexOf("responseRouting.outcome === 'clarify'", directBranch);
const llmBranch = orchestrator.indexOf('response = await this.#llm(query, history, llmKnowledge', clarificationBranch);
assert.ok(directBranch >= 0 && clarificationBranch > directBranch && llmBranch > clarificationBranch);
assert.match(orchestrator.slice(clarificationBranch, llmBranch), /configuredKnowledgeClarification/u);
assert.match(orchestrator, /requireHydratedEvidence:\s*true/u);
assert.doesNotMatch(orchestrator, /responseRouting\.outcome === 'clarify' \|\| responseRouting\.outcome === 'direct'/u);

console.log(JSON.stringify({
  task: 'confidence-response-routing', passed: true,
  outcomes: ['direct', 'grounded_llm', 'clarify'],
  strictHydratedEvidence: true, configuredSafeResponse: true,
}));
