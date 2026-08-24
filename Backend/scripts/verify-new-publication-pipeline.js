import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  KNOWLEDGE_DOCUMENT_CONTRACT_VERSION,
  SUPPORTED_KNOWLEDGE_DOCUMENT_CONTRACT_VERSIONS,
} from '../src/knowledge-bases/knowledge-document-contract.js';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import {
  KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
  buildPublicationIndexes,
  buildPublicationPhraseForms,
} from '../src/knowledge-engine/publication-index-builder.js';
import { cacheCompactKnowledgeMap } from '../src/knowledge-bases/knowledge-map.service.js';

const ids = Array.from({ length: 16 }, (_value, index) => (
  `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
));
const job = {
  tenant_id: ids[0],
  knowledge_base_id: ids[1],
  targetRevision: 4,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [ids[2]],
};
const common = (index, recordType) => ({
  record_id: ids[index + 3],
  record_type: recordType,
  document_id: ids[index + 8],
  document_version_id: ids[index + 11],
  usage_direction: 'both',
  language: 'en',
  source_page_start: 1,
  source_page_end: 2,
  document_name: `uploaded-${index}.pdf`,
  document_display_name: `Tenant Document ${index}`,
  document_type: recordType === 'catalog_item' ? 'catalog' : null,
  source_section: `section-${index}`,
  source_line_start: 10 + index,
  source_line_end: 12 + index,
});
const records = [
  {
    ...common(0, 'catalog_item'),
    question: 'Example plan',
    answer: 'Example plan is available for 25 credits.',
    content: 'Example plan. Price 25 credits.',
    entity_name: 'Example Plan',
    entity_category: 'Plans',
    entity_aliases: ['Sample plan'],
    entity_category_aliases: ['Options'],
    entity_metadata: { itemKey: 'example-plan', categoryKey: 'plans' },
  },
  {
    ...common(1, 'faq'),
    question: 'When are you open?',
    answer: 'We are open on published business days.',
    content: 'Question: When are you open? Answer: We are open on published business days.',
    entity_aliases: ['opening time'],
    entity_category_aliases: [],
    entity_metadata: {},
  },
  {
    ...common(2, 'workflow_rule'),
    question: 'create reservation',
    answer: 'I can help collect the required reservation details.',
    content: 'Workflow create reservation.',
    entity_name: 'Create reservation',
    entity_category: 'booking',
    entity_aliases: ['book now'],
    entity_category_aliases: [],
    entity_metadata: {
      conditions: { examples: ['reserve a time'] },
      actionType: 'configured_tool',
      actionConfig: {
        responseMode: 'instruction',
        actionKey: 'create_reservation',
        toolIdentifier: 'create_reservation',
        requiresCatalogItem: true,
        scenarioTargetItemKey: 'example-plan',
      },
    },
  },
  {
    ...common(3, 'conversation_node'),
    question: 'greeting',
    answer: 'Welcome. How may I help?',
    content: 'Conversation guidance: Welcome. How may I help?',
    entity_name: 'greeting',
    entity_category: 'main',
    entity_aliases: ['hello'],
    entity_category_aliases: [],
    entity_metadata: {},
  },
  {
    ...common(4, 'knowledge_chunk'),
    question: null,
    answer: 'Published background evidence.',
    content: 'Published background evidence.',
    entity_aliases: [],
    entity_category_aliases: [],
    entity_metadata: {},
  },
];

assert.equal(KNOWLEDGE_DOCUMENT_CONTRACT_VERSION, 2);
assert.deepEqual(SUPPORTED_KNOWLEDGE_DOCUMENT_CONTRACT_VERSIONS, [1, 2]);
const extraction = {
  fullText: 'Q: Is this versioned?\nA: Yes.',
  pages: [{ pageNumber: 1, lines: ['Q: Is this versioned?', 'A: Yes.'] }],
};
const parsedFaq = processExtractedCategory('faq', extraction);
assert.equal(parsedFaq.parserVersion, 2);
assert.equal(parsedFaq.records[0].sourceSection, 'Is this versioned?');
assert.equal(parsedFaq.records[0].sourceLineStart, 1);
assert.equal(parsedFaq.records[0].sourceLineEnd, 2);
assert.equal(processExtractedCategory('faq', extraction, { parserVersion: 1 }).parserVersion, 1);
assert.throws(() => processExtractedCategory('faq', extraction, { parserVersion: 99 }), /parser version/u);

const forms = buildPublicationPhraseForms(['On-co Plan', 'ON CO plan']);
assert.ok(forms.normalized.includes('on co plan'));
assert.ok(forms.stt.includes('oncoplan'));
assert.ok(forms.phonetic.length > 0);

const bundle = buildPublicationIndexes(job, records);
assert.equal(bundle.version, KNOWLEDGE_PUBLICATION_BUNDLE_VERSION);
assert.equal(bundle.validation.valid, true);
assert.equal(bundle.records.length, 5);
assert.equal(bundle.answerCards.length, 4);
assert.ok(bundle.entityIndex.exact['example plan']);
assert.ok(bundle.routeIndex.exact['reserve a time']);
assert.ok(bundle.routeIndex.namespaces.workflow.exact['reserve a time']);
assert.equal(bundle.routeIndex.namespaces.faq.exact['reserve a time'], undefined);
assert.equal(Object.values(bundle.routeIndex.namespaces).every((namespace) => (
  Object.values(namespace.exact).flat().every((candidate) => candidate.entityType !== 'ITEM')
)), true, 'Intent namespaces must never contain Catalog entity candidates');
assert.equal(bundle.answerCards.find((card) => card.recordType === 'WORKFLOW_RULE').decision, 'TOOL');
assert.match(bundle.manifest.contentHash, /^[a-f0-9]{64}$/u);

assert.throws(() => buildPublicationIndexes(job, [
  ...records,
  { ...records[0], record_id: ids[15] },
]), (error) => error?.code === 'KNOWLEDGE_PUBLICATION_VALIDATION_FAILED'
  && error.details.issues.some((issue) => issue.code === 'DUPLICATE_CATALOG_ITEM_KEY'));
assert.throws(() => buildPublicationIndexes(job, records.map((record) => (
  record.record_type === 'workflow_rule'
    ? { ...record, entity_metadata: {
      ...record.entity_metadata,
      actionConfig: { ...record.entity_metadata.actionConfig, scenarioTargetItemKey: 'missing-item' },
    } }
    : record
))), (error) => error?.details.issues.some((issue) => issue.code === 'UNKNOWN_WORKFLOW_ITEM'));

class FakeRedis {
  status = 'ready';
  values = new Map();
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async get(key) { return this.values.get(key) ?? null; }
  async del(...keys) {
    let count = 0;
    for (const key of keys) count += this.values.delete(key) ? 1 : 0;
    return count;
  }
  async exists(key) { return this.values.has(key) ? 1 : 0; }
}
const cache = new FakeRedis();
const artifacts = await cacheCompactKnowledgeMap(job, bundle.records, cache, bundle);
assert.equal(artifacts.verified, true);
assert.deepEqual(new Set(Object.keys(artifacts.keys)), new Set([
  'map', 'sparse', 'evidence', 'entity', 'route', 'answers', 'manifest',
]));
assert.equal(JSON.parse(await cache.get(artifacts.keys.manifest)).contentHash, bundle.manifest.contentHash);
assert.ok(JSON.parse(await cache.get(artifacts.keys.entity)).exact['example plan']);
const cachedEvidence = JSON.parse(await cache.get(artifacts.keys.evidence)).records[0];
assert.equal(cachedEvidence.documentName, 'uploaded-0.pdf');
assert.equal(cachedEvidence.documentDisplayName, 'Tenant Document 0');
assert.equal(cachedEvidence.pageNumber, 1);
assert.equal(cachedEvidence.pageEnd, 2);
assert.equal(cachedEvidence.sourceSection, 'section-0');
assert.equal(cachedEvidence.sourceLineStart, 10);

const implementation = await readFile(
  new URL('../src/knowledge-engine/publication-index-builder.js', import.meta.url),
  'utf8',
);
assert.doesNotMatch(implementation, /Shanmuga|hospital|health check|package/iu);

console.log('Versioned parsing and atomic universal publication indexes verified.');
