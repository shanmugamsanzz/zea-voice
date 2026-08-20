import assert from 'node:assert/strict';
import {
  authoritativeEvidenceFromRow,
  focusAuthoritativeCatalogEvidence,
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
const focused = focusAuthoritativeCatalogEvidence([
  evidence,
  {
    ...evidence, id: 'published:faq:unrelated', recordId: '88888888-8888-4888-8888-888888888888',
    recordType: 'FAQ', authoritativeData: { question: 'Unrelated overview' }, rank: 2,
  },
  {
    ...evidence, id: 'published:conversation_node:overview',
    recordId: '99999999-9999-4999-8999-999999999999', recordType: 'CONVERSATION_NODE',
    callerFacing: true, authoritativeData: { nodeType: 'message' }, rank: 3,
  },
], { knownEntities: [{ key: 'service-a', name: 'Service A' }] }, 5);
assert.equal(focused.focused, true);
assert.deepEqual(focused.evidence.map((item) => item.recordId), [recordId]);
assert.deepEqual(focused.evidence[0].authoritativeData.attributes, authoritativeData.attributes);
assert.deepEqual(focused.evidence[0].authoritativeData.relationships, authoritativeData.relationships);
const previousItem = {
  ...evidence, id: 'published:catalog_item:previous', recordId: 'previous-record',
  retrievalContext: 'contextual',
  authoritativeData: {
    ...authoritativeData, itemKey: 'previous-service', name: 'Previous Service',
    aliases: ['Previous plan'],
  },
};
const latestItem = {
  ...evidence, id: 'published:catalog_item:latest', recordId: 'latest-record',
  retrievalContext: 'primary',
  authoritativeData: {
    ...authoritativeData, itemKey: 'latest-service', name: 'Latest Service',
    aliases: ['Latest plan'],
  },
};
const latestFocused = focusAuthoritativeCatalogEvidence([
  latestItem, previousItem,
], {
  query: 'Tell me about the latest plan',
  latestCallerUtterance: 'Tell me about the latest plan',
  knownEntities: [{ key: 'previous-service', name: 'Previous Service' }],
}, 5);
assert.deepEqual(latestFocused.evidence.map((item) => item.recordId), ['latest-record'],
  'Latest primary Catalog evidence must replace a stale remembered entity');
const overviewMessage = {
  ...evidence, id: 'published:conversation_node:overview-message',
  recordId: 'overview-message-record', recordType: 'CONVERSATION_NODE',
  callerFacing: true, retrievalContext: 'primary', semanticScore: 0.95,
  authoritativeData: { nodeType: 'message', nodeKey: 'available-overview' },
  content: 'The published overview response.',
};
const overviewFocused = focusAuthoritativeCatalogEvidence([
  { ...latestItem, semanticScore: 0.82 }, overviewMessage,
], {
  latestCallerUtterance: 'What options are available?',
  preferredCallerMessage: overviewMessage,
  knownEntities: [],
}, 5);
assert.equal(overviewFocused.evidence[0].recordId, 'overview-message-record',
  'A strongly matched caller-facing published response must outrank Catalog evidence');
const explicitCatalogFocused = focusAuthoritativeCatalogEvidence([
  latestItem, overviewMessage,
], {
  latestCallerUtterance: 'Tell me about the selected published item',
  preferredCallerMessage: overviewMessage,
  catalogIdentityResolved: true,
  knownEntities: [],
}, 5);
assert.deepEqual(explicitCatalogFocused.evidence.map((item) => item.recordId), ['latest-record'],
  'An explicitly resolved Catalog identity must remove unrelated caller-facing guidance');
const contextualMessage = {
  ...overviewMessage, id: 'published:conversation_node:contextual-message',
  recordId: 'contextual-message-record', retrievalContext: 'contextual',
};
const unrelatedCatalogCandidate = {
  ...latestItem, retrievalContext: 'primary', semanticScore: 0.76, rank: 5,
};
const acknowledgementEvidence = focusAuthoritativeCatalogEvidence([
  {
    ...evidence, id: 'published:faq:nearby', recordId: 'nearby-faq',
    recordType: 'FAQ', retrievalContext: 'contextual', rank: 1,
  },
  contextualMessage,
  unrelatedCatalogCandidate,
], {
  latestCallerUtterance: 'A short contextual reply',
  knownEntities: [],
}, 5);
assert.equal(acknowledgementEvidence.focused, false);
assert.ok(acknowledgementEvidence.evidence.some((item) => (
  item.recordId === 'contextual-message-record'
)), 'A lower-ranked unrelated Catalog candidate must not erase contextual Conversation evidence');
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
const compactPrompt = buildAgentSystemPrompt({
  name: 'Configured Agent', language: 'en', settings: {}, prompt: 'x'.repeat(10_000),
}, {
  usageDirection: 'inbound', knowledge: {
    found: true, route: 'llm_first', matches: [],
    tenantEvidence: { sources: [evidence], entities: [], actionEvidence: [], guidanceEvidence: [] },
  }, context: { groundedResponseMode: true, compactGrounding: true }, maxPromptChars: 12_000,
});
assert.ok(compactPrompt.length <= 12_000);
const contractJson = compactPrompt.match(/<grounded_response_contract>\n([\s\S]*?)\n<\/grounded_response_contract>/u)?.[1];
const knowledgeJson = compactPrompt.match(/<knowledge_context>\n([\s\S]*?)\n<\/knowledge_context>/u)?.[1];
assert.ok(contractJson && knowledgeJson, 'Compact prompt must preserve complete tagged sections');
assert.doesNotThrow(() => JSON.parse(contractJson), 'Grounded decision schema must remain valid JSON');
assert.doesNotThrow(() => JSON.parse(knowledgeJson), 'Knowledge evidence must remain valid JSON');
assert.match(knowledgeJson, /"relationships"/u);
assert.match(knowledgeJson, /30 minutes/u);

const sql = hybridRetrievalSql.hydrateEvidenceSql;
const categorySql = hybridRetrievalSql.catalogCategoryCandidatesSql;
const identitySql = hybridRetrievalSql.catalogIdentitySql;
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
  "'sourceText',i.source_text",
  "'relationships',i.relationships", "'selectionRules',i.selection_rules",
  "'conditions',w.conditions", "'actionConfig',w.action_config",
  "'sequenceOrder',f.sequence_order", "'variables',f.variables", "'transitions',f.transitions",
  "'chunkIndex',c.chunk_index", "'tokenCount',c.token_count",
]) assert.ok(sql.includes(completeField), `Missing complete authoritative field: ${completeField}`);

assert.match(sql, /jsonb_to_recordset/u);
assert.match(sql, /JOIN assigned/u);
assert.match(categorySql, /i\.category_key=\$6/u);
assert.match(categorySql, /sc\.id=\$5::uuid/u);
assert.match(categorySql, /v\.is_current=true/u);
assert.match(categorySql, /j\.metadata->>'publicationRevision'=kb\.publication_revision::text/u);
assert.match(identitySql, /requested_scope/u);
assert.match(identitySql, /rs\.publication_revision=kb\.publication_revision/u);
assert.match(identitySql, /i\.status='approved'/u);
assert.match(identitySql, /v\.is_current=true/u);
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
  completeRecords: true, catalogFocused: true, promptSchemaPreserved: true,
  tenantAgentKbRevisionIsolation: true, activeDocumentIsolation: true,
}));
