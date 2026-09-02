import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { evaluateFirstAudioSlo, percentile } from '../src/voice/interaction/voice-latency-slo.js';
import { buildDeterministicSourceMap } from '../src/knowledge-engine/deterministic-source-mapping.js';

const sources = Array.from({ length: 8 }, (_, index) => ({
  id: `record-${index + 1}`,
  recordId: `record-${index + 1}`,
  recordType: 'KNOWLEDGE_CHUNK',
  publishedEvidenceId: 'published-' + (index + 1),
  tenantId: 'tenant-1', agentId: 'agent-1',
  knowledgeBaseId: 'kb-1', publicationRevision: 9,
  documentId: 'document-' + (index + 1),
  documentVersionId: 'version-' + (index + 1),
  content: `Approved evidence record ${index + 1}.`,
  authoritativeData: { content: `Approved evidence record ${index + 1}.` },
}));
const knowledge = {
  found: true,
  route: 'hybrid',
  tenantEvidence: {
    found: true,
    sources,
    sourceMap: buildDeterministicSourceMap(sources),
    actionEvidence: [],
    guidanceEvidence: [{
      recordId: 'guidance-1', content: 'Keep the answer short.',
      authoritativeData: { nodeType: 'guidance' },
    }],
    entities: [],
  },
  compactKnowledgeMap: {
    maps: [{
      knowledgeBaseId: 'kb-1', publicationRevision: 9,
      records: [{ id: 'map-only', type: 'KNOWLEDGE_CHUNK', summary: 'DUPLICATED_MAP_TEXT' }],
    }],
    records: [{ id: 'map-only', type: 'KNOWLEDGE_CHUNK', summary: 'DUPLICATED_MAP_TEXT' }],
  },
};

const compactEnvelope = buildGroundingEnvelope(knowledge, {
  includePublishedMap: false,
  maximumSources: 5,
});
assert.equal(compactEnvelope.sources.length, 5);
assert.ok(compactEnvelope.sources.every((source) => source.recordType === 'KNOWLEDGE_CHUNK'));

const prompt = buildAgentSystemPrompt({
  name: 'Generic Agent', goal: 'Answer from approved evidence', language: 'English',
  prompt: 'Follow the tenant-authored conversation policy.', settings: {},
}, {
  usageDirection: 'inbound', knowledge, maxPromptChars: 16_000,
  context: {
    groundedResponseMode: true,
    compactGrounding: true,
    groundedDecisionInput: {
      currentQuestion: 'What is available?',
      recentRelevantTurns: [],
      canonicalMemory: {
        activeEntity: null, activeCategory: null, comparisonEntities: [],
        pendingClarification: null, activeTool: null, collectedToolFields: {},
      },
      hydratedRecords: [],
      requestedFact: 'options',
      ambiguityCandidates: [],
      workflowAuthorization: [],
      toolSchemas: [],
    },
  },
});
assert.ok(prompt.length <= 12_000);
assert.doesNotMatch(prompt, /DUPLICATED_MAP_TEXT/u);
assert.doesNotMatch(prompt, /<runtime_context>|<knowledge_context>/u);
assert.match(prompt, /<company_instructions>/u);
assert.match(prompt, /<grounded_turn_input>/u);
assert.match(prompt, /<\/grounded_turn_input>/u);
assert.match(prompt, /<\/grounded_response_contract>/u);
assert.match(prompt, /Only answer contains caller-facing speech/u);

const observed = evaluateFirstAudioSlo(Array.from({ length: 20 }, (_, index) => 500 + index * 20));
assert.equal(observed.observed.p50, 680);
assert.equal(observed.observed.p90, 840);
assert.equal(observed.observed.p95, 860);
assert.equal(percentile([40, 60, 80, 100, 120], 0.95), 120);

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /compactGrounding: true/u);
assert.match(orchestrator, /streaming\.onSentence\?\.\(sentence\)/u);
assert.match(orchestrator, /voice\.first_audio_percentiles/u);
assert.match(orchestrator, /retrievalP90Ms/u);

console.log('Compact live prompt and latency instrumentation verification passed.');
