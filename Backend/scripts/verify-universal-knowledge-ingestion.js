import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWLEDGE_DOCUMENT_CONTRACTS,
  KNOWLEDGE_DOCUMENT_TYPES,
  normalizeKnowledgeDocumentMetadata,
} from '../src/knowledge-bases/knowledge-document-contract.js';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { buildSemanticPoint } from '../src/knowledge-bases/semantic-index.service.js';
import { buildCompactKnowledgeMap } from '../src/knowledge-bases/knowledge-map.service.js';

const uuids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function extraction(...lines) {
  return { fullText: lines.join('\n'), pages: [{ pageNumber: 1, lines }] };
}

assert.deepEqual(new Set(KNOWLEDGE_DOCUMENT_TYPES), new Set([
  'catalog', 'workflow_rules', 'conversation_script', 'faq', 'general_knowledge',
]));
for (const type of KNOWLEDGE_DOCUMENT_TYPES) {
  assert.ok(KNOWLEDGE_DOCUMENT_CONTRACTS[type].postgresRecords.length);
  assert.ok(KNOWLEDGE_DOCUMENT_CONTRACTS[type].semanticRecordTypes.length);
  const metadata = normalizeKnowledgeDocumentMetadata(type, { language: 'TA' });
  assert.equal(metadata.language, 'ta');
  assert.equal(metadata.documentContract.type, type);
}

const parsed = {
  catalog: processExtractedCategory('catalog', extraction('Example Service INR 100')),
  workflow_rules: processExtractedCategory('workflow_rules', extraction(
    'RULE: answer_example', 'MATCH: explain the service', 'RESPONSE_MODE: exact', 'RESPONSE: Approved answer.',
  )),
  conversation_script: processExtractedCategory('conversation_script', extraction(
    'STAGE: welcome', 'LANGUAGE: en', 'RESPONSE: Welcome.',
  )),
  faq: processExtractedCategory('faq', extraction('Q: What is available?', 'A: The approved service is available.')),
  general_knowledge: processExtractedCategory('general_knowledge', extraction('Stable approved company information.')),
};
for (const type of KNOWLEDGE_DOCUMENT_TYPES) {
  assert.ok(parsed[type].recordCount > 0, `${type} must parse into approved-record candidates`);
}

const recordTypes = ['catalog_item', 'workflow_rule', 'conversation_node', 'faq', 'knowledge_chunk'];
const records = recordTypes.map((recordType, index) => ({
  record_id: uuids[index + 1],
  record_type: recordType,
  document_id: uuids[(index + 2) % uuids.length],
  document_version_id: uuids[(index + 3) % uuids.length],
  usage_direction: 'both',
  language: index % 2 ? 'ta' : 'en',
  content: `Approved ${recordType} evidence`,
}));
const job = {
  tenant_id: uuids[0],
  knowledge_base_id: uuids[1],
  targetRevision: 7,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [uuids[5]],
};
for (const record of records) {
  const point = buildSemanticPoint(job, record, [0.1, 0.2]);
  assert.equal(point.payload.tenant_id, job.tenant_id);
  assert.equal(point.payload.knowledge_base_id, job.knowledge_base_id);
  assert.equal(point.payload.publication_revision, 7);
  assert.equal(point.payload.language, record.language);
  assert.deepEqual(point.payload.assigned_agent_ids, job.assigned_agent_ids);
  assert.ok(point.payload.document_type);
}

const map = buildCompactKnowledgeMap(job, records);
assert.equal(map.recordCount, 5);
assert.deepEqual(new Set(map.records.map((record) => record.type)), new Set(recordTypes.map((type) => type.toUpperCase())));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const semanticSource = fs.readFileSync(path.join(root, 'src/knowledge-bases/semantic-index.service.js'), 'utf8');
assert.match(semanticSource, /'conversation_node'::text/);
assert.ok(semanticSource.indexOf('finishIndexJob(job') < semanticSource.lastIndexOf("revisionMode: 'older'"),
  'The new revision must become usable before stale vectors are removed');
assert.doesNotMatch(
  fs.readFileSync(path.join(root, 'src/knowledge-bases/knowledge-document-contract.js'), 'utf8'),
  /Shanmuga|Hospital|package price/iu,
  'The universal ingestion contract must not contain company-specific business configuration',
);

console.log('Universal five-document ingestion verification passed.');
