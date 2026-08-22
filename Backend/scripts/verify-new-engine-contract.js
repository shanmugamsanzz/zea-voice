import assert from 'node:assert/strict';
import {
  KNOWLEDGE_ENGINE_CONTRACT_VERSION,
  createKnowledgeEngineInput,
  createKnowledgeEngineDecision,
  isKnowledgeEngineInput,
  isKnowledgeEngineDecision,
  knowledgeEngineDecisionTypes,
  resolveKnowledgeEngineDecision,
  technicalClarificationDecision,
} from '../src/knowledge-engine/engine-contract.js';

const input = createKnowledgeEngineInput({
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
  utterance: '  What options are available?  ', usageDirection: 'INBOUND', language: 'EN',
  memory: { knownEntities: [], collectedInformation: {} },
});
assert.equal(input.utterance, 'What options are available?');
assert.equal(input.usageDirection, 'inbound');
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
assert.equal(direct.type, knowledgeEngineDecisionTypes.DIRECT);
assert.equal(direct.response.text, source.content);
assert.deepEqual(direct.evidenceIds, [source.id]);
assert.equal(isKnowledgeEngineDecision(direct), true);

const llm = resolveKnowledgeEngineDecision({ evidence: [source], reasoningRequired: true });
assert.equal(llm.type, knowledgeEngineDecisionTypes.LLM);
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

assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.DIRECT, {
  reason: 'unsafe_direct', response: { text: 'Uncited answer' },
}), /authoritative evidence/u);
assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.LLM, {
  reason: 'ungrounded_llm',
}), /published evidence/u);
assert.throws(() => createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.TOOL, {
  reason: 'unauthorized_tool', evidenceIds: [], tool: { name: 'tenant.booking.create' },
}), /Workflow evidence/u);

console.log('Versioned universal knowledge-engine contract verified.');
