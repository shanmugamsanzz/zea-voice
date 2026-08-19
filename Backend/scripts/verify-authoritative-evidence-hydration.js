import assert from 'node:assert/strict';
import {
  authoritativeEvidenceFromRow,
  hybridRetrievalSql,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
const authoritativeData = {
  catalogId: '55555555-5555-4555-8555-555555555555',
  catalogType: 'service_catalog', catalogName: 'Approved services',
  itemKey: 'service-a', name: 'Service A', aliases: ['First service'],
  category: 'Services', categoryAliases: ['Options'], categoryKey: 'services',
  parentCategoryKey: 'offerings', categoryDescription: 'Approved category description',
  categorySelectionRules: { mode: 'caller_choice' }, description: 'Complete description',
  price: 25, currency: 'USD', displayOrder: 1,
  attributes: [{ key: 'duration', name: 'Duration', value: '30 minutes', displayOrder: 1 }],
  relationships: { related: ['service-b'] }, selectionRules: { selectable: true },
};
const evidence = authoritativeEvidenceFromRow({
  record_type: 'CATALOG_ITEM', record_id: recordId, knowledge_base_id: knowledgeBaseId,
  tenant_id: tenantId, agent_id: agentId, publication_revision: 9,
  document_id: '66666666-6666-4666-8666-666666666666',
  document_version_id: '77777777-7777-4777-8777-777777777777',
  document_name: 'catalog.txt', source_page_start: 2, source_page_end: 3,
  language: 'en', content: 'Hydrated authoritative content.', caller_facing: true,
  authoritative_data: authoritativeData, score: 0.93, rank: 1,
});
assert.equal(evidence.tenantId, tenantId);
assert.equal(evidence.agentId, agentId);
assert.equal(evidence.knowledgeBaseId, knowledgeBaseId);
assert.equal(evidence.publicationRevision, 9);
assert.deepEqual(evidence.authoritativeData, authoritativeData);
assert.equal(evidence.hydrationValidated, true);
assert.equal(evidence.publicationValidated, true);
assert.equal(evidence.knowledgeBaseStatus, 'published');
assert.equal(evidence.recordStatus, 'approved');
assert.equal(evidence.documentStatus, 'ready');
assert.equal(evidence.documentVersionStatus, 'ready');
assert.equal(evidence.documentVersionIsCurrent, true);
const strictScope = {
  tenantId, agentId, requireHydratedEvidence: true,
  publicationRevisions: [{ knowledgeBaseId, publicationRevision: 9 }],
};
assert.equal(evidenceBelongsToRuntime(evidence, strictScope), true);
assert.equal(evidenceBelongsToRuntime({ ...evidence, documentStatus: 'deleted' }, strictScope), false);
assert.equal(evidenceBelongsToRuntime({ ...evidence, documentVersionIsCurrent: false }, strictScope), false);
assert.equal(evidenceBelongsToRuntime({ ...evidence, hydrationValidated: false }, strictScope), false);
const envelope = buildGroundingEnvelope({
  found: true,
  matches: [{ id: recordId, recordType: 'CATALOG_ITEM', content: evidence.content }],
  tenantEvidence: { sources: [evidence], entities: [] },
});
assert.equal(envelope.sources.length, 1);
assert.deepEqual(envelope.sources[0].authoritativeData, authoritativeData,
  'The LLM grounding source must receive the complete PostgreSQL record, not a duplicate snippet');
const prompt = buildAgentSystemPrompt({
  name: 'Configured Agent', language: 'en', settings: {}, prompt: 'Use approved evidence only.',
}, {
  usageDirection: 'inbound', knowledge: {
    found: true, route: 'llm_first', matches: [],
    tenantEvidence: { sources: [evidence], entities: [], actionEvidence: [], guidanceEvidence: [] },
  }, context: {}, maxPromptChars: 40_000,
});
assert.ok(prompt.includes('categorySelectionRules'));
assert.ok(prompt.includes('30 minutes'));

const sql = hybridRetrievalSql.hydrateEvidenceSql;
for (const requiredIsolation of [
  'f.tenant_id=$1', 'c.tenant_id=$1', 'i.tenant_id=$1', 'w.tenant_id=$1',
  'kb.status=\'published\'', 'v.is_current=true', "j.status='completed'",
  "j.metadata->>'publicationRevision'=kb.publication_revision::text",
]) assert.ok(sql.includes(requiredIsolation), `Missing hydration isolation: ${requiredIsolation}`);

for (const requiredDocumentState of [
  "f.status='approved'", "c.status='approved'", "i.status='approved'", "w.status='approved'",
  "v.status='ready'", "d.status='ready'",
]) assert.ok(sql.includes(requiredDocumentState), `Missing document-status isolation: ${requiredDocumentState}`);

for (const completeField of [
  "'aliases',i.aliases", "'categoryAliases',i.category_aliases",
  "'categorySelectionRules',i.category_selection_rules", "'attributes',attrs.values_json",
  "'relationships',i.relationships", "'selectionRules',i.selection_rules",
  "'conditions',w.conditions", "'actionConfig',w.action_config",
  "'sequenceOrder',f.sequence_order", "'variables',f.variables", "'transitions',f.transitions",
  "'chunkIndex',c.chunk_index", "'tokenCount',c.token_count",
]) assert.ok(sql.includes(completeField), `Missing complete authoritative field: ${completeField}`);

assert.match(sql, /jsonb_to_recordset/u);
assert.match(sql, /JOIN assigned/u);
for (const completeChain of [
  'v.knowledge_base_id=f.knowledge_base_id', 'v.document_id=f.document_id',
  'd.knowledge_base_id=f.knowledge_base_id',
  'v.knowledge_base_id=c.knowledge_base_id', 'v.document_id=c.document_id',
  'd.knowledge_base_id=c.knowledge_base_id',
  'v.knowledge_base_id=i.knowledge_base_id', 'v.document_id=i.document_id',
  'd.knowledge_base_id=i.knowledge_base_id',
  'sc.document_version_id=i.document_version_id', 'x.document_id=i.document_id',
  'v.knowledge_base_id=w.knowledge_base_id', 'v.document_id=w.document_id',
  'd.knowledge_base_id=w.knowledge_base_id',
]) assert.ok(sql.includes(completeChain), `Missing complete document isolation chain: ${completeChain}`);
console.log(JSON.stringify({
  task: 'authoritative-evidence-hydration', passed: true,
  completeRecords: true, tenantAgentKbRevisionIsolation: true, activeDocumentIsolation: true,
}));
