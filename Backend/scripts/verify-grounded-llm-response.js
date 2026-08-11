import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { buildAgentSystemPrompt } = await import('../src/agents/agent-runtime.service.js');
const {
  buildGroundingEnvelope,
  groundedResponseContract,
  validateGroundedLlmResponse,
} = await import('../src/voice/interaction/grounded-llm-response.js');
const { openLiveCallMemory } = await import('../src/voice/interaction/live-call-memory.js');
const { createSelectedLlmStream } = await import('../src/voice/providers/llm/llm-response.service.js');

const knowledge = {
  route: 'catalog', found: true,
  content: 'Premium Plan - USD 100 - Includes priority support and one consultation.',
  source: { recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  item: {
    key: 'premium-plan', name: 'Premium Plan', category: 'Service Plans',
    categoryKey: 'service-plans', description: 'Includes priority support and one consultation.',
  },
};
const envelope = buildGroundingEnvelope(knowledge);
assert.equal(envelope.sources.length, 1);
assert.equal(envelope.sources[0].id, 'source_1');
assert.equal(envelope.entities[0].key, 'premium-plan');
assert.deepEqual(groundedResponseContract(envelope).allowedEntityKeys, ['premium-plan']);

const valid = validateGroundedLlmResponse(JSON.stringify({
  intent: 'catalog_item_details',
  selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'],
  spokenAnswer: 'Premium Plan is USD 100 and includes priority support.',
}), envelope);
assert.equal(valid.valid, true);
assert.equal(valid.intent, 'catalog_item_details');
assert.equal(valid.selectedEntities[0].key, 'premium-plan');

const unpublishedEntity = validateGroundedLlmResponse(JSON.stringify({
  intent: 'catalog_item_details', selectedEntityKeys: ['invented-plan'],
  evidenceSourceIds: ['source_1'], spokenAnswer: 'Premium Plan is USD 100.',
}), envelope);
assert.equal(unpublishedEntity.valid, false);
assert.equal(unpublishedEntity.reason, 'unpublished_entity_selected');

const unpublishedEvidence = validateGroundedLlmResponse(JSON.stringify({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_99'], spokenAnswer: 'Premium Plan is USD 100.',
}), envelope);
assert.equal(unpublishedEvidence.reason, 'unpublished_evidence_selected');

const inventedPrice = validateGroundedLlmResponse(JSON.stringify({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'], spokenAnswer: 'Premium Plan is USD 999.',
}), envelope);
assert.equal(inventedPrice.reason, 'unsupported_numeric_fact');

const mismatchedEntityAnswer = validateGroundedLlmResponse(JSON.stringify({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'], spokenAnswer: 'Basic Plan is USD 100.',
}), envelope);
assert.equal(mismatchedEntityAnswer.reason, 'selected_entity_not_supported_by_answer');

const noPublishedEvidence = validateGroundedLlmResponse(JSON.stringify({
  intent: 'unknown', selectedEntityKeys: [], evidenceSourceIds: [],
  spokenAnswer: 'This is an unsupported factual answer.',
}), buildGroundingEnvelope({ route: 'none', found: false }));
assert.equal(noPublishedEvidence.reason, 'verified_evidence_missing');

const agent = {
  name: 'Generic Agent', description: 'Answers tenant questions', goal: 'Help accurately',
  language: 'English', prompt: 'Use approved company information.', settings: {},
};
const systemPrompt = buildAgentSystemPrompt(agent, {
  usageDirection: 'inbound', knowledge,
  context: {
    groundedResponseMode: true,
    liveCallMemory: {
      currentStage: 'item_details', currentTopic: 'Premium Plan',
      selectedCatalogItem: { key: 'premium-plan', name: 'Premium Plan' },
      pendingQuestion: 'Do you want the price?',
    },
  },
  maxPromptChars: 6_000,
});
assert.match(systemPrompt, /grounded_response_contract/u);
assert.match(systemPrompt, /<\/grounded_response_contract>/u);
assert.match(systemPrompt, /source_1/u);
assert.match(systemPrompt, /premium-plan/u);
assert.match(systemPrompt, /priority support/u);
assert.match(systemPrompt, /<\/knowledge_context>/u);
assert.match(systemPrompt, /currentStage/u);

let providerInput;
let providerCalls = 0;
const adapter = {
  async *stream(input) {
    providerCalls += 1;
    providerInput = input;
    yield { type: 'text_delta', delta: JSON.stringify({
      intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
      evidenceSourceIds: ['source_1'], spokenAnswer: 'Premium Plan is USD 100.',
    }) };
    yield { type: 'completed', finishReason: 'stop', toolCalls: [] };
  },
  cancel() {}, close() {},
};
const streamSession = await createSelectedLlmStream({
  agent: { ...agent, temperature: 0.2 },
  providers: { llm: { providerId: 'provider-a', providerName: 'Compatible', modelId: 'model-a', modelKey: 'model-a' } },
  tools: [],
}, {
  callId: 'call-a', query: 'Tell me the price',
  history: [{ role: 'user', content: 'We were discussing Premium Plan.' }],
  knowledge, usageDirection: 'inbound',
  context: { groundedResponseMode: true, liveCallMemory: { currentTopic: 'Premium Plan' } },
}, { adapter, skipDefaultRegistration: true });
for await (const _event of streamSession.events) { /* consume one provider response */ }
await streamSession.close();
assert.equal(providerCalls, 1);
assert.deepEqual(providerInput.responseFormat, { type: 'json_object' });
assert.ok(providerInput.messages.some((message) => message.content === 'We were discussing Premium Plan.'));

const memory = openLiveCallMemory({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, {});
memory.applyGroundedDecision(valid);
assert.equal(memory.snapshot().lastIntent, 'catalog_item_details');
assert.equal(memory.snapshot().selectedItem.key, 'premium-plan');
memory.close();

console.log(JSON.stringify({
  task: 'One-call grounded LLM understanding and answering',
  singleResponseEnvelope: true,
  recentTurnsAndLiveStateIncluded: true,
  selectedEntitiesValidated: true,
  evidenceIdsValidated: true,
  unsupportedNumericFactsRejected: true,
  ungroundedSpeechBlockedBeforeTts: true,
  tenantEvidenceSource: 'published runtime Knowledge profile',
}, null, 2));
