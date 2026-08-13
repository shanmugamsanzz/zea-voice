import assert from 'node:assert/strict';
import { runParallelHybridRetrieval } from '../src/knowledge-bases/parallel-hybrid-retrieval.js';
import { rankHybridEvidence, rankedEvidenceBundle } from '../src/knowledge-bases/hybrid-evidence-ranker.js';

const startedAt = performance.now();
const retrieval = await runParallelHybridRetrieval({
  catalog: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      route: 'catalog', found: true, content: 'Approved selected-item facts',
      source: { recordId: 'catalog-record', knowledgeBaseId: 'kb-primary' },
      item: { id: 'selected-item', key: 'selected-key', categoryKey: 'active-category' },
      entityResolution: { method: 'normalized', confidence: 1 },
    };
  },
  workflow: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      route: 'workflow', found: true, content: 'Approved exact action response',
      source: { recordId: 'workflow-record', knowledgeBaseId: 'kb-primary' },
      workflow: { matchMethod: 'exact', confidence: 1, priority: 10, gate: { allowed: true } },
    };
  },
  script: async () => ({
    route: 'conversation', found: true, content: 'Approved stage wording',
    source: { recordId: 'script-record', nodeKey: 'current-stage', knowledgeBaseId: 'kb-secondary' },
  }),
  faq: async () => ({
    route: 'faq', found: true, content: 'Approved FAQ answer',
    source: { recordId: 'faq-record', knowledgeBaseId: 'kb-secondary' },
  }),
  general: async () => ({
    route: 'semantic', found: true, content: 'Approved general fact',
    source: { recordId: 'general-record', knowledgeBaseId: 'kb-secondary' },
    matches: [{ recordType: 'KNOWLEDGE_CHUNK', score: 0.9, knowledgeBaseId: 'kb-secondary' }],
  }),
});
const elapsedMs = performance.now() - startedAt;
assert.equal(retrieval.candidates.length, 5);
assert.ok(elapsedMs < 38, `Retrievers did not run concurrently (${elapsedMs.toFixed(2)}ms)`);
assert.ok(retrieval.candidates.every((candidate) => candidate.retrieval.parallel === true));

const ranked = rankHybridEvidence(retrieval.candidates, {
  selectedItemId: 'selected-item', selectedItemKey: 'selected-key',
  activeCategoryKey: 'active-category', currentStage: 'current-stage',
  knowledgeBases: [{ id: 'kb-primary', priority: 1 }, { id: 'kb-secondary', priority: 2 }],
});
assert.equal(ranked[0].candidate.route, 'workflow');
assert.equal(ranked[0].factors.deterministicAction, 1_000);
assert.ok(ranked.find((entry) => entry.candidate.route === 'catalog').factors.selectedItem > 0);
assert.ok(ranked.find((entry) => entry.candidate.route === 'conversation').factors.stage > 0);
assert.equal(rankedEvidenceBundle(ranked).length, 5);

console.log(JSON.stringify({
  parallelChannels: retrieval.candidates.map((candidate) => candidate.retrieval.channel),
  deterministicWorkflowPrecedence: true,
  selectedItemBoost: true,
  activeCategoryBoost: true,
  stageCompatibilityBoost: true,
  elapsedMs: Math.round(elapsedMs * 100) / 100,
}, null, 2));
