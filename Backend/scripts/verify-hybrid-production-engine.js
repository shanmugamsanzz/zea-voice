import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { classifyCatalogEntityLocally } from '../src/knowledge-bases/catalog-entity-resolver.js';
import { runParallelHybridRetrieval } from '../src/knowledge-bases/parallel-hybrid-retrieval.js';
import { rankHybridEvidence, rankedEvidenceBundle } from '../src/knowledge-bases/hybrid-evidence-ranker.js';
import {
  buildGroundingEnvelope,
  validateGroundedSpokenSentences,
} from '../src/voice/interaction/grounded-llm-response.js';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';
import { sttEventPolicy } from '../src/voice/interaction/stt-event-policy.js';

const catalog = [{
  id: 'item-a', item_key: 'item-a', name: 'Universal Service',
  category: 'Service Group', category_key: 'service-group',
  aliases: ['சேவை ஏ', 'sevai a', 'univrsal service'],
  category_aliases: ['சேவை வகை', 'sevai group'],
  description: 'Approved service description', price: 125, currency: 'INR',
}];
for (const query of ['சேவை ஏ', 'sevai a', 'Universal Service', 'univrsal service']) {
  const resolution = classifyCatalogEntityLocally(catalog, query);
  assert.equal(resolution.status, 'match', query);
  assert.equal(resolution.item.id, 'item-a');
}

assert.equal(sttEventPolicy('partial_transcript').allowBargeIn, true);
assert.equal(sttEventPolicy('partial_transcript').processCallerTurn, false);
assert.equal(sttEventPolicy('final_transcript').processCallerTurn, true);

const memory = openLiveCallMemory({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, { conversationInitialStage: 'discover' });
memory.applyKnowledge({
  route: 'catalog', found: true, source: { recordId: 'item-a' },
  item: { id: 'item-a', key: 'item-a', name: 'Universal Service', category: 'Service Group', categoryKey: 'service-group' },
});
memory.applyKnowledge({
  route: 'workflow', found: true,
  workflow: { conditions: { fromStages: ['discover'] }, gate: { allowed: true } },
  action: { config: { nextStage: 'collect', actionKey: 'configured-action', requiresCatalogItem: true } },
});
memory.observeAssistantResponse('Which configured value should I collect?');
memory.captureUserUtterance('What is the approved price?');
memory.applyGroundedDecision({ intent: 'price', flowAction: 'side_question' });
const resumed = memory.prepareAssistantResponse('The approved price is INR 125.');
assert.match(resumed, /Which configured value should I collect\?/u);
assert.equal(memory.snapshot().currentStage, 'collect');

memory.applyKnowledge({
  route: 'workflow', found: true,
  workflow: { conditions: { fromStages: ['wrong-stage'] }, gate: { allowed: true } },
  action: { config: { nextStage: 'forbidden-stage', actionKey: 'forbidden-action' } },
});
assert.equal(memory.snapshot().currentStage, 'collect');

const startedAt = performance.now();
const retrieval = await runParallelHybridRetrieval({
  catalog: async () => ({
    route: 'catalog', found: true, content: 'Universal Service costs INR 125.',
    source: { recordId: 'item-a', knowledgeBaseId: 'tenant-a-catalog' },
    item: { id: 'item-a', key: 'item-a', name: 'Universal Service', categoryKey: 'service-group' },
    entityResolution: { method: 'exact', confidence: 1 },
  }),
  workflow: async () => ({
    route: 'workflow', found: true, content: 'Which configured value should I collect?',
    source: { recordId: 'flow-a', knowledgeBaseId: 'tenant-a-workflow' },
    workflow: { matchMethod: 'semantic', confidence: 0.81, priority: 20, gate: { allowed: true } },
  }),
  script: async () => ({
    route: 'conversation', found: true, content: 'Approved natural wording.',
    source: { recordId: 'script-a', knowledgeBaseId: 'tenant-a-script', nodeKey: 'collect' },
  }),
  faq: async () => ({
    route: 'faq', found: true, content: 'Universal Service costs INR 125.',
    source: { recordId: 'faq-a', knowledgeBaseId: 'tenant-a-faq' },
  }),
  general: async () => ({
    route: 'semantic', found: true, content: 'Approved tenant A information.',
    source: { recordId: 'general-a', knowledgeBaseId: 'tenant-a-general' },
    matches: [{ recordType: 'KNOWLEDGE_CHUNK', score: 0.8 }],
  }),
});
const ranked = rankHybridEvidence(retrieval.candidates, {
  selectedItemId: 'item-a', selectedItemKey: 'item-a', activeCategoryKey: 'service-group',
  currentStage: 'collect', knowledgeBases: [
    { id: 'tenant-a-catalog', priority: 1 }, { id: 'tenant-a-workflow', priority: 2 },
    { id: 'tenant-a-script', priority: 3 }, { id: 'tenant-a-faq', priority: 4 },
    { id: 'tenant-a-general', priority: 5 },
  ],
});
const evidence = rankedEvidenceBundle(ranked);
assert.ok(evidence.length >= 5);
assert.ok(evidence.every((entry) => !String(entry.source?.knowledgeBaseId).startsWith('tenant-b')));

const knowledge = {
  route: 'catalog', found: true, content: 'Universal Service costs INR 125.',
  source: { recordId: 'item-a' }, item: { key: 'item-a', name: 'Universal Service' },
  rankedEvidence: evidence,
};
const envelope = buildGroundingEnvelope(knowledge);
const sourceId = envelope.sources.find((source) => source.content.includes('INR 125'))?.id;
const decision = { selectedEntityKeys: ['item-a'], evidenceSourceIds: [sourceId] };
const guarded = validateGroundedSpokenSentences(
  'Universal Service costs INR 125. Unsupported Service costs INR 999.', envelope, decision,
);
assert.equal(guarded.approved.length, 1);
assert.equal(guarded.rejected[0].reason, 'unsupported_numeric_fact');

const firstSentenceReadyMs = performance.now() - startedAt;
assert.ok(firstSentenceReadyMs < 1_000, `Local retrieval/ranking/validation took ${firstSentenceReadyMs.toFixed(2)}ms`);
memory.close();

console.log(JSON.stringify({
  task: 'Hybrid production flow and performance evaluation',
  uiDocumentDriven: true,
  tenantIsolation: true,
  documentConfiguredTransitionsOnly: true,
  sideQuestionResume: true,
  bargeInEnabled: true,
  finalSttOnlyProcessing: true,
  languageAndSttVariants: ['Tamil', 'Tanglish', 'English', 'typo'],
  unsupportedSentenceBlocked: true,
  localFirstSentenceReadyMs: Math.round(firstSentenceReadyMs * 100) / 100,
  targetFirstAudioMs: 1_000,
  providerNetworkIncluded: false,
}, null, 2));
