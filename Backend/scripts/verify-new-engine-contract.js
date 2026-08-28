import assert from 'node:assert/strict';
import {
  KNOWLEDGE_ENGINE_CONTRACT_VERSION,
  createKnowledgeEngineInput,
  createKnowledgeEngineDecision,
  isKnowledgeEngineInput,
  isKnowledgeEngineDecision,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
  resolveKnowledgeEngineDecision,
  technicalClarificationDecision,
} from '../src/knowledge-engine/engine-contract.js';

const input = createKnowledgeEngineInput({
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
  utterance: '  What options are available?  ', usageDirection: 'INBOUND', language: 'EN',
  requestedFacts: ['price'], contextualReferences: ['this'],
  recentRelevantTurns: Array.from({ length: 6 }, (_value, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `turn ${index + 1}`,
  })),
  memory: {
    activeEntity: { recordId: 'catalog-one', itemKey: 'one', name: 'Option One' },
    knownEntities: [], collectedInformation: {},
  },
});
assert.equal(input.utterance, 'What options are available?');
assert.equal(input.latestQuestion, input.utterance);
assert.equal(input.usageDirection, 'inbound');
assert.equal(input.requestedFact, 'price');
assert.deepEqual(input.contextualReferences, ['this']);
assert.equal(input.recentRelevantTurns.length, 6);
assert.equal(input.canonicalCallMemory.activeEntity.recordId, 'catalog-one');
assert.equal(input.memory, input.canonicalCallMemory);
assert.equal(isKnowledgeEngineInput(input), true);
assert.throws(() => createKnowledgeEngineInput({
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a', utterance: '   ',
}), /finalized utterance/u);

const source = Object.freeze({
  id: 'published:faq:one', recordId: 'one', recordType: 'FAQ',
  content: 'Approved tenant answer', semanticScore: 0.94,
});

const direct = resolveKnowledgeEngineDecision({ directResponse: source, evidence: [source] });
assert.equal(direct.contractVersion, KNOWLEDGE_ENGINE_CONTRACT_VERSION);
assert.equal(direct.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(direct.mode, knowledgeEngineResponseModes.DETERMINISTIC);
assert.equal(direct.response.text, source.content);
assert.deepEqual(direct.evidenceIds, [source.id]);
assert.equal(isKnowledgeEngineDecision(direct), true);

const llm = resolveKnowledgeEngineDecision({ evidence: [source], reasoningRequired: true });
assert.equal(llm.type, knowledgeEngineDecisionTypes.RESPONSE);
assert.equal(llm.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
assert.deepEqual(llm.evidenceIds, [source.id]);

const clarify = resolveKnowledgeEngineDecision({ evidence: [], rejectedCandidates: 2 });
assert.equal(clarify.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(clarify.clarification.kind, 'ambiguity');

const technical = technicalClarificationDecision('knowledge_timeout');
assert.equal(technical.type, knowledgeEngineDecisionTypes.CLARIFY);
assert.equal(technical.clarification.kind, 'technical');

const workflowEvidenceId = 'published:workflow_rule:book';
const tool = createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.TOOL, {
  reason: 'authorized_tool_request', evidenceIds: [workflowEvidenceId],
  tool: { name: 'tenant.booking.create', authorizationEvidenceId: workflowEvidenceId, input: {} },
});
assert.equal(tool.type, knowledgeEngineDecisionTypes.TOOL);
assert.equal(isKnowledgeEngineDecision(tool), true);

assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
  reason: 'unsafe_response', mode: knowledgeEngineResponseModes.DETERMINISTIC,
  response: { text: 'Uncited answer' },
}), /authoritative evidence/u);
assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
  reason: 'ungrounded_llm', mode: knowledgeEngineResponseModes.GROUNDED_LLM,
}), /authoritative evidence/u);
assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.TOOL, {
  reason: 'unauthorized_tool', evidenceIds: [], tool: { name: 'tenant.booking.create' },
}), /Workflow evidence/u);

console.log('Versioned universal knowledge-engine contract verified.');
