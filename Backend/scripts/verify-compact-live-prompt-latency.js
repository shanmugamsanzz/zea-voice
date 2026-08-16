import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { evaluateFirstAudioSlo, percentile } from '../src/voice/interaction/voice-latency-slo.js';

const sources = Array.from({ length: 8 }, (_, index) => ({
  id: `record-${index + 1}`,
  recordId: `record-${index + 1}`,
  recordType: 'KNOWLEDGE_CHUNK',
  content: `Approved evidence record ${index + 1}.`,
  authoritativeData: { content: `Approved evidence record ${index + 1}.` },
}));
const knowledge = {
  found: true,
  route: 'hybrid',
  tenantEvidence: {
    found: true,
    sources,
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
    liveCallMemory: {
      currentTopic: 'current request', knownEntities: [], pendingQuestion: null,
      collectedInformation: {}, recentTurns: [], lastAnswer: '', activeToolRequest: null,
    },
  },
});
assert.ok(prompt.length < 16_000);
assert.doesNotMatch(prompt, /DUPLICATED_MAP_TEXT/u);
assert.ok(prompt.indexOf('<runtime_context>') < prompt.indexOf('<knowledge_context>'));
assert.ok(prompt.indexOf('<knowledge_context>') < prompt.indexOf('<company_instructions>'));

const observed = evaluateFirstAudioSlo(Array.from({ length: 20 }, (_, index) => 500 + index * 20));
assert.equal(observed.observed.p50, 680);
assert.equal(observed.observed.p90, 840);
assert.equal(observed.observed.p95, 860);
assert.equal(percentile([40, 60, 80, 100, 120], 0.95), 120);

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /compactGrounding: this\.unifiedGroundedDecisionEnabled/u);
assert.match(orchestrator, /streaming\.onSentence\?\.\(sentence\)/u);
assert.match(orchestrator, /voice\.first_audio_percentiles/u);
assert.match(orchestrator, /retrievalP90Ms/u);

console.log('Compact live prompt and latency instrumentation verification passed.');
