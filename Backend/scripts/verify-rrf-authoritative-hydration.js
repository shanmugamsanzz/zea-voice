import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { knowledgeQueryClasses } from '../src/knowledge-engine/query-classifier.js';
import {
  authoritativeHydrationSql,
  detectEntityAmbiguity,
  fuseCandidateRankings,
  rankAndHydrateAuthoritativeEvidence,
} from '../src/knowledge-engine/authoritative-evidence.js';

const tenantId = '90000000-0000-4000-8000-000000000001';
const agentId = '90000000-0000-4000-8000-000000000002';
const callId = '90000000-0000-4000-8000-000000000003';
const knowledgeBaseId = '90000000-0000-4000-8000-000000000004';
const otherKnowledgeBaseId = '90000000-0000-4000-8000-000000000005';
const ids = Array.from({ length: 5 }, (_value, index) => (
  `90000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`
));

const input = createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant comparison', usageDirection: 'inbound',
});
const candidate = (recordId, rank, score, overrides = {}) => ({
  recordId, recordType: 'CATALOG_ITEM', knowledgeBaseId,
  publicationRevision: 4, channel: 'test', rank, score, ...overrides,
});
const retrieval = {
  tenantId, agentId, callId,
  channels: {
    structured: [candidate(ids[0], 1, 1), candidate(ids[1], 2, 0.9), candidate(ids[2], 3, 0.8)],
    bm25: [candidate(ids[1], 1, 7), candidate(ids[0], 2, 6), candidate(ids[3], 3, 5)],
    qdrant: [
      candidate(ids[1], 1, 0.95),
      candidate(ids[4], 2, 0.9),
      candidate(ids[4], 3, 0.8, { knowledgeBaseId: otherKnowledgeBaseId }),
    ],
  },
};

const fusion = fuseCandidateRankings(retrieval);
assert.equal(fusion.candidates[0].recordId, ids[1], 'Multi-channel RRF candidate must rank first');
assert.equal(fusion.candidates.filter((entry) => entry.recordId === ids[1]).length, 1,
  'Record IDs must be deduplicated');
assert.deepEqual(new Set(fusion.candidates[0].channels), new Set(['structured', 'bm25', 'qdrant']));
assert.deepEqual(fusion.rejectedScopeConflictIds, [ids[4].toLowerCase()]);

const duplicateFusion = fuseCandidateRankings({
  tenantId, agentId, callId,
  channels: { structured: [candidate(ids[0], 1, 1), candidate(ids[0], 2, 0.5)] },
});
assert.equal(duplicateFusion.candidates[0].rrfScore, Math.round((1 / 61) * 1e12) / 1e12,
  'A duplicate within one channel must not receive a second RRF contribution');
assert.deepEqual(duplicateFusion.candidates[0].channels, ['structured']);

let queryCount = 0;
let requestedIds = [];
const row = (recordId, rank, rrfScore, itemKey, name, price) => ({
  record_type: 'CATALOG_ITEM', record_id: recordId, knowledge_base_id: knowledgeBaseId,
  tenant_id: tenantId, publication_revision: 4,
  document_id: '91000000-0000-4000-8000-000000000001',
  document_version_id: '92000000-0000-4000-8000-000000000001',
  document_name: 'tenant-source.txt', source_page_start: 1, source_page_end: 1,
  language: 'mul', content: `${name} authoritative content`, caller_facing: true,
  authoritative_data: {
    itemKey, name, categoryKey: 'options', category: 'Options', price, currency: 'USD',
    attributes: [], relationships: {}, selectionRules: {},
  },
  rank, rrf_score: rrfScore,
});
const contextRunner = async (auth, callback) => {
  assert.equal(auth.tenantId, tenantId);
  return callback({
    query: async (sql, parameters) => {
      queryCount += 1;
      assert.equal(sql, authoritativeHydrationSql);
      assert.deepEqual(parameters.slice(0, 3), [tenantId, agentId, 'inbound']);
      const requested = JSON.parse(parameters[3]);
      requestedIds = requested.map((entry) => entry.record_id);
      assert.equal(new Set(requestedIds).size, requestedIds.length);
      assert.ok(requested.every((entry) => entry.publication_revision === 4));
      const byId = new Map(requested.map((entry) => [entry.record_id, entry]));
      return { rows: [
        row(ids[2], byId.get(ids[2]).rank, byId.get(ids[2]).rrf_score, 'different-item', 'Different item', 30),
        row(ids[0], byId.get(ids[0]).rank, byId.get(ids[0]).rrf_score, 'shared-item', 'Shared item', 10),
        row(ids[1], byId.get(ids[1]).rank, byId.get(ids[1]).rrf_score, 'shared-item', 'Shared item', 20),
        // A row with a mismatched active revision must still be rejected in the JS boundary.
        { ...row(ids[3], byId.get(ids[3]).rank, byId.get(ids[3]).rrf_score,
          'missing-item', 'Missing item', 40), publication_revision: 3 },
      ] };
    },
  });
};

const classification = {
  tenantId, agentId, callId,
  intentClass: knowledgeQueryClasses.KNOWN_INFORMATION,
  requiresConfirmation: true,
};
const resolution = { action: 'CONFIRM', candidate: { entityType: 'ITEM' } };
const hydrated = await rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution, retrieval,
}, { contextRunner });

assert.equal(queryCount, 1, 'Hydration must execute exactly one PostgreSQL query');
assert.equal(hydrated.hydrationQueryCount, 1);
assert.equal(hydrated.evidence.length, 3);
assert.deepEqual(hydrated.evidence.map((entry) => entry.rank),
  [...hydrated.evidence.map((entry) => entry.rank)].sort((left, right) => left - right));
assert.equal(hydrated.evidence.every((entry) => entry.hydrationValidated
  && entry.publicationValidated), true);
assert.equal(hydrated.ambiguity.detected, true);
assert.equal(hydrated.conflict.detected, true);
assert.equal(hydrated.conflict.conflicts[0].identity, 'catalog:options:shared item');
assert.ok(hydrated.rejectedRecordIds.includes(ids[3]));
assert.ok(!requestedIds.includes(ids[4]), 'Scope-conflicted ID must not reach PostgreSQL');

assert.equal(detectEntityAmbiguity(hydrated.evidence, {
  intentClass: knowledgeQueryClasses.COMPARISON_COMPLEX, requiresConfirmation: true,
}, resolution).detected, false, 'An intentional comparison must not be treated as ambiguity');

assert.match(authoritativeHydrationSql, /assigned\.publication_revision=requested\.publication_revision/u);
assert.match(authoritativeHydrationSql, /status='approved'/u);
assert.match(authoritativeHydrationSql, /version\.is_current=true/u);
assert.match(authoritativeHydrationSql, /agent_knowledge_bases/u);

let emptyQueryCount = 0;
const empty = await rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution,
  retrieval: { tenantId, agentId, callId, channels: { structured: [], bm25: [], qdrant: [] } },
}, { contextRunner: async () => { emptyQueryCount += 1; return []; } });
assert.equal(emptyQueryCount, 0);
assert.equal(empty.hydrationQueryCount, 0);

await assert.rejects(() => rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId: '90000000-0000-4000-8000-000000000099' },
  input, classification, resolution, retrieval,
}, { contextRunner }), /same-tenant/u);

console.log('RRF fusion and single-query authoritative PostgreSQL hydration verified.');
