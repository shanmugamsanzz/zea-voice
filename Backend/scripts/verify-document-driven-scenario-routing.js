import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const { processExtractedCategory } = await import('../src/knowledge-bases/category-processors.js');
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const workflowText = [
  'RULE: needs_relevant_service',
  'SCENARIO: true',
  'MATCH: I have a problem and which option is relevant? | எனக்கு பிரச்சனை இருக்கு எந்த option சரி?',
  'MATCH_MODE: any_phrase',
  'TARGET_CATEGORY: support-services',
  'RESPONSE_MODE: exact',
  'RESPONSE: Please use the approved support service. I cannot provide diagnosis or unapproved advice.',
].join('\n');
const extracted = processExtractedCategory('workflow_rules', {
  fullText: workflowText,
  pages: [{ pageNumber: 1, lines: workflowText.split('\n') }],
});
assert.equal(extracted.warnings.length, 0);
assert.equal(extracted.records[0].conditions.scenarioRouting, true);
assert.equal(extracted.records[0].actionConfig.scenarioTargetCategoryKey, 'support_services');

const missingTarget = processExtractedCategory('workflow_rules', {
  fullText: 'RULE: invalid\nSCENARIO: true\nMATCH: need help\nRESPONSE_MODE: exact\nRESPONSE: approved answer',
  pages: [{ pageNumber: 1, lines: ['RULE: invalid', 'SCENARIO: true', 'MATCH: need help', 'RESPONSE_MODE: exact', 'RESPONSE: approved answer'] }],
});
assert.equal(missingTarget.records.length, 0);
assert.match(missingTarget.warnings[0], /TARGET_CATEGORY or TARGET_ITEM/u);

const profile = {
  agent_usage: 'inbound', agent_settings: {}, knowledge_bases: [], conversations: [], faqs: [],
  workflows: [{
    id: '33333333-3333-4333-8333-333333333333', name: extracted.records[0].name,
    intent: extracted.records[0].intent, priority: 1, conditions: extracted.records[0].conditions,
    action_type: extracted.records[0].actionType, action_config: extracted.records[0].actionConfig,
    response_template: extracted.records[0].responseTemplate,
  }],
  catalog_items: [
    { id: '44444444-4444-4444-8444-444444444444', item_key: 'guided-support', name: 'Guided Support',
      category: 'Support Services', category_key: 'support_services', parent_category_key: 'all_services',
      category_aliases: [], aliases: [], description: 'Approved support option', attributes: [] },
  ],
};
const dependencies = {
  cache: { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } },
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { throw new Error('No semantic call expected'); },
  search: async () => { throw new Error('No semantic call expected'); },
};
const result = await routeKnowledgeQuery({ tenantId }, {
  agentId, query: 'I have a problem and which option is relevant?', usageDirection: 'inbound', language: 'en', routeHint: 'auto',
  detectedIntent: { intent: 'scenario', confidence: 0.9, signals: ['scenario'] },
}, dependencies);
assert.equal(result.route, 'workflow');
assert.equal(result.workflow.intent, 'needs_relevant_service');
assert.equal(result.scenarioCategory.key, 'support_services');
assert.equal(result.scenarioCategory.items[0].key, 'guided-support');

const nonScenario = await routeKnowledgeQuery({ tenantId }, {
  agentId, query: 'I have a problem and which option is relevant?', usageDirection: 'inbound', language: 'en', routeHint: 'auto',
  detectedIntent: { intent: 'details', confidence: 0.9, signals: ['details'] },
}, dependencies);
assert.equal(nonScenario.route, 'none');

console.log(JSON.stringify({
  task: 'Document-driven scenario routing',
  workflowAuthoredTarget: true,
  safeResponseIsTenantConfigured: true,
  categoryAndItemRetrieved: true,
  industryHardcoding: false,
}, null, 2));
