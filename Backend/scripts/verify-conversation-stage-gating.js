import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { processExtractedCategory } = await import('../src/knowledge-bases/category-processors.js');
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');
const { openLiveCallMemory } = await import('../src/voice/interaction/live-call-memory.js');
const { resolveTaskCompletionConfiguration } = await import('../src/voice/interaction/completion-config.js');

const workflowText = [
  'RULE: begin_booking',
  'MATCH: book | proceed with booking',
  'MATCH_MODE: any_phrase',
  'FROM_STAGE: package_details',
  'NEXT_STAGE: booking_details',
  'ACTION: appointment_booking',
  'REQUIRES_CATALOG_ITEM: true',
  'BLOCKED_RESPONSE: Please select an available item first.',
  'RESPONSE_MODE: exact',
  'RESPONSE: I can collect the booking details now.',
].join('\n');
const parsed = processExtractedCategory('workflow_rules', {
  fullText: workflowText,
  pages: [{ pageNumber: 1, lines: workflowText.split('\n') }],
});
assert.equal(parsed.recordCount, 1);
assert.deepEqual(parsed.records[0].conditions.fromStages, ['package_details']);
assert.equal(parsed.records[0].actionConfig.nextStage, 'booking_details');
assert.equal(parsed.records[0].actionConfig.actionKey, 'appointment_booking');
assert.equal(parsed.records[0].actionConfig.requiresCatalogItem, true);

const memory = openLiveCallMemory({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, {
  conversationInitialStage: 'package_details',
  conversationMemoryFields: [
    { key: 'general_question', label: 'Question', type: 'text', required: false, question: 'What do you need?' },
    { key: 'customer_name', label: 'Name', type: 'text', required: true, question: 'Your name?', requiredAction: 'appointment_booking' },
    { key: 'preferred_date', label: 'Date', type: 'date', required: true, question: 'Which date?', requiredAction: 'appointment_booking' },
  ],
});
assert.equal(memory.snapshot().currentStage, 'package_details');
assert.deepEqual(memory.snapshot().lockedFields, ['customer_name', 'preferred_date']);
assert.deepEqual(memory.captureUserUtterance('My name is Early').updates, {});

const blockedWorkflow = {
  route: 'workflow',
  workflow: { conditions: parsed.records[0].conditions, gate: { allowed: false, reason: 'catalog_item_required' } },
  action: { config: parsed.records[0].actionConfig },
};
memory.applyKnowledge(blockedWorkflow);
assert.equal(memory.canRunAction('appointment_booking', { requiresCatalogItem: true }), false);
assert.equal(memory.snapshot().currentStage, 'package_details');

const catalogSelection = {
  route: 'catalog',
  source: { recordId: '77777777-7777-4777-8777-777777777777' },
  item: { key: 'service-a', name: 'Service A', category: 'Services' },
};
memory.applyKnowledge(catalogSelection);
assert.equal(memory.snapshot().selectedCatalogItem.name, 'Service A');
memory.applyKnowledge({
  route: 'workflow',
  workflow: { conditions: parsed.records[0].conditions, gate: { allowed: true } },
  action: { config: parsed.records[0].actionConfig },
});
assert.equal(memory.canRunAction('appointment_booking', { requiresCatalogItem: true }), true);
assert.equal(memory.snapshot().currentStage, 'booking_details');
assert.deepEqual(memory.snapshot().lockedFields, []);
assert.deepEqual(memory.captureUserUtterance('My name is Shanmugam').updates, { customer_name: 'Shanmugam' });

const completion = resolveTaskCompletionConfiguration({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'appointment_booking',
  taskCompletionRequiredFields: ['selected_item', 'customer_name'],
  taskCompletionConfirmationMessage: 'Confirmed.',
  taskCompletionRequiresCatalogItem: true,
  taskCompletionCatalogField: 'selected_item',
}, { strict: true });
assert.equal(completion.requiresCatalogItem, true);
assert.equal(completion.catalogField, 'selected_item');

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const catalogItemId = '77777777-7777-4777-8777-777777777777';
const workflowRecord = {
  id: '99999999-9999-4999-8999-999999999999', knowledge_base_id: knowledgeBaseId,
  document_id: '44444444-4444-4444-8444-444444444444',
  document_version_id: '55555555-5555-4555-8555-555555555555', document_name: 'workflow.txt',
  source_page_start: 1, source_page_end: 1, name: 'begin_booking', intent: 'begin_booking', priority: 1,
  conditions: parsed.records[0].conditions, action_type: 'respond', action_config: parsed.records[0].actionConfig,
  response_template: parsed.records[0].responseTemplate,
};
const profile = {
  agent_usage: 'inbound', knowledge_bases: [], workflows: [workflowRecord], conversations: [], faqs: [],
  catalog_items: [{
    id: catalogItemId, knowledge_base_id: knowledgeBaseId,
    document_id: '44444444-4444-4444-8444-444444444444',
    document_version_id: '55555555-5555-4555-8555-555555555555', document_name: 'catalog.txt',
    source_page_start: 1, source_page_end: 1, item_key: 'service-a', name: 'Service A', aliases: ['Service Alpha'],
    category: 'Services', description: null, price: 100, currency: 'INR', display_order: 0, attributes: [],
  }],
};
const dependencies = {
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  cache: { async get() { return null; }, async set() { return 'OK'; } },
};
const blocked = await routeKnowledgeQuery({ tenantId }, {
  agentId: '66666666-6666-4666-8666-666666666666', query: 'book it', usageDirection: 'inbound',
  language: 'en', routeHint: 'auto', currentStage: 'package_details',
}, dependencies);
assert.equal(blocked.route, 'workflow');
assert.equal(blocked.workflow.gate.allowed, false);
assert.equal(blocked.content, 'Please select an available item first.');

const allowed = await routeKnowledgeQuery({ tenantId }, {
  agentId: '66666666-6666-4666-8666-666666666666', query: 'book Service Alpha', usageDirection: 'inbound',
  language: 'en', routeHint: 'auto', currentStage: 'package_details',
}, dependencies);
assert.equal(allowed.route, 'workflow');
assert.equal(allowed.workflow.gate.allowed, true);
assert.equal(allowed.catalogSelection.item.name, 'Service A');

const wrongStage = await routeKnowledgeQuery({ tenantId }, {
  agentId: '66666666-6666-4666-8666-666666666666', query: 'book it', usageDirection: 'inbound',
  language: 'en', routeHint: 'auto', currentStage: 'start',
}, dependencies);
assert.equal(wrongStage.route, 'none');

memory.close();
console.log('Conversation-stage transitions, Catalog action gate, locked fields and tenant-configured action flow verified.');
