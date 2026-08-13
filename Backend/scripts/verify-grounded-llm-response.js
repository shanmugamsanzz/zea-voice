import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { buildAgentSystemPrompt } = await import('../src/agents/agent-runtime.service.js');
const {
  buildGroundingEnvelope,
  groundedResponseContract,
  normalizeQuestionType,
  validateGroundedLlmUnderstanding,
  validateGroundedLlmResponse,
  validateGroundedSpokenSentences,
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
const groundedJson = (value) => JSON.stringify({
  currentTopic: 'Premium Plan', topicChanged: false, pendingQuestionRelevant: true, ...value,
});
assert.equal(envelope.sources.length, 1);
assert.equal(envelope.sources[0].id, 'source_1');
assert.equal(envelope.entities[0].key, 'premium-plan');
assert.deepEqual(groundedResponseContract(envelope).allowedEntityKeys, ['premium-plan']);

const rankedEnvelope = buildGroundingEnvelope({
  ...knowledge,
  rankedEvidence: [{
    route: 'faq', content: 'Approved follow-up evidence.', score: 450,
    source: { recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  }],
});
assert.equal(rankedEnvelope.sources.length, 2);
assert.ok(groundedResponseContract(rankedEnvelope).allowedEvidenceSourceIds.includes('source_2'));

assert.equal(normalizeQuestionType('package_overview'), 'overview');
assert.equal(normalizeQuestionType('package details'), 'details');
assert.equal(normalizeQuestionType('price_question'), 'price');
assert.equal(normalizeQuestionType('symptom-query'), 'scenario');
assert.equal(normalizeQuestionType('unexpected_model_label'), 'unclear');

const normalizedUnderstanding = validateGroundedLlmUnderstanding(groundedJson({
  intent: 'show packages', questionType: 'package_overview', flowAction: 'continue', selectedEntityKeys: [],
}), envelope);
assert.equal(normalizedUnderstanding.valid, true);
assert.equal(normalizedUnderstanding.questionType, 'overview');

const unknownUnderstanding = validateGroundedLlmUnderstanding(groundedJson({
  intent: 'unclassified turn', questionType: 'unexpected_model_label', flowAction: 'clarify', selectedEntityKeys: [],
}), envelope);
assert.equal(unknownUnderstanding.valid, true);
assert.equal(unknownUnderstanding.questionType, 'unclear');

const directUnderstanding = validateGroundedLlmUnderstanding(groundedJson({
  intent: 'show item', questionType: 'details', flowAction: 'answer_pending',
  selectedEntityKeys: ['Premium Plan'],
}), envelope, { pendingQuestion: null });
assert.equal(directUnderstanding.valid, true);
assert.equal(directUnderstanding.flowAction, 'continue');
assert.deepEqual(directUnderstanding.selectedEntityKeys, ['premium-plan']);

const valid = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details',
  questionType: 'inclusions',
  flowAction: 'side_question',
  selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'],
  assertedFacts: [{ type: 'inclusion', value: 'priority support', sourceId: 'source_1' }],
  spokenAnswer: 'Premium Plan is USD 100 and includes priority support.',
}), envelope);
assert.equal(valid.valid, true);
assert.equal(valid.intent, 'catalog_item_details');
assert.equal(valid.questionType, 'inclusions');
assert.equal(valid.flowAction, 'side_question');
assert.equal(valid.selectedEntities[0].key, 'premium-plan');

const canonicalReferences = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', questionType: 'price', flowAction: 'answer_pending',
  selectedEntityKeys: ['Premium Plan'],
  evidenceSourceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  assertedFacts: [{
    type: 'price', value: 'USD 100', sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }],
  spokenAnswer: 'Premium Plan is USD 100.',
}), envelope, { pendingQuestion: null });
assert.equal(canonicalReferences.valid, true);
assert.equal(canonicalReferences.flowAction, 'continue');
assert.deepEqual(canonicalReferences.selectedEntityKeys, ['premium-plan']);
assert.deepEqual(canonicalReferences.evidenceSourceIds, ['source_1']);
assert.equal(canonicalReferences.assertedFacts[0].sourceId, 'source_1');

const sentenceValidation = validateGroundedSpokenSentences(
  'Premium Plan is USD 100. It includes priority support. Refunds are always guaranteed.',
  envelope,
  valid,
);
assert.equal(sentenceValidation.valid, false);
assert.equal(sentenceValidation.approved.length, 2);
assert.equal(sentenceValidation.rejected[0].reason, 'insufficient_sentence_evidence');
assert.doesNotMatch(sentenceValidation.text, /guaranteed/iu);

const internalSentence = validateGroundedSpokenSentences(
  'RESPONSE_MODE: instruction.', envelope, valid,
);
assert.equal(internalSentence.rejected[0].reason, 'internal_text');

const configuredQuestion = validateGroundedSpokenSentences(
  'Premium Plan is USD 100. Which configured value should I collect?',
  envelope,
  valid,
  { configuredSpeech: ['Which configured value should I collect?'] },
);
assert.equal(configuredQuestion.valid, true);
assert.equal(configuredQuestion.approved.length, 2);

const unpublishedEntity = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', selectedEntityKeys: ['invented-plan'],
  questionType: 'details',
  evidenceSourceIds: ['source_1'], assertedFacts: [{ type: 'price', value: 'USD 100', sourceId: 'source_1' }], spokenAnswer: 'Premium Plan is USD 100.',
}), envelope);
assert.equal(unpublishedEntity.valid, false);
assert.equal(unpublishedEntity.reason, 'unpublished_entity_selected');

const unpublishedEvidence = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  questionType: 'price',
  evidenceSourceIds: ['source_99'], assertedFacts: [{ type: 'price', value: 'USD 100', sourceId: 'source_99' }], spokenAnswer: 'Premium Plan is USD 100.',
}), envelope);
assert.equal(unpublishedEvidence.reason, 'unpublished_evidence_selected');

const inventedPrice = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  questionType: 'price',
  evidenceSourceIds: ['source_1'], assertedFacts: [{ type: 'price', value: 'USD 100', sourceId: 'source_1' }], spokenAnswer: 'Premium Plan is USD 999.',
}), envelope);
assert.equal(inventedPrice.reason, 'unsupported_numeric_fact');

const inventedTechnicalTerm = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', questionType: 'details', selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'],
  assertedFacts: [{ type: 'inclusion', value: 'priority support', sourceId: 'source_1' }],
  spokenAnswer: 'Premium Plan includes priority support and MRI.',
}), envelope);
assert.equal(inventedTechnicalTerm.reason, 'unsupported_technical_term');

const inventedAssertedFact = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', questionType: 'details', selectedEntityKeys: ['premium-plan'],
  evidenceSourceIds: ['source_1'],
  assertedFacts: [{ type: 'policy', value: 'Guaranteed refund', sourceId: 'source_1' }],
  spokenAnswer: 'Premium Plan includes priority support.',
}), envelope);
assert.equal(inventedAssertedFact.reason, 'unsupported_asserted_fact');

const mismatchedEntityAnswer = validateGroundedLlmResponse(groundedJson({
  intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
  questionType: 'details',
  evidenceSourceIds: ['source_1'], assertedFacts: [{ type: 'price', value: 'USD 100', sourceId: 'source_1' }], spokenAnswer: 'Basic Plan is USD 100.',
}), envelope);
assert.equal(mismatchedEntityAnswer.reason, 'selected_entity_not_supported_by_answer');

const noPublishedEvidence = validateGroundedLlmResponse(groundedJson({
  intent: 'unknown', questionType: 'unclear', selectedEntityKeys: [], evidenceSourceIds: [], assertedFacts: [],
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
    detectedIntent: { intent: 'price', confidence: 0.93, signals: ['price'] },
  },
  maxPromptChars: 8_000,
});
assert.match(systemPrompt, /grounded_response_contract/u);
assert.match(systemPrompt, /<\/grounded_response_contract>/u);
assert.match(systemPrompt, /source_1/u);
assert.match(systemPrompt, /premium-plan/u);
assert.match(systemPrompt, /priority support/u);
assert.match(systemPrompt, /<\/knowledge_context>/u);
assert.match(systemPrompt, /currentStage/u);
assert.match(systemPrompt, /detectedIntent/u);

const completeTenantPrompt = `${'Tenant instruction. '.repeat(430)}ESSENTIAL_TENANT_TAIL_MARKER`;
const productionBudgetPrompt = buildAgentSystemPrompt({
  ...agent, prompt: completeTenantPrompt,
}, {
  usageDirection: 'inbound', knowledge,
  context: {
    groundedResponseMode: true,
    liveCallMemory: { currentStage: 'details', language: 'ta', collectedData: {} },
  },
  maxPromptChars: 24_000,
});
assert.match(productionBudgetPrompt, /ESSENTIAL_TENANT_TAIL_MARKER/u);
assert.match(productionBudgetPrompt, /<\/company_instructions>/u);
assert.match(productionBudgetPrompt, /<\/grounded_response_contract>/u);
assert.match(productionBudgetPrompt, /<\/knowledge_context>/u);
assert.ok(productionBudgetPrompt.length <= 24_000);

let providerInput;
let providerCalls = 0;
const adapter = {
  async *stream(input) {
    providerCalls += 1;
    providerInput = input;
    yield { type: 'text_delta', delta: groundedJson({
      intent: 'catalog_item_details', selectedEntityKeys: ['premium-plan'],
      questionType: 'price',
      evidenceSourceIds: ['source_1'],
      assertedFacts: [{ type: 'price', value: 'USD 100', sourceId: 'source_1' }],
      spokenAnswer: 'Premium Plan is USD 100.',
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
  context: {
    groundedResponseMode: true, liveCallMemory: { currentTopic: 'Premium Plan' },
    detectedIntent: { intent: 'price', confidence: 0.93, signals: ['price'] },
  },
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
