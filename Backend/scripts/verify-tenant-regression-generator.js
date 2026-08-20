import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateTenantRegressionScenarios } from './lib/tenant-regression-scenarios.js';

const liveCall = JSON.parse(await readFile(new URL(
  '../fixtures/complete-live-call-2026-08-20-regression.json', import.meta.url,
), 'utf8'));

const records = [
  {
    id: 'catalog-alpha', type: 'CATALOG_ITEM', label: 'Aurora Membership',
    metadata: {
      key: 'aurora-membership', category: 'Membership Options', categoryKey: 'membership-options',
      aliases: ['Auraa Membership'], categoryAliases: ['member options'],
    },
  },
  {
    id: 'catalog-beta', type: 'CATALOG_ITEM', label: 'Beacon Membership',
    metadata: {
      key: 'beacon-membership', category: 'Membership Options', categoryKey: 'membership-options',
      aliases: ['B con Membership'], categoryAliases: ['member options'],
    },
  },
  {
    id: 'catalog-gamma', type: 'CATALOG_ITEM', label: 'Courier Add-on',
    metadata: {
      key: 'courier-addon', category: 'Delivery Services', categoryKey: 'delivery-services',
      aliases: ['carrier add on'], categoryAliases: ['shipping services'],
    },
  },
  {
    id: 'workflow-action', type: 'WORKFLOW_RULE', label: 'Create request',
    metadata: {
      actionType: 'configured_tool',
      actionConfig: { toolIdentifier: 'create_request' },
      conditions: { examples: ['Please submit my request'] },
    },
  },
];
const tools = [{
  id: 'tool-create', name: 'create_request', description: 'Create an approved request',
  inputSchema: {
    type: 'object', required: ['customerName', 'requestedDate'],
    properties: {
      customerName: { type: 'string', 'x-question': 'What name should I use?' },
      requestedDate: { type: 'string', format: 'date', 'x-question': 'Which date do you prefer?' },
    },
    'x-requires-confirmation': true,
  },
}];

const generated = generateTenantRegressionScenarios({ records, tools, liveCall });
assert.equal(generated.generatedFromPublishedRecords, true);
assert.deepEqual(generated.recordCounts, { catalogItems: 3, workflows: 1, tools: 1 });
for (const required of [
  'entity', 'category', 'stt_variation', 'topic_change', 'comparison',
  'safety', 'configured_action', 'live_call',
]) assert.ok(generated.coverage.includes(required), `Missing generated coverage: ${required}`);

const languages = new Set(generated.scenarios.map((scenario) => scenario.language));
assert.ok(languages.has('en'));
assert.ok(languages.has('ta'));
assert.ok(languages.has('tanglish'));
assert.ok(generated.scenarios.some((scenario) => (
  scenario.kind === 'stt_variation' && scenario.alias === 'Auraa Membership'
)));

const topicChange = generated.scenarios.find((scenario) => scenario.kind === 'topic_change');
assert.equal(topicChange.turns[1].staleEntityKeys[0], topicChange.turns[0].expectedEntityKeys[0]);
assert.notEqual(topicChange.turns[1].expectedEntityKeys[0], topicChange.turns[0].expectedEntityKeys[0]);
const comparison = generated.scenarios.find((scenario) => scenario.kind === 'comparison');
assert.equal(comparison.expectedEntityKeys.length, 2);
const safety = generated.scenarios.filter((scenario) => scenario.kind === 'safety');
assert.equal(safety.length, 3);
assert.ok(safety.every((scenario) => (
  scenario.forbiddenBehavior === 'symptom_based_suitability_recommendation'
)));
const action = generated.scenarios.find((scenario) => scenario.kind === 'configured_action');
assert.equal(action.workflowRecordId, 'workflow-action');
assert.equal(action.toolName, 'create_request');
assert.deepEqual(action.requiredFields, ['customerName', 'requestedDate']);
assert.equal(action.requiresConfirmation, true);
assert.equal(action.requiresVerifiedSuccess, true);

const replay = generated.scenarios.find((scenario) => scenario.kind === 'live_call');
assert.equal(replay.source.entryCount, 29);
assert.equal(replay.turns.length, 15);
assert.ok(replay.turns.some((turn) => turn.expect === 'topic_change'));
assert.ok(replay.turns.some((turn) => turn.expect === 'comparison'));
assert.ok(replay.turns.some((turn) => turn.expect === 'safety'));
assert.ok(replay.turns.some((turn) => turn.expect === 'configured_action'));

const generatorSource = await readFile(new URL('./lib/tenant-regression-scenarios.js', import.meta.url), 'utf8');
for (const tenantValue of records.filter((record) => record.type === 'CATALOG_ITEM')
  .flatMap((record) => [record.label, record.metadata.key, ...record.metadata.aliases])) {
  assert.equal(generatorSource.includes(tenantValue), false,
    `Generator contains tenant-specific vocabulary: ${tenantValue}`);
}

console.log(JSON.stringify({
  task: 'tenant-data-driven-regression-generator', passed: true,
  scenarioCount: generated.scenarios.length,
  coverage: generated.coverage,
  languages: [...languages],
  completeLiveCallTurns: replay.turns.length,
  tenantVocabularyHardcoded: false,
}, null, 2));

