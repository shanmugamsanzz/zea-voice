import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  rankHybridEvidence,
  resolveEvidenceConfidence,
  validateDirectAnswer,
} from '../src/knowledge-bases/hybrid-evidence-ranker.js';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';

function catalogCandidate(id, key, categoryKey, questionTypes, { direct = false } = {}) {
  return {
    route: 'catalog', found: true, content: `Approved ${key} evidence.`,
    source: { recordId: id, recordType: 'CATALOG_ITEM', knowledgeBaseId: 'kb-1', confidence: 1 },
    item: { key, name: key, categoryKey },
    resolvedEntity: { id, key, name: key, categoryKey, canonical: true },
    entityResolution: { method: 'normalized', confidence: 1 },
    questionTypes,
    ...(direct ? { directAnswer: { approved: true, questionTypes } } : {}),
  };
}

const selectedDetails = catalogCandidate('item-a', 'item-a', 'category-a', ['details'], { direct: true });
const latestPrice = catalogCandidate('item-b', 'item-b', 'category-b', ['price']);
let ranked = rankHybridEvidence([selectedDetails, latestPrice], {
  questionType: 'price', selectedItemId: 'item-a', knowledgeBases: [{ id: 'kb-1', priority: 1 }],
});
assert.equal(ranked[0].candidate, latestPrice, 'latest question type must outrank selected item');

const selectedPrice = catalogCandidate('item-a', 'item-a', 'category-a', ['price']);
const resolvedPrice = catalogCandidate('item-b', 'item-b', 'category-b', ['price'], { direct: true });
ranked = rankHybridEvidence([resolvedPrice, selectedPrice], {
  questionType: 'price', selectedItemId: 'item-a', resolvedEntityId: 'item-b',
  activeCategoryKey: 'category-b', knowledgeBases: [{ id: 'kb-1', priority: 1 }],
});
assert.equal(ranked[0].candidate, selectedPrice, 'selected item must outrank newly resolved entity');

const fuzzyWorkflow = {
  route: 'workflow_hint', found: true, content: 'Internal evidence hint.',
  source: { recordId: 'rule-1', recordType: 'WORKFLOW_RULE', confidence: 0.95 },
  workflow: { evidenceOnly: true, matchMethod: 'fuzzy', confidence: 0.95, intent: 'booking' },
  directAnswer: { approved: true, questionTypes: ['booking'] },
};
assert.equal(validateDirectAnswer(fuzzyWorkflow, {
  questionType: 'booking', confidenceOutcome: 'high',
}).valid, false);

const approvedDirect = catalogCandidate('item-c', 'item-c', 'category-c', ['price'], { direct: true });
const directRanked = rankHybridEvidence([approvedDirect], { questionType: 'price' });
const confidence = resolveEvidenceConfidence(directRanked, {});
assert.equal(confidence.outcome, 'high');
assert.equal(validateDirectAnswer(approvedDirect, {
  questionType: 'price', confidenceOutcome: confidence.outcome,
}).valid, true);
assert.equal(validateDirectAnswer(approvedDirect, {
  questionType: 'comparison', confidenceOutcome: confidence.outcome,
}).valid, false);

const memory = openLiveCallMemory({
  tenantId: 'tenant-rank', workspaceId: 'workspace-rank',
  agentId: 'agent-rank', callId: 'call-rank',
}, { conversationInitialStage: 'start' });
memory.applyKnowledge({
  route: 'semantic', found: true,
  resolvedEntity: {
    id: 'item-c', key: 'item-c', name: 'Canonical Item', category: 'Category C',
    categoryKey: 'category-c', canonical: true,
  },
});
assert.equal(memory.snapshot().selectedCatalogItem.id, 'item-c');
assert.equal(memory.snapshot().selectedCatalogItem.key, 'item-c');
assert.equal(memory.snapshot().currentTopic, 'Canonical Item');

const candidates = Array.from({ length: 80 }, (_, index) => catalogCandidate(
  `item-${index}`, `item-${index}`, `category-${index % 5}`,
  [index % 2 ? 'details' : 'price'], { direct: index % 7 === 0 },
));
const samples = [];
for (let iteration = 0; iteration < 100; iteration += 1) {
  const startedAt = performance.now();
  const result = rankHybridEvidence(candidates, {
    questionType: 'price', selectedItemId: 'item-30', resolvedEntityId: 'item-32',
    activeCategoryKey: 'category-0', pendingQuestionType: 'details', currentStage: 'details',
    knowledgeBases: [{ id: 'kb-1', priority: 1 }],
  });
  const outcome = resolveEvidenceConfidence(result, {});
  validateDirectAnswer(result[0].candidate, { questionType: 'price', confidenceOutcome: outcome.outcome });
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);
const p95Ms = samples[Math.floor(samples.length * 0.95)];
assert.ok(p95Ms <= 20, `ranking and validation p95 ${p95Ms.toFixed(3)}ms exceeded 20ms`);

console.log(JSON.stringify({
  task: 'deterministic-evidence-ranking',
  priorityOrder: [
    'latestQuestionType', 'selectedItem', 'resolvedEntity', 'directAnswerCoverage',
    'activeCategory', 'pendingQuestion', 'stageCompatibility', 'sourceAuthority',
  ],
  fuzzyWorkflowDirectSpeech: false,
  canonicalEntityStored: true,
  rankingValidationP95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
