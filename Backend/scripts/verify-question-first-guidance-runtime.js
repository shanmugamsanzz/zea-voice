import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentRuntimeResponseSchema } from '../src/agents/agent-runtime.schemas.js';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { searchPublishedKnowledge } from '../src/knowledge-bases/knowledge-runtime.service.js';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';

function extraction(text) {
  const lines = text.trim().split(/\r?\n/u);
  return { fullText: lines.join('\n'), pages: [{ pageNumber: 1, lines }] };
}

const workflow = processExtractedCategory('workflow_rules', extraction(`
RULE: configured_operation
MATCH: a natural example supplied by the tenant
MATCH_MODE: any_phrase
RESPONSE_MODE: instruction
FROM_STAGE: legacy_position
NEXT_STAGE: another_position
ACTION: configured_operation
RESPONSE: Use the configured operation after authorization.
`));
assert.equal(workflow.recordCount, 1);
assert.equal(workflow.records[0].conditions.fromStages, undefined);
assert.equal(workflow.records[0].actionConfig.nextStage, undefined);

const conversation = processExtractedCategory('conversation_script', extraction(`
STAGE: guidance_label
TYPE: guidance
RESPONSE: Answer the latest caller question first and continue naturally.
NEXT_STAGE: legacy_position
`));
assert.equal(conversation.recordCount, 1);
assert.deepEqual(conversation.records[0].transitions, []);
assert.doesNotMatch(conversation.records[0].content, /legacy_position/u);

const memory = openLiveCallMemory({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, {}, Date.now(), {});
memory.observeAssistantResponse('Which option would you like?');
memory.activateAction('configured_operation');
memory.applyGroundedDecision({
  intent: 'answer latest question', questionType: 'side_question', currentTopic: 'new topic',
  topicChanged: true, pendingQuestionRelevant: true, flowAction: 'side_question', selectedEntities: [],
});
assert.equal(
  memory.prepareAssistantResponse('Here is the answer to your latest question.'),
  'Here is the answer to your latest question. Which option would you like?',
);
assert.equal(memory.snapshot().activeActions.includes('configured_operation'), true);

memory.observeAssistantResponse('Which date works for you?');
memory.applyGroundedDecision({
  intent: 'change topic', questionType: 'details', currentTopic: 'different topic',
  topicChanged: true, pendingQuestionRelevant: false, flowAction: 'answer_latest', selectedEntities: [],
});
assert.equal(memory.prepareAssistantResponse('Here are the requested details.'), 'Here are the requested details.');
for (const removed of ['currentStage', 'conversationStage', 'resumeStage', 'stageTransitions']) {
  assert.equal(Object.hasOwn(memory.snapshot(), removed), false);
}

assert.equal(agentRuntimeResponseSchema.safeParse({
  event: 'user_message', query: 'unrestricted natural question', usageDirection: 'inbound',
  language: 'ta', history: [], context: {},
}).success, true);
assert.equal(agentRuntimeResponseSchema.safeParse({
  event: 'user_message', query: 'unrestricted natural question', usageDirection: 'inbound',
  routeHint: 'workflow', history: [], context: {},
}).success, false);

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
const profile = {
  agent_usage: 'inbound', agent_settings: {},
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 2, priority: 1, semanticReady: true }],
  catalog_items: [], conversations: [], faqs: [], general_knowledge: [],
  workflows: [{
    id: recordId, knowledge_base_id: knowledgeBaseId,
    document_id: '55555555-5555-4555-8555-555555555555',
    document_version_id: '66666666-6666-4666-8666-666666666666',
    document_name: 'workflow.txt', source_page_start: 1, source_page_end: 1,
    name: 'configured_operation', intent: 'configured_operation', priority: 1,
    conditions: { fromStages: ['blocked_position'] }, action_type: 'webhook',
    action_config: { responseMode: 'instruction', actionKey: 'configured_operation', nextStage: 'later' },
    response_template: 'Internal guidance.',
  }],
};
const result = await searchPublishedKnowledge({ tenantId }, {
  agentId, query: 'a caller phrasing not present in the document',
  usageDirection: 'inbound', language: 'en',
}, {
  ragEnabled: true,
  contextRunner: async (_auth, callback) => callback({
    query: async (sql, values) => {
      if (!String(sql).includes('jsonb_to_recordset')) return { rows: [structuredClone(profile)] };
      const requested = JSON.parse(values[3]);
      return { rows: requested.filter((item) => item.record_id === recordId).map((item) => ({
        record_type: 'WORKFLOW_RULE', record_id: recordId, knowledge_base_id: knowledgeBaseId,
        document_id: profile.workflows[0].document_id,
        document_version_id: profile.workflows[0].document_version_id,
        document_name: 'workflow.txt', source_page_start: 1, source_page_end: 1,
        language: 'en', content: 'Internal guidance.', caller_facing: false,
        authoritative_data: {
          name: 'configured_operation', intent: 'configured_operation', priority: 1,
          conditions: {}, actionType: 'webhook',
          actionConfig: { responseMode: 'instruction', actionKey: 'configured_operation' },
        }, rank: item.rank, score: item.score,
      })) };
    },
  }),
  embed: async (query) => {
    assert.match(query, /caller phrasing/u);
    return [0.1];
  },
  search: async () => [{
    id: recordId, score: 0.93,
    payload: {
      tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 2,
      agent_usage: 'INBOUND', assigned_agent_ids: [agentId], record_id: recordId,
      record_type: 'WORKFLOW_RULE',
    },
  }],
  cache: { status: 'ready', get: async () => null, set: async () => 'OK' },
});
assert.equal(result.actionEvidence.length, 1);
assert.equal(result.actionEvidence[0].authoritativeData.conditions.fromStages, undefined);
assert.equal(result.actionEvidence[0].authoritativeData.actionConfig.nextStage, undefined);

const activeSources = await Promise.all([
  '../src/agents/agent-runtime.schemas.js',
  '../src/agents/agent-runtime.service.js',
  '../src/voice/interaction/live-call-memory.js',
  '../src/voice/realtime-conversation-orchestrator.js',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
for (const source of activeSources) {
  assert.doesNotMatch(source, /conversationInitialStage|workflowStageGate|routeHint|currentStage|resumeStage/u);
}

memory.close();
console.log('Question-first guidance runtime verification passed.');
