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
const ids = Array.from({ length: 9 }, (_value, index) => (
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
assert.equal(new Set(fusion.candidates.map((entry) => entry.canonicalIdentityKey)).size,
  fusion.candidates.length, 'RRF must deduplicate by canonical PostgreSQL publication identity');
assert.deepEqual(fusion.rejectedScopeConflictIds, []);
const scopedIdentityFusion = fuseCandidateRankings({
  tenantId, agentId, callId,
  channels: { structured: [
    candidate(ids[4], 1, 1),
    candidate(ids[4], 2, 1, { knowledgeBaseId: otherKnowledgeBaseId }),
  ] },
});
assert.equal(scopedIdentityFusion.candidates.length, 2,
  'The same record ID in different KB scopes must remain separate canonical identities');
assert.notEqual(scopedIdentityFusion.candidates[0].canonicalIdentityKey,
  scopedIdentityFusion.candidates[1].canonicalIdentityKey);

const duplicateFusion = fuseCandidateRankings({
  tenantId, agentId, callId,
  channels: { structured: [candidate(ids[0], 1, 1), candidate(ids[0], 2, 0.5)] },
});
assert.equal(duplicateFusion.candidates[0].rrfScore, Math.round((1 / 61) * 1e12) / 1e12,
  'A duplicate within one channel must not receive a second RRF contribution');
assert.deepEqual(duplicateFusion.candidates[0].channels, ['structured']);

const weakFusion = fuseCandidateRankings({
  tenantId, agentId, callId, recordTypes: ['CATALOG_ITEM'],
  channels: {
    qdrant: [candidate(ids[5], 1, 0.1), candidate(ids[6], 2, 0.9)],
    structured: [{ ...candidate(ids[7], 1, 1), recordType: 'FAQ' }],
  },
});
assert.deepEqual(weakFusion.candidates.map((entry) => entry.recordId), [ids[6]]);
assert.deepEqual(weakFusion.rejectedWeakIds, [ids[5].toLowerCase()]);
assert.deepEqual(weakFusion.rejectedNamespaceIds, [ids[7].toLowerCase()]);

const reservedFusion = fuseCandidateRankings({
  tenantId, agentId, callId, recordTypes: ['CATALOG_ITEM'],
  channels: {
    structured: ids.slice(0, 7).map((recordId, index) => candidate(recordId, index + 1, 1)),
  },
}, { limit: 5, reservedRecordIds: [ids[5], ids[6]] });
assert.equal(reservedFusion.candidates.length, 5, 'RRF must retain at most five records');
assert.ok(reservedFusion.candidates.some((entry) => entry.recordId === ids[5]));
assert.ok(reservedFusion.candidates.some((entry) => entry.recordId === ids[6]),
  'Every explicitly requested comparison item must retain a ranking slot');
assert.deepEqual(reservedFusion.missingReservedRecordIds, []);
assert.deepEqual(reservedFusion.candidates.slice(0, 2).map((entry) => entry.recordId),
  [ids[5], ids[6]], 'Explicit reservations must remain ahead of ordinary RRF results');

let queryCount = 0;
let requestedIds = [];
const row = (recordId, rank, rrfScore, itemKey, name, price) => ({
  record_type: 'CATALOG_ITEM', record_id: recordId, knowledge_base_id: knowledgeBaseId,
  tenant_id: tenantId, publication_revision: 4,
  document_id: '91000000-0000-4000-8000-000000000001',
  document_version_id: '92000000-0000-4000-8000-000000000001',
  document_name: 'tenant-source.txt', source_page_start: 1, source_page_end: 1,
  document_display_name: 'Tenant Source', document_type: 'CATALOG',
  source_section: 'Approved options', source_line_start: 10, source_line_end: 20,
  document_status: 'ready', document_version_status: 'ready',
  document_version_is_current: true,
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
        row(ids[3], byId.get(ids[3]).rank, byId.get(ids[3]).rrf_score,
          'fourth-item', 'Fourth item', 40),
        { ...row(ids[4], byId.get(ids[4]).rank, byId.get(ids[4]).rrf_score,
          'fifth-item', 'Fifth item', 50),
        knowledge_base_id: byId.get(ids[4]).knowledge_base_id },
      ] };
    },
  });
};

let comparisonHydrationQueries = 0;
const categoryComparisonCandidate = candidate(ids[5], 6, 0.2, {
  recordType: 'CATALOG_CATEGORY', categoryKey: 'published-group',
});
// Published categories can use an item row as their anchor. Record type must
// therefore remain part of the authoritative identity even when IDs match.
const itemComparisonCandidate = candidate(ids[5], 7, 0.2);
const comparisonRetrieval = {
  tenantId, agentId, callId,
  recordTypes: ['CATALOG_ITEM', 'CATALOG_CATEGORY'],
  queryContext: {
    reservedRecords: [
      { recordId: ids[5], recordType: 'CATALOG_CATEGORY', reason: 'explicit_comparison' },
      { recordId: ids[5], recordType: 'CATALOG_ITEM', reason: 'explicit_comparison' },
    ],
  },
  channels: {
    structured: [
      ...ids.slice(0, 5).map((recordId, index) => candidate(recordId, index + 1, 1)),
      categoryComparisonCandidate, itemComparisonCandidate,
    ],
    bm25: [], qdrant: [],
  },
};
const comparisonResolution = {
  candidate: categoryComparisonCandidate,
  candidateNamespace: 'CATALOG',
  namespaceCandidates: { CATALOG: [
    { ...categoryComparisonCandidate, entityType: 'CATEGORY', explicit: true },
    { ...itemComparisonCandidate, entityType: 'ITEM', explicit: true },
  ] },
  routingCandidates: [],
};
const comparisonHydrated = await rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input,
  classification: {
    tenantId, agentId, callId,
    intentClass: knowledgeQueryClasses.COMPARISON_COMPLEX,
  },
  resolution: comparisonResolution, retrieval: comparisonRetrieval,
}, {
  contextRunner: async (_auth, callback) => callback({
    query: async (_sql, parameters) => {
      comparisonHydrationQueries += 1;
      const requested = JSON.parse(parameters[3]);
      return { rows: requested.map((entry) => ({
        ...row(entry.record_id, entry.rank, entry.rrf_score,
          `key-${entry.record_id}`, `Name ${entry.record_id}`, entry.rank * 10),
        record_type: entry.record_type,
        authoritative_data: entry.record_type === 'CATALOG_CATEGORY' ? {
          categoryKey: entry.category_key, category: 'Published Group',
          categoryAliases: ['Translated Group'], children: [],
        } : {
          itemKey: `key-${entry.record_id}`, name: `Name ${entry.record_id}`,
          aliases: ['Translated Item'], categoryKey: 'options', category: 'Options',
          price: entry.rank * 10, currency: 'USD', attributes: [],
          relationships: {}, selectionRules: {},
        },
      })) };
    },
  }),
});
assert.equal(comparisonHydrationQueries, 1);
assert.equal(comparisonHydrated.evidence.length, 5);
assert.equal(comparisonHydrated.comparisonCoverage.complete, true);
assert.equal(comparisonHydrated.comparisonCoverage.requestedRecordKeys.length, 2);
assert.ok(comparisonHydrated.evidence.some((entry) => entry.recordId === ids[5]
  && entry.recordType === 'CATALOG_CATEGORY'));
assert.ok(comparisonHydrated.evidence.some((entry) => entry.recordId === ids[5]
  && entry.recordType === 'CATALOG_ITEM'),
  'Every explicitly requested item/category must survive RRF and one-pass hydration');

const classification = {
  tenantId, agentId, callId,
  intentClass: knowledgeQueryClasses.KNOWN_INFORMATION,
  requiresConfirmation: true,
};
const resolution = {
  action: 'CONFIRM', candidateNamespace: 'CATALOG',
  candidate: { entityType: 'ITEM', recordId: ids[0] },
  routingCandidates: [ids[0], ids[1]].map((recordId, index) => ({
    recordId, recordType: 'CATALOG_ITEM', entityType: 'ITEM',
    itemKey: index ? 'shared-item-two' : 'shared-item-one',
    label: index ? 'Shared item two' : 'Shared item one',
    explicit: true, score: 0.9,
  })),
};
const hydrated = await rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution, retrieval,
}, { contextRunner });

assert.equal(queryCount, 1, 'Hydration must execute exactly one PostgreSQL query');
assert.equal(hydrated.hydrationQueryCount, 1);
assert.equal(hydrated.evidence.length, 5);
assert.equal(hydrated.verifiedRecords, hydrated.evidence,
  'The verified hydration result must be the evidence package source');
assert.deepEqual(hydrated.evidence.map((entry) => entry.rank),
  [...hydrated.evidence.map((entry) => entry.rank)].sort((left, right) => left - right));
assert.equal(hydrated.evidence.every((entry) => entry.hydrationValidated
  && entry.publicationValidated), true);
assert.equal(hydrated.evidence.every((entry) => entry.documentStatus === 'ready'
  && entry.documentVersionStatus === 'ready'
  && entry.documentVersionIsCurrent === true), true);
assert.equal(hydrated.evidence.every((entry) => entry.documentName === 'tenant-source.txt'), true);
assert.equal(hydrated.evidence.every((entry) => entry.pageNumber === 1), true);
assert.equal(hydrated.evidence.every((entry) => (
  entry.provenance.uploadedFilename === 'tenant-source.txt'
  && entry.provenance.documentDisplayName === 'Tenant Source'
  && entry.provenance.pageNumber === 1
  && entry.provenance.sourceSection === 'Approved options'
  && entry.provenance.sourceLineStart === 10
  && entry.provenance.sourceLineEnd === 20
)), true, 'Exact record/document/page/line provenance must survive authoritative hydration');
assert.equal(hydrated.ambiguity.detected, true);
assert.equal(hydrated.conflict.detected, true);
assert.equal(hydrated.conflict.conflicts[0].identity, 'catalog:options:shared item');
assert.ok(requestedIds.includes(ids[4]),
  'A separately scoped canonical identity must reach authoritative PostgreSQL validation');
assert.deepEqual(hydrated.rejectedRecordIds, [],
  'Every selected top-five identity must hydrate and verify in the same query');

await assert.rejects(() => rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution, retrieval,
}, {
  contextRunner: async (_auth, callback) => callback({
    query: async (_sql, parameters) => {
      const requested = JSON.parse(parameters[3]);
      return { rows: requested.slice(0, -1).map((entry, index) => ({
        ...row(entry.record_id, entry.rank, entry.rrf_score,
          `partial-${index}`, `Partial ${index}`, index + 1),
        knowledge_base_id: entry.knowledge_base_id,
      })) };
    },
  }),
}), (error) => error?.code === 'KNOWLEDGE_AUTHORITATIVE_HYDRATION_INCOMPLETE',
'Missing any selected top-five PostgreSQL record must fail hydration before packaging');

assert.equal(detectEntityAmbiguity(hydrated.evidence, {
  intentClass: knowledgeQueryClasses.COMPARISON_COMPLEX, requiresConfirmation: true,
}, resolution).detected, false, 'An intentional comparison must not be treated as ambiguity');

const semanticCandidate = {
  recordId: hydrated.evidence[0].recordId,
  recordType: hydrated.evidence[0].recordType,
  entityType: 'ITEM',
  label: 'Published semantic candidate',
  itemKey: 'published-semantic-candidate',
  score: 0.78,
  explicit: false,
  signals: [{ method: 'semantic', score: 0.78, explicit: false }],
};
const semanticAmbiguity = detectEntityAmbiguity(hydrated.evidence, {
  intentClass: knowledgeQueryClasses.KNOWN_INFORMATION, requiresConfirmation: true,
}, {
  action: 'CONFIRM',
  candidateNamespace: 'CATALOG',
  candidate: semanticCandidate,
  routingCandidates: [semanticCandidate],
});
assert.equal(semanticAmbiguity.detected, false,
  'One medium tenant-scoped candidate must not be reported as entity ambiguity');

const nearTiedCandidate = {
  ...semanticCandidate,
  recordId: hydrated.evidence[1].recordId,
  label: 'Second published semantic candidate',
  itemKey: 'second-published-semantic-candidate',
  score: 0.77,
};
const nearTiedAmbiguity = detectEntityAmbiguity(hydrated.evidence, {
  intentClass: knowledgeQueryClasses.KNOWN_INFORMATION, requiresConfirmation: true,
  confidenceConfiguration: {
    highConfidence: 0.86, clarificationConfidence: 0.64, ambiguityMargin: 0.06,
  },
}, {
  action: 'CONFIRM', candidateNamespace: 'CATALOG', candidate: semanticCandidate,
  routingCandidates: [semanticCandidate, nearTiedCandidate, {
    ...nearTiedCandidate, recordId: hydrated.evidence[2].recordId,
    recordType: 'FAQ', label: 'Foreign namespace candidate', score: 0.779,
  }],
});
assert.equal(nearTiedAmbiguity.detected, true,
  'Two hydrated candidates within the same namespace and tie window require clarification');
assert.deepEqual(nearTiedAmbiguity.candidates.map((entry) => entry.name), [
  'Published semantic candidate', 'Second published semantic candidate',
]);

assert.equal(detectEntityAmbiguity(hydrated.evidence, {
  intentClass: knowledgeQueryClasses.KNOWN_INFORMATION, requiresConfirmation: true,
  confidenceConfiguration: {
    highConfidence: 0.86, clarificationConfidence: 0.64, ambiguityMargin: 0.01,
  },
}, {
  action: 'CONFIRM', candidateNamespace: 'CATALOG', candidate: semanticCandidate,
  routingCandidates: [semanticCandidate, { ...nearTiedCandidate, score: 0.76 }],
}).detected, false, 'The selected agent ambiguity margin must control hydrated ambiguity');

assert.match(authoritativeHydrationSql, /assigned\.publication_revision=requested\.publication_revision/u);
assert.match(authoritativeHydrationSql, /status='approved'/u);
assert.match(authoritativeHydrationSql, /version\.is_current=true/u);
assert.match(authoritativeHydrationSql, /agent_knowledge_bases/u);
assert.match(authoritativeHydrationSql, /document_version_is_current/u);
assert.match(authoritativeHydrationSql, /requested\.record_type='CATALOG_CATEGORY'/u);
assert.match(authoritativeHydrationSql, /child\.category_key=anchor\.category_key/u);
assert.match(authoritativeHydrationSql, /'children',children\.values_json/u);

let emptyQueryCount = 0;
const empty = await rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution,
  retrieval: { tenantId, agentId, callId, channels: { structured: [], bm25: [], qdrant: [] } },
}, { contextRunner: async () => { emptyQueryCount += 1; return []; } });
assert.equal(emptyQueryCount, 0);
assert.equal(empty.hydrationQueryCount, 0);

await assert.rejects(() => rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId }, input, classification, resolution, retrieval,
}, { contextRunner: async () => [] }), (error) => (
  error?.code === 'KNOWLEDGE_AUTHORITATIVE_HYDRATION_EMPTY'
  && error?.details?.stage === 'authoritative_hydration'
  && error?.details?.selectedCandidates?.length > 0
));

await assert.rejects(() => rankAndHydrateAuthoritativeEvidence({
  auth: { tenantId: '90000000-0000-4000-8000-000000000099' },
  input, classification, resolution, retrieval,
}, { contextRunner }), /same-tenant/u);

console.log('RRF fusion and single-query authoritative PostgreSQL hydration verified.');
