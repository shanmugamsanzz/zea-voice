import assert from 'node:assert/strict';
import {
  hybridRetrievalSql,
  isolatedRetrievalQueries,
  searchHybridPublishedKnowledge,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
const documentId = '55555555-5555-4555-8555-555555555555';
const versionId = '66666666-6666-4666-8666-666666666666';

const latestUtterance = 'What does it include?';
const queries = isolatedRetrievalQueries({
  query: 'stale replacement must be ignored', latestCallerUtterance: latestUtterance,
  currentTopic: 'stale topic', lastAnswer: 'stale answer',
  pendingQuestion: 'Would you like details?',
  knownEntities: [{ key: 'premium-plan', name: 'Premium Plan', category: 'Plans' }],
  recentTurns: [{ role: 'assistant', content: 'old conversation content' }],
});
assert.equal(queries.primary, latestUtterance);
assert.match(queries.contextual, /Premium Plan/u);
assert.match(queries.contextual, /Would you like details\?/u);
assert.doesNotMatch(queries.contextual, /stale topic|stale answer|old conversation content/u);

function dependencies({ primaryStrong }) {
  const embeddedQueries = [];
  const searchedVectors = [];
  const hydratedManifests = [];
  return {
    embeddedQueries, searchedVectors, hydratedManifests,
    runtime: {
      cache: { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } },
      ragEnabled: true,
      async embed(query) {
        embeddedQueries.push(query);
        return [embeddedQueries.length];
      },
      async search(_tenantId, vector) {
        searchedVectors.push(vector[0]);
        const relevant = primaryStrong ? vector[0] === 1 : vector[0] === 2;
        return relevant ? [{
          id: recordId, score: 0.95,
          payload: {
            tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
            publication_revision: 7, record_type: 'CATALOG_ITEM', record_id: recordId,
            document_id: documentId, document_version_id: versionId,
            language: 'en', agent_usage: 'BOTH', assigned_agent_ids: [agentId],
            content: 'Premium Plan includes approved benefits.',
          },
        }] : [];
      },
      async contextRunner(_auth, operation) {
        return operation({
          async query(sql, values) {
            if (!String(sql).includes('jsonb_to_recordset')) return {
              rows: [{
                agent_usage: 'both',
                knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 7 }],
              }],
            };
            hydratedManifests.push(JSON.parse(values[3]));
            return { rows: [{
              record_type: 'CATALOG_ITEM', record_id: recordId,
              tenant_id: tenantId, agent_id: agentId, knowledge_base_id: knowledgeBaseId,
              publication_revision: 7, document_id: documentId, document_version_id: versionId,
              document_name: 'published-catalog.txt', source_page_start: 1, source_page_end: 1,
              language: 'en', content: 'Premium Plan includes approved benefits.',
              caller_facing: true,
              authoritative_data: {
                itemKey: 'premium-plan', name: 'Premium Plan', price: 100, currency: 'USD',
                attributes: [{ key: 'benefits', value: ['Approved benefit'] }],
                relationships: {}, selectionRules: { selectable: true },
              },
              rank: 1, score: 0.95,
            }] };
          },
        });
      },
    },
  };
}

const commonInput = {
  agentId, query: latestUtterance, latestCallerUtterance: latestUtterance,
  usageDirection: 'inbound', language: 'en', pendingQuestion: 'Would you like details?',
  knownEntities: [{ key: 'premium-plan', name: 'Premium Plan', category: 'Plans' }],
};

const strong = dependencies({ primaryStrong: true });
const primaryResult = await searchHybridPublishedKnowledge(
  { tenantId }, commonInput, strong.runtime,
);
assert.deepEqual(strong.embeddedQueries, [latestUtterance]);
assert.equal(primaryResult.retrieval.contextualUsed, false);
assert.equal(primaryResult.sources[0].authoritativeData.attributes[0].key, 'benefits');
assert.equal(primaryResult.sources[0].hydrationValidated, true);
assert.equal(primaryResult.sources[0].publicationValidated, true);

const weak = dependencies({ primaryStrong: false });
const contextualResult = await searchHybridPublishedKnowledge(
  { tenantId }, commonInput, weak.runtime,
);
assert.equal(weak.embeddedQueries[0], latestUtterance);
assert.equal(weak.embeddedQueries.length, 2);
assert.match(weak.embeddedQueries[1], /Premium Plan/u);
assert.match(weak.embeddedQueries[1], /Would you like details\?/u);
assert.equal(contextualResult.retrieval.contextualUsed, true);
assert.equal(contextualResult.sources[0].retrievalContext, 'contextual');
assert.equal(weak.hydratedManifests.length, 1);

const sql = hybridRetrievalSql.hydrateEvidenceSql;
for (const required of [
  "kb.status='published'", "j.status='completed'",
  "j.metadata->>'publicationRevision'=kb.publication_revision::text",
  "status='approved'", 'v.is_current=true', "v.status='ready'", "d.status='ready'",
  'v.knowledge_base_id=', 'v.document_id=', 'd.knowledge_base_id=',
]) assert.ok(sql.includes(required), `Missing authoritative hydration isolation: ${required}`);

console.log(JSON.stringify({
  task: 'final-stt-hybrid-hydration', passed: true,
  latestUtterancePrimary: true, contextualOnlyAfterWeakPrimary: true,
  completePostgresHydration: true, publicationAndDocumentIsolation: true,
}));
