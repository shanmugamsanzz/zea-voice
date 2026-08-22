import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  detectEvidenceConflict,
  mergeAndRerankCandidates,
  retainStrongCandidates,
  searchHybridPublishedKnowledge,
  selectStrongCallerMessage,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { sparseIndexCacheKey } from '../src/knowledge-bases/knowledge-map.service.js';

const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';
const agentA = '20000000-0000-4000-8000-000000000001';
const previouslyAssignedAgent = '20000000-0000-4000-8000-000000000002';
const kbA = '30000000-0000-4000-8000-000000000001';
const kbB = '30000000-0000-4000-8000-000000000002';
const documentId = '40000000-0000-4000-8000-000000000001';
const versionId = '50000000-0000-4000-8000-000000000001';
const ids = {
  location: '60000000-0000-4000-8000-000000000001',
  catalog: '60000000-0000-4000-8000-000000000002',
  tamil: '60000000-0000-4000-8000-000000000003',
  tanglish: '60000000-0000-4000-8000-000000000004',
  foreign: '60000000-0000-4000-8000-000000000005',
  currentRequest: '60000000-0000-4000-8000-000000000006',
  staleContext: '60000000-0000-4000-8000-000000000007',
  contextualFollowUp: '60000000-0000-4000-8000-000000000008',
  overview: '60000000-0000-4000-8000-000000000009',
};

const rows = new Map([
  [ids.location, {
    record_type: 'FAQ', record_id: ids.location, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'faq.txt',
    source_page_start: 1, source_page_end: 1, language: 'en',
    content: 'The office is beside Central Station.', caller_facing: true,
    authoritative_data: { question: 'Where is the office?', answer: 'The office is beside Central Station.' },
  }],
  [ids.catalog, {
    record_type: 'CATALOG_ITEM', record_id: ids.catalog, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'catalog.txt',
    source_page_start: 1, source_page_end: 1, language: 'en',
    content: 'Item: Solar Max\nCode: SKU-X9\nPrice: 499 INR', caller_facing: true,
    authoritative_data: { itemKey: 'SKU-X9', name: 'Solar Max', price: '499', currency: 'INR' },
  }],
  [ids.tamil, {
    record_type: 'KNOWLEDGE_CHUNK', record_id: ids.tamil, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'knowledge.txt',
    source_page_start: 1, source_page_end: 1, language: 'ta',
    content: 'அலுவலகம் காலை ஒன்பது மணிக்கு திறக்கும்.', caller_facing: true,
    authoritative_data: { content: 'அலுவலகம் காலை ஒன்பது மணிக்கு திறக்கும்.' },
  }],
  [ids.tanglish, {
    record_type: 'FAQ', record_id: ids.tanglish, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'faq.txt',
    source_page_start: 2, source_page_end: 2, language: 'ta',
    content: 'Appointment onlineல book பண்ணலாம்.', caller_facing: true,
    authoritative_data: { question: 'Appointment எப்படி book பண்ணுவது?', answer: 'Appointment onlineல book பண்ணலாம்.' },
  }],
  [ids.currentRequest, {
    record_type: 'FAQ', record_id: ids.currentRequest, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'faq.txt',
    source_page_start: 3, source_page_end: 3, language: 'en',
    content: 'Returns are accepted within fourteen days.', caller_facing: true,
    authoritative_data: { answer: 'Returns are accepted within fourteen days.' },
  }],
  [ids.staleContext, {
    record_type: 'FAQ', record_id: ids.staleContext, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'faq.txt',
    source_page_start: 4, source_page_end: 4, language: 'en',
    content: 'The previous subject has a five-year term.', caller_facing: true,
    authoritative_data: { answer: 'The previous subject has a five-year term.' },
  }],
  [ids.contextualFollowUp, {
    record_type: 'FAQ', record_id: ids.contextualFollowUp, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'faq.txt',
    source_page_start: 5, source_page_end: 5, language: 'en',
    content: 'Express delivery arrives the next working day.', caller_facing: true,
    authoritative_data: { answer: 'Express delivery arrives the next working day.' },
  }],
  [ids.overview, {
    record_type: 'CONVERSATION_NODE', record_id: ids.overview, knowledge_base_id: kbA,
    document_id: documentId, document_version_id: versionId, document_name: 'conversation.txt',
    source_page_start: 1, source_page_end: 1, language: 'ta',
    content: 'Published overview response.', caller_facing: true,
    authoritative_data: {
      nodeKey: 'complete_overview', nodeType: 'message', content: 'Published overview response.',
      variables: [{
        key: 'situation',
        value: 'The caller asks for the complete package overview or all available options.',
      }],
    },
  }],
]);

const sparseIndex = {
  version: 1, algorithm: 'bm25', tenantId: tenantA, knowledgeBaseId: kbA, publicationRevision: 3,
  documents: [
    {
      id: ids.location, recordType: 'FAQ', tenantId: tenantA, knowledgeBaseId: kbA,
      documentId, documentVersionId: versionId, publicationRevision: 3,
      language: 'en', usageDirection: 'both', content: 'The office is beside Central Station.',
      tokens: ['where', 'office', 'central', 'station', 'location'],
    },
    {
      id: ids.catalog, recordType: 'CATALOG_ITEM', tenantId: tenantA, knowledgeBaseId: kbA,
      documentId, documentVersionId: versionId, publicationRevision: 3,
      language: 'en', usageDirection: 'both', content: 'Solar Max SKU-X9 costs 499 INR.',
      tokens: ['solar', 'max', 'sku', 'x9', '499', 'inr'],
    },
  ],
};

class FakeRedis {
  status = 'ready';
  values = new Map([[sparseIndexCacheKey(tenantA, kbA, 3), JSON.stringify(sparseIndex)]]);
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
}

function semanticPoint(recordId, recordType, {
  tenantId = tenantA, knowledgeBaseId = kbA, language = 'en', score = 0.94,
  content = 'semantic preview', assignedAgentIds = [agentA],
} = {}) {
  return {
    id: recordId, score,
    payload: {
      tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 3,
      agent_usage: 'INBOUND', assigned_agent_ids: assignedAgentIds, record_id: recordId,
      record_type: recordType, document_id: documentId, document_version_id: versionId,
      language, content,
    },
  };
}

function dependencies({ points = [], slowEmbedding = false, conversationRoutes = [] } = {}) {
  const cache = new FakeRedis();
  return {
    cache, ragEnabled: true,
    contextRunner: async (auth, operation) => operation({
      async query(sql, values) {
        const text = String(sql);
        if (text.includes('AS agent_usage') && text.includes('knowledge_bases')) {
          assert.equal(auth.tenantId, tenantA);
          return { rows: [{
            agent_usage: 'inbound',
            knowledge_bases: [{ id: kbA, publicationRevision: 3, priority: 1 }],
          }] };
        }
        if (text.includes("'conversation_route'::text AS projection_type")) {
          return { rows: conversationRoutes };
        }
        assert.match(text, /jsonb_to_recordset/u);
        assert.equal(values[0], tenantA);
        const requested = JSON.parse(values[3]);
        return {
          rows: requested.map((candidate) => {
            const row = rows.get(candidate.record_id);
            return row && row.knowledge_base_id === candidate.knowledge_base_id
              ? { ...row, rank: candidate.rank, score: candidate.score } : null;
          }).filter(Boolean),
        };
      },
    }),
    embed: async (query) => {
      if (slowEmbedding) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return [query];
    },
    search: async (_tenantId, vector) => (typeof points === 'function' ? points(String(vector[0])) : points),
  };
}

async function search(query, options = {}) {
  return searchHybridPublishedKnowledge({ tenantId: tenantA }, {
    agentId: agentA, query, usageDirection: 'inbound', language: options.language ?? 'en', topK: 5,
    currentTopic: options.currentTopic,
    contextualFollowUp: options.contextualFollowUp,
    pendingQuestion: options.pendingQuestion,
    knownEntities: options.knownEntities ?? [],
  }, dependencies(options));
}

const paraphrase = await search('How do I find your workplace?', {
  points: [semanticPoint(ids.location, 'FAQ')],
});
assert.equal(paraphrase.sources[0].content, 'The office is beside Central Station.');

const deterministicOverview = await search(
  'Could you give me a complete overview of the available health screening options?',
  {
    conversationRoutes: [{
      id: ids.overview, node_key: 'complete_overview', node_type: 'message',
      content: 'Published overview response.',
      variables: [{
        key: 'situation',
        value: 'The caller asks for the complete package overview or all available options.',
      }],
      language: 'ta', knowledge_base_id: kbA, document_id: documentId,
      document_version_id: versionId, publication_revision: 3,
    }],
  },
);
assert.equal(deterministicOverview.decision.response?.recordId, ids.overview,
  'published Conversation metadata must route an unseen English overview without a vector hit');

const assignmentChangedAfterPublish = await search('How do I find your workplace?', {
  points: [semanticPoint(ids.location, 'FAQ', { assignedAgentIds: [previouslyAssignedAgent] })],
});
assert.equal(assignmentChangedAfterPublish.sources[0].recordId, ids.location,
  'current PostgreSQL assignment must authorize hydration when the Qdrant assignment snapshot is stale');

for (const query of ['SKU-X9', '499 INR', 'Solar Max']) {
  const exact = await search(query);
  assert.equal(exact.sources[0].recordId, ids.catalog, `BM25 must find exact fact: ${query}`);
  assert.equal(exact.sources[0].authoritativeData.price, '499');
}

const tamil = await search('ஆபீஸ் எத்தனை மணிக்கு திறக்கும்?', {
  language: 'ta', points: [semanticPoint(ids.tamil, 'KNOWLEDGE_CHUNK', { language: 'ta' })],
});
assert.equal(tamil.sources[0].recordId, ids.tamil);

const tanglishMisspelling = await search('apoinment epdi buk panrathu?', {
  language: 'ta', points: [semanticPoint(ids.tanglish, 'FAQ', { language: 'ta' })],
});
assert.equal(tanglishMisspelling.sources[0].recordId, ids.tanglish);

const timeoutStarted = performance.now();
const timeoutFallback = await search('SKU-X9', { slowEmbedding: true });
assert.ok(performance.now() - timeoutStarted < 600, 'Slow embeddings must not block BM25 fallback');
assert.equal(timeoutFallback.sources[0].recordId, ids.catalog);

const rejected = await search('private foreign evidence', {
  points: [semanticPoint(ids.foreign, 'FAQ', { tenantId: tenantB, knowledgeBaseId: kbB })],
});
assert.equal(rejected.found, false, 'Cross-tenant Qdrant evidence must be rejected before hydration');

const weakEvidence = await search('uncertain request', {
  points: [semanticPoint(ids.location, 'FAQ', { score: 0.2 })],
});
assert.equal(weakEvidence.found, false, 'Weak evidence must be rejected before hydration');
assert.equal(weakEvidence.decision.type, 'CLARIFY');
assert.equal(weakEvidence.decision.reason, 'weak_evidence');

const explicitTopicChange = await search('What is the return window?', {
  currentTopic: 'previous subject term',
  points: (query) => (query === 'What is the return window?'
    ? [semanticPoint(ids.currentRequest, 'FAQ', { score: 0.94 })]
    : [
      semanticPoint(ids.staleContext, 'FAQ', { score: 0.99 }),
      semanticPoint(ids.currentRequest, 'FAQ', { score: 0.8 }),
    ]),
});
assert.equal(explicitTopicChange.sources[0].recordId, ids.currentRequest,
  'A strong result for the finalized utterance must outrank stale conversational context');
assert.equal(explicitTopicChange.retrieval.contextualUsed, false);

const genuineFollowUp = await search('What about that one?', {
  currentTopic: 'express delivery',
  contextualFollowUp: true,
  pendingQuestion: 'Would you like details about express delivery?',
  knownEntities: [{ key: 'express-delivery', name: 'express delivery' }],
  points: (query) => (query === 'What about that one?'
    ? []
    : [semanticPoint(ids.contextualFollowUp, 'FAQ', { score: 0.94 })]),
});
assert.equal(genuineFollowUp.sources[0].recordId, ids.contextualFollowUp,
  'Context may resolve a follow-up only when the finalized utterance has insufficient evidence');
assert.equal(genuineFollowUp.retrieval.contextualUsed, true);

const deduplicated = mergeAndRerankCandidates([
  { recordType: 'FAQ', recordId: ids.location, knowledgeBaseId: kbA, semanticScore: 0.9, channelRank: 1 },
], [
  { recordType: 'FAQ', recordId: ids.location, knowledgeBaseId: kbA, lexicalScore: 2, tokenCoverage: 1, channelRank: 1 },
], 'office location', 'en', 5);
assert.equal(deduplicated.length, 1);
assert.deepEqual(deduplicated[0].channels.sort(), ['bm25', 'semantic']);

const strongOnly = retainStrongCandidates([
  { recordType: 'FAQ', recordId: 'strong', knowledgeBaseId: kbA, semanticScore: 0.92, channels: ['semantic'] },
  { recordType: 'FAQ', recordId: 'weak', knowledgeBaseId: kbA, semanticScore: 0.2, lexicalScore: 0.1, tokenCoverage: 0.05, channels: ['semantic'] },
], 'delivery details', 5);
assert.deepEqual(strongOnly.map((candidate) => candidate.recordId), ['strong']);

const authoritativeBm25Fallback = retainStrongCandidates([
  {
    recordType: 'CATALOG_ITEM', recordId: 'catalog-bm25', knowledgeBaseId: kbA,
    semanticScore: 0, lexicalScore: 14.2, tokenCoverage: 0.44, channels: ['bm25'],
  },
  {
    recordType: 'CONVERSATION_NODE', recordId: 'message-bm25', knowledgeBaseId: kbA,
    semanticScore: 0, lexicalScore: 4.7, tokenCoverage: 0.4, channels: ['bm25'],
  },
], 'natural caller request', 5);
assert.deepEqual(authoritativeBm25Fallback.map((candidate) => candidate.recordId), [
  'catalog-bm25', 'message-bm25',
], 'strong structured BM25 evidence must survive a semantic-channel miss');

const publishedOverview = {
  id: 'published:conversation_node:message-bm25', recordType: 'CONVERSATION_NODE',
  recordId: 'message-bm25', callerFacing: true, content: 'Published overview response.',
  authoritativeData: {
    nodeType: 'message', variables: [{ key: 'situation', value: 'Caller requests an overview.' }],
  },
  semanticScore: 0, lexicalScore: 4.7, tokenCoverage: 0.4,
  retrievalScore: 0.31, retrievalContext: 'primary', channels: ['bm25'], rank: 1,
};
assert.equal(selectStrongCallerMessage([publishedOverview], 'unseen overview wording', {}), publishedOverview,
  'an unambiguous caller-facing published message may be selected from strong BM25 evidence');

const crossLanguageOverview = {
  ...publishedOverview,
  semanticScore: 0.2, lexicalScore: 0, tokenCoverage: 0,
  retrievalScore: 0.45, channels: ['semantic'],
  authoritativeData: {
    nodeType: 'message',
    variables: [
      {
        key: 'situation',
        value: 'The caller asks for the complete package overview or all available options.',
      },
      {
        key: 'examples',
        value: ['what packages are available', 'okay, explain the options'],
      },
    ],
  },
};
assert.equal(selectStrongCallerMessage(
  [crossLanguageOverview],
  'Could you give me a complete overview of the available health screening options?',
  {},
), crossLanguageOverview,
'published routing metadata must resolve an unseen cross-language overview paraphrase');

const conflict = detectEvidenceConflict([
  {
    recordType: 'CATALOG_ITEM', recordId: 'a', retrievalContext: 'primary', retrievalScore: 0.91,
    authoritativeData: { itemKey: 'same-item', price: 100, currency: 'USD' },
  },
  {
    recordType: 'CATALOG_ITEM', recordId: 'b', retrievalContext: 'primary', retrievalScore: 0.88,
    authoritativeData: { itemKey: 'same-item', price: 120, currency: 'USD' },
  },
]);
assert.equal(conflict.detected, true);
assert.equal(conflict.type, 'conflicting_facts');
assert.deepEqual(conflict.factPaths, ['price']);

const ordinaryAlternatives = detectEvidenceConflict([
  {
    recordType: 'FAQ', recordId: 'location', retrievalContext: 'primary', retrievalScore: 0.91,
    authoritativeData: { question: 'Where are you located?', answer: 'Published location.' },
  },
  {
    recordType: 'FAQ', recordId: 'hours', retrievalContext: 'primary', retrievalScore: 0.89,
    authoritativeData: { question: 'When are you open?', answer: 'Published hours.' },
  },
]);
assert.equal(ordinaryAlternatives.detected, false,
  'different relevant records are normal evidence, not contradictory facts');

const complementarySameItem = detectEvidenceConflict([
  {
    recordType: 'CATALOG_ITEM', recordId: 'details-a', retrievalContext: 'primary', retrievalScore: 0.92,
    authoritativeData: { itemKey: 'same-item', price: 100, attributes: { duration: 'Two days' } },
  },
  {
    recordType: 'CATALOG_ITEM', recordId: 'details-b', retrievalContext: 'primary', retrievalScore: 0.9,
    authoritativeData: { itemKey: 'same-item', price: 100, attributes: { consultation: 'Included' } },
  },
]);
assert.equal(complementarySameItem.detected, false,
  'complementary facts for the same entity must be available to grounded reasoning');

const serviceSource = await readFile(new URL('../src/knowledge-bases/hybrid-knowledge-retrieval.service.js', import.meta.url), 'utf8');
assert.doesNotMatch(serviceSource, /intentKeywords|triggerPhrases|packageKeywords|hospital|appointment/iu,
  'The generic retrieval service must not contain business intent keywords');
assert.match(serviceSource, /Promise\.all/u);
assert.doesNotMatch(serviceSource, /assigned\.includes\(String\(input\.agentId/u,
  'stale Qdrant assignment snapshots must not override current PostgreSQL assignment');
assert.ok(serviceSource.indexOf('mergeAndRerankCandidates') < serviceSource.indexOf('hydrate('));

console.log(JSON.stringify({
  task: 'clean-hybrid-retrieval', passed: true,
  semanticParaphrases: true, exactCodesPricesNames: true,
  languages: ['Tamil', 'Tanglish', 'English'], misspellingsAndSttVariations: true,
  timeoutFallback: true, crossTenantRejection: true,
  latestRequestIsolation: true, genuineFollowUpResolution: true,
}));
