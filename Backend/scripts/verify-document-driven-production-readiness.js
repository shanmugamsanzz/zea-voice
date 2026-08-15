import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  searchPublishedKnowledge,
} from '../src/knowledge-bases/knowledge-runtime.service.js';
import {
  activeLiveCallMemoryCount,
  openLiveCallMemory,
} from '../src/voice/interaction/live-call-memory.js';
import { isInternalRuntimeText } from '../src/voice/realtime-conversation-orchestrator.js';

const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';
const agentA = '20000000-0000-4000-8000-000000000001';
const agentB = '20000000-0000-4000-8000-000000000002';
const kbA = '30000000-0000-4000-8000-000000000001';
const kbB = '30000000-0000-4000-8000-000000000002';
const faqA = '40000000-0000-4000-8000-000000000001';
const faqB = '40000000-0000-4000-8000-000000000002';

function profile(knowledgeBaseId, faqId, answer) {
  return {
    agent_usage: 'both', agent_settings: {},
    knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 4, priority: 1, semanticReady: true }],
    catalog_items: [], workflows: [], conversations: [], general_knowledge: [],
    faqs: [{
      id: faqId, knowledge_base_id: knowledgeBaseId,
      document_id: faqId, document_version_id: faqId, document_name: 'faq.txt',
      source_page_start: 1, source_page_end: 1,
      question: 'Natural customer question', answer, language: 'both',
    }],
  };
}

const profiles = new Map([
  [tenantA, profile(kbA, faqA, 'Tenant A approved answer.')],
  [tenantB, profile(kbB, faqB, 'Tenant B approved answer.')],
]);
const contextRunner = async (auth, callback) => callback({
  query: async (sql, values) => {
    const selected = profiles.get(auth.tenantId);
    if (!String(sql).includes('jsonb_to_recordset')) return { rows: [structuredClone(selected)] };
    const requested = JSON.parse(values[3]);
    return { rows: requested.map((candidate) => {
      const faq = selected.faqs.find((item) => item.id === candidate.record_id);
      return faq ? {
        record_type: 'FAQ', record_id: faq.id, knowledge_base_id: faq.knowledge_base_id,
        document_id: faq.document_id, document_version_id: faq.document_version_id,
        document_name: faq.document_name, source_page_start: faq.source_page_start,
        source_page_end: faq.source_page_end, language: faq.language,
        content: faq.answer, caller_facing: true,
        authoritative_data: { question: faq.question, answer: faq.answer },
        rank: candidate.rank, score: candidate.score,
      } : null;
    }).filter(Boolean) };
  },
});
const point = (tenantId, knowledgeBaseId, agentId, recordId) => ({
  id: recordId, score: 0.98,
  payload: {
    tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 4,
    agent_usage: 'BOTH', assigned_agent_ids: [agentId], record_id: recordId, record_type: 'FAQ',
  },
});
const dependencies = {
  ragEnabled: true, contextRunner, embed: async () => [0.1],
  search: async () => [point(tenantA, kbA, agentA, faqA), point(tenantB, kbB, agentB, faqB)],
  cache: { status: 'end' },
};

for (const test of [
  { tenantId: tenantA, agentId: agentA, query: 'இதுக்கு என்ன பதில்?', expected: 'Tenant A approved answer.' },
  { tenantId: tenantB, agentId: agentB, query: 'Idha Tanglish-la explain pannunga', expected: 'Tenant B approved answer.' },
  { tenantId: tenantA, agentId: agentA, query: 'Could you explain this naturally?', expected: 'Tenant A approved answer.' },
]) {
  const result = await searchPublishedKnowledge({ tenantId: test.tenantId }, {
    agentId: test.agentId, query: test.query, usageDirection: 'inbound', language: 'both',
  }, dependencies);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].content, test.expected);
}

const timeoutStarted = performance.now();
const bounded = await searchPublishedKnowledge({ tenantId: tenantA }, {
  agentId: agentA, query: 'semantic request', usageDirection: 'inbound', language: 'en',
}, { ...dependencies, embed: async () => new Promise((resolve) => setTimeout(() => resolve([0.1]), 1_000)) });
assert.ok(performance.now() - timeoutStarted < 500, 'Semantic retrieval must have a bounded deadline');
assert.equal(bounded.sources.length, 0);

const settings = { conversationLanguage: 'en' };
const memoryA = openLiveCallMemory({ tenantId: tenantA, workspaceId: 'wa', agentId: agentA, callId: 'call-a' }, settings);
const memoryB = openLiveCallMemory({ tenantId: tenantB, workspaceId: 'wb', agentId: agentB, callId: 'call-b' }, settings);
memoryA.append({ role: 'user', content: 'private tenant A turn' });
assert.equal(memoryB.snapshot().messages.some((turn) => turn.content.includes('tenant A')), false);
memoryA.close();
memoryB.close();
assert.equal(activeLiveCallMemoryCount(), 0);

assert.equal(isInternalRuntimeText('RESPONSE_MODE: instruction'), true);
assert.equal(isInternalRuntimeText('{"flowAction":"continue","evidenceSourceIds":[]}'), true);

const orchestrator = fs.readFileSync(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
const agentRuntime = fs.readFileSync(new URL('../src/agents/agent-runtime.service.js', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../src/knowledge-bases/knowledge-base.routes.js', import.meta.url), 'utf8');
assert.doesNotMatch(orchestrator, /detectConversationIntent|routeKnowledgeQuery|understandingOnly/u);
assert.doesNotMatch(agentRuntime, /routeKnowledgeQuery|groundedUnderstandingContract|understandingOnly/u);
assert.match(route, /searchPublishedKnowledge/u);
assert.match(orchestrator, /executeAgentTools/u);
assert.match(orchestrator, /toolCalls\.length/u);
assert.match(orchestrator, /setActiveToolRequest/u);

console.log(JSON.stringify({
  task: 'document-driven-production-readiness',
  tenantsVerified: 2,
  languagesExercised: ['Tamil', 'Tanglish', 'English'],
  stageBlocking: false,
  crossTenantLeak: false,
  crossCallLeak: false,
  internalTextBlocked: true,
  retrievalBounded: true,
}));
