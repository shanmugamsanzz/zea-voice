import assert from 'node:assert/strict';
import {
  createCanonicalGroundedEvidence,
  selectRelevantAuthoritativeFacts,
} from '../src/knowledge-engine/grounded-evidence-representation.js';
import {
  assertGroundingEnvelopePreservesEvidence,
  buildGroundingEnvelope,
} from '../src/voice/interaction/grounded-llm-response.js';

const base = {
  id: 'published:catalog_item:record-a',
  recordId: 'record-a',
  recordType: 'CATALOG_ITEM',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  knowledgeBaseId: 'kb-a',
  publicationRevision: 3,
  documentId: 'document-a',
  documentVersionId: 'version-a',
  callerFacing: true,
  content: 'Rendered duplicate that must not enter the grounded record.',
  authoritativeData: {
    itemKey: 'option-a',
    name: 'Published Option A',
    description: 'Published description.',
    price: 125,
    currency: 'USD',
    attributes: [
      { key: 'arrival-timing', name: 'Arrival Timing', value: '09:30' },
      { key: 'unrelated-field', name: 'Unrelated Field', value: 'Not requested' },
    ],
    relationships: { compatible_with: ['option-b'] },
    selectionRules: { selectable: true },
    sourceText: 'Large duplicate publication source '.repeat(100),
  },
};

const priceFacts = selectRelevantAuthoritativeFacts(base, {
  requestedFact: 'price',
});
assert.equal(priceFacts.name, 'Published Option A');
assert.equal(priceFacts.price, 125);
assert.equal(priceFacts.currency, 'USD');
assert.equal('sourceText' in priceFacts, false);
assert.ok(JSON.stringify(priceFacts).length <= 900);

const timingFacts = selectRelevantAuthoritativeFacts(base, {
  requestedFact: 'timing',
});
assert.deepEqual(timingFacts.attributes, [
  { key: 'arrival-timing', name: 'Arrival Timing', value: '09:30' },
]);

const canonical = createCanonicalGroundedEvidence(base, 'source_1', {
  requestedFact: 'timing',
});
assert.equal(canonical.sourceId, 'source_1');
assert.equal(canonical.recordId, 'record-a');
assert.equal(canonical.recordType, 'CATALOG_ITEM');
assert.equal(canonical.canonicalName, 'Published Option A');
assert.equal('content' in canonical, false);
assert.equal('sourceText' in canonical.facts, false);
assert.deepEqual(canonical.facts, canonical.authoritativeData);

const canonicalEnvelope = buildGroundingEnvelope({
  found: true,
  tenantEvidence: { sources: [canonical] },
}, { includePublishedMap: false, maximumSources: 5 });
assert.equal(canonicalEnvelope.sources.length, 1);
assert.equal(canonicalEnvelope.sources[0].id, 'source_1');
assert.equal(canonicalEnvelope.sources[0].recordId, 'record-a');
assert.equal(canonicalEnvelope.sources[0].canonicalName, 'Published Option A');
assert.match(canonicalEnvelope.sources[0].content, /Published Option A/u);
assert.match(canonicalEnvelope.sources[0].content, /Arrival Timing/u);
assert.equal(assertGroundingEnvelopePreservesEvidence(
  [canonical], canonicalEnvelope,
), canonicalEnvelope);
assert.throws(() => assertGroundingEnvelopePreservesEvidence([canonical], {
  found: false, sources: [],
}), (error) => error?.code === 'KNOWLEDGE_GROUNDED_ENVELOPE_EVIDENCE_LOST'
  && error?.details?.missingRecords?.[0]?.recordId === 'record-a');

const comparison = [
  canonical,
  createCanonicalGroundedEvidence({
    ...base,
    id: 'published:catalog_item:record-b',
    recordId: 'record-b',
    authoritativeData: { ...base.authoritativeData, itemKey: 'option-b', name: 'Published Option B' },
  }, 'source_2', { requestedFact: 'comparison', intentClass: 'COMPARISON_COMPLEX' }),
];
assert.deepEqual(comparison.map((record) => record.recordId), ['record-a', 'record-b']);
assert.ok(comparison.every((record) => JSON.stringify(record.facts).length <= 900));

console.log('Schema-driven canonical evidence and relevance-based field selection verified.');
