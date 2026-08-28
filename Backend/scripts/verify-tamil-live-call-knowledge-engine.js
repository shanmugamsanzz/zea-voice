import assert from 'node:assert/strict';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  createKnowledgeEngineInput,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';
import { retrieveTenantEvidence } from '../src/knowledge-bases/knowledge-runtime.service.js';
import { buildRevisionSparseIndex, cacheCompactKnowledgeMap } from '../src/knowledge-bases/knowledge-map.service.js';
import { openIsolatedCallMemory } from '../src/knowledge-engine/call-memory.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Tamil live-call regression requires between 3 and 20 repeated passes');

const fixture = Object.freeze({
  tenantId: '11000000-0000-4000-8000-000000000001',
  agentId: '22000000-0000-4000-8000-000000000001',
  knowledgeBaseId: '33000000-0000-4000-8000-000000000001',
  publicationRevision: 1,
  language: 'ta',
});
const purposeQuestion = '\u0b8e\u0ba4\u0bc1\u0b95\u0bcd\u0b95\u0bc1 phone \u0baa\u0ba3\u0bcd\u0ba3\u0bbf\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc0\u0b99\u0bcd\u0b95?';
const purposeVariation = '\u0b8f\u0ba9\u0bcd \u0b8e\u0ba4\u0bc1\u0b95\u0bcd\u0b95\u0bc1\u0b99\u0bcd\u0b95 phone \u0baa\u0ba3\u0bcd\u0ba3\u0bbf\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc0\u0b99\u0bcd\u0b95';
const overviewQuestion = '\u0b8e\u0ba9\u0bcd\u0ba9 packages \u0b87\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc1?';
const overviewVariation = '\u0b89\u0b99\u0bcd\u0b95\u0b95\u0bbf\u0b9f\u0bcd\u0b9f \u0b8e\u0ba9\u0bcd\u0ba9 packages\u0bb2\u0bbe\u0bae\u0bcd \u0b87\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc1';
const purposeAnswer = '\u0b8e\u0b99\u0bcd\u0b95\u0bb3\u0bc1\u0b9f\u0bc8\u0baf approved \u0b9a\u0bc7\u0bb5\u0bc8\u0b95\u0bb3\u0bcd \u0baa\u0bb1\u0bcd\u0bb1\u0bbf\u0baf \u0ba4\u0b95\u0bb5\u0bb2\u0bc8 \u0bb5\u0bb4\u0b99\u0bcd\u0b95 \u0b87\u0ba8\u0bcd\u0ba4 \u0b85\u0bb4\u0bc8\u0baa\u0bcd\u0baa\u0bc1.';
const overviewAnswer = '\u0b8e\u0b99\u0bcd\u0b95\u0bb3\u0bbf\u0b9f\u0bae\u0bcd Silver \u0bae\u0bb1\u0bcd\u0bb1\u0bc1\u0bae\u0bcd Gold packages \u0b89\u0bb3\u0bcd\u0bb3\u0ba9.';
const itemAnswer = 'Silver package \u0bb5\u0bbf\u0bb2\u0bc8 INR 1000. \u0b87\u0ba4\u0bbf\u0bb2\u0bcd approved basic screening \u0b89\u0bb3\u0bcd\u0bb3\u0ba4\u0bc1.';

const turns = Object.freeze([
  { id: 'purpose', utterance: purposeQuestion, expectedRecordId: '44000000-0000-4000-8000-000000000001', expectedResponse: purposeAnswer },
  { id: 'purpose-stt', utterance: purposeVariation, expectedRecordId: '44000000-0000-4000-8000-000000000001', expectedResponse: purposeAnswer },
  { id: 'overview', utterance: overviewQuestion, expectedRecordId: '44000000-0000-4000-8000-000000000002', expectedResponse: overviewAnswer },
  { id: 'details', utterance: 'Silver package details \u0b9a\u0bca\u0bb2\u0bcd\u0bb2\u0bc1\u0b99\u0bcd\u0b95', expectedRecordId: '44000000-0000-4000-8000-000000000003', expectedResponse: itemAnswer },
  { id: 'price', utterance: 'Silver package price \u0b8e\u0ba9\u0bcd\u0ba9?', requestedFacts: ['price'], expectedRecordId: '44000000-0000-4000-8000-000000000003', expectedResponse: itemAnswer },
]);

function sourceRecord(index, values) {
  const suffix = String(index).padStart(12, '0');
  return Object.freeze({
    record_id: values.recordId,
    record_type: values.recordType,
    document_id: `55000000-0000-4000-8000-${suffix}`,
    document_version_id: `66000000-0000-4000-8000-${suffix}`,
    usage_direction: 'both',
    language: fixture.language,
    question: values.question,
    answer: values.answer,
    content: values.answer,
    entity_name: values.name,
    entity_category: values.category ?? null,
    entity_aliases: values.aliases ?? [],
    entity_category_aliases: values.categoryAliases ?? [],
    entity_metadata: values.metadata ?? {},
  });
}

const sourceRecords = Object.freeze([
  sourceRecord(1, {
    recordId: turns[0].expectedRecordId, recordType: 'conversation_node',
    question: purposeQuestion, answer: purposeAnswer, name: 'Call purpose',
    aliases: [purposeQuestion, purposeVariation],
    metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  }),
  sourceRecord(2, {
    recordId: turns[2].expectedRecordId, recordType: 'conversation_node',
    question: overviewQuestion, answer: overviewAnswer, name: 'Available packages',
    aliases: [overviewQuestion, overviewVariation],
    metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  }),
  sourceRecord(3, {
    recordId: turns[3].expectedRecordId, recordType: 'catalog_item',
    question: 'Silver package details', answer: itemAnswer, name: 'Silver Package',
    category: 'Packages', aliases: ['silver', 'silver package'], categoryAliases: ['packages'],
    metadata: {
      itemKey: 'silver-package', categoryKey: 'packages', price: 1000, currency: 'INR',
      description: 'approved basic screening உள்ளது',
      selectionRules: { selectable: true },
    },
  }),
]);
const job = Object.freeze({
  tenant_id: fixture.tenantId,
  knowledge_base_id: fixture.knowledgeBaseId,
  targetRevision: fixture.publicationRevision,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [fixture.agentId],
});
const publicationBundle = buildPublicationIndexes(job, sourceRecords);
const sparseIndex = buildRevisionSparseIndex(job, publicationBundle.records);
const recordsById = new Map(sourceRecords.map((record) => [record.record_id, record]));
const cacheValues = new Map();
const cache = Object.freeze({
  status: 'ready',
  async get(key) { return cacheValues.get(key) ?? null; },
  async set(key, value) { cacheValues.set(key, value); return 'OK'; },
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) deleted += cacheValues.delete(key) ? 1 : 0;
    return deleted;
  },
});
await cacheCompactKnowledgeMap(job, publicationBundle.records, cache, publicationBundle);

function hydratedRow(candidate) {
  const source = recordsById.get(String(candidate.record_id));
  if (!source) return null;
  const metadata = source.entity_metadata ?? {};
  const recordType = String(source.record_type).toUpperCase();
  const authoritativeData = recordType === 'CATALOG_ITEM' ? {
    itemKey: metadata.itemKey, categoryKey: metadata.categoryKey,
    name: source.entity_name, category: source.entity_category,
    description: metadata.description,
    price: metadata.price, currency: metadata.currency,
    sourceText: source.answer, selectionRules: metadata.selectionRules,
  } : { content: source.answer, conditions: metadata.conditions };
  return {
    record_type: recordType, record_id: source.record_id,
    knowledge_base_id: candidate.knowledge_base_id,
    publication_revision: candidate.publication_revision,
    document_id: source.document_id, document_version_id: source.document_version_id,
    document_name: `${source.record_type}.txt`, source_page_start: 1, source_page_end: 1,
    language: source.language, content: source.answer, caller_facing: true,
    authoritative_data: authoritativeData, rank: candidate.rank, rrf_score: candidate.rrf_score,
  };
}

function contextRunner(_auth, operation) {
  return operation({
    query: async (_sql, parameters) => {
      if (parameters.length === 3) return { rows: [{
        knowledge_base_id: fixture.knowledgeBaseId,
        publication_revision: fixture.publicationRevision,
        priority: 1,
      }] };
      const requested = JSON.parse(parameters[3]);
      return { rows: requested.map(hydratedRow).filter(Boolean) };
    },
  });
}

const results = [];
let runtimeExceptions = 0;

for (let pass = 1; pass <= repeats; pass += 1) {
  const callId = `77000000-0000-4000-8000-${String(pass).padStart(12, '0')}`;
  const memory = openIsolatedCallMemory({
    tenantId: fixture.tenantId, agentId: fixture.agentId, callId,
  }, { language: fixture.language });
  try {
    for (const [turnIndex, turn] of turns.entries()) {
      const input = createKnowledgeEngineInput({
        tenantId: fixture.tenantId, agentId: fixture.agentId, callId,
        utterance: turn.utterance, language: fixture.language, usageDirection: 'inbound',
        requestedFacts: turn.requestedFacts ?? [], memory: memory.snapshot(),
      });
      let result;
      try {
        result = await retrieveTenantEvidence({ tenantId: fixture.tenantId }, input, {
          cache, contextRunner, runtimeProfile: { tools: [] }, throwOnError: true,
          retrievalDependencies: { embed: async () => [0.1, 0.2], search: async () => [] },
        });
      } catch (error) {
        runtimeExceptions += 1;
        throw new Error(`pass ${pass}, ${turn.id}: runtime exception: ${error.message}`, { cause: error });
      }
      assert.equal(result.decision.type, knowledgeEngineDecisionTypes.RESPONSE,
        `pass ${pass}, ${turn.id}: known question must return RESPONSE ${JSON.stringify({
          reason: result.decision.reason,
          classification: result.classification,
          resolution: result.resolution,
          evidenceIds: result.evidenceIds,
        })}`);
      assert.equal(result.decision.mode, knowledgeEngineResponseModes.DETERMINISTIC,
        `pass ${pass}, ${turn.id}: known hydrated evidence must bypass the LLM`);
      const validated = result.decision;
      if (turn.expectedRecordId === turns[3].expectedRecordId) {
        assert.match(validated.response?.text ?? '', /Silver Package/iu);
        assert.match(validated.response?.text ?? '', /1000\s+INR/iu);
      } else assert.equal(validated.response?.text, turn.expectedResponse,
        `pass ${pass}, ${turn.id}: incorrect response ${JSON.stringify({
          validated,
          selectedEvidenceIds: result.evidenceIds,
          plannedEvidenceIds: result.decision.evidenceIds,
          evidence: result.authoritative.evidence.map((source) => ({
            id: source.id,
            type: source.recordType,
            content: source.content,
            authoritativeData: source.authoritativeData,
          })),
        })}`);
      memory.applyEngineDecision(validated, {
        entity: result.entities[0] ?? null,
        category: null,
        explicitEntity: result.entities.length > 0,
        citedEvidence: result.authoritative.evidence,
      });
      assert.ok(result.evidenceIds.length > 0,
        `pass ${pass}, ${turn.id}: known question returned empty evidence`);
      assert.ok(result.authoritative.evidence.some((source) => (
        source.recordId === turn.expectedRecordId && source.hydrationValidated === true
      )), `pass ${pass}, ${turn.id}: expected authoritative evidence was not hydrated`);
      assert.ok(result.publicationRevisions.length > 0,
        `pass ${pass}, ${turn.id}: active publication revision was not reported`);
      assert.equal(result.error, undefined,
        `pass ${pass}, ${turn.id}: technical fallback result was returned`);
      assert.doesNotMatch(String(result.decision.reason), /technical|unavailable|cancelled/iu,
        `pass ${pass}, ${turn.id}: technical fallback decision was returned`);
      results.push({
        pass, turn: turnIndex + 1, id: turn.id,
        evidenceIds: result.evidenceIds, response: validated.response.text,
      });
    }
  } finally {
    memory.close();
  }
}

assert.equal(runtimeExceptions, 0, 'Live-call replay must have zero runtime exceptions');
assert.equal(results.length, repeats * turns.length);
console.log(JSON.stringify({
  gate: 'tamil-live-call-knowledge-engine', passed: true, repeats,
  turnsPerPass: turns.length, totalTurns: results.length,
  runtimeExceptions, emptyEvidenceTurns: 0, technicalFallbackTurns: 0,
  verifiedTurns: results,
}, null, 2));
