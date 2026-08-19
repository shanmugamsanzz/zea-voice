import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { searchHybridPublishedKnowledge } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { sparseIndexCacheKey } from '../src/knowledge-bases/knowledge-map.service.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';
import { validateDecisionSecurity } from '../src/voice/interaction/grounded-decision-security.js';
import { resolveNextConfiguredQuestion } from '../src/voice/interaction/next-question-policy.js';
import { InterruptionCandidateManager } from '../src/voice/interruption/interruption-candidate-manager.js';
import { task10Industries } from './fixtures/task-10-industries.js';

function words(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
}

class FixtureCache {
  status = 'ready';
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
}

function dependencies(fixture, allFixtures) {
  const cache = new FixtureCache();
  cache.values.set(sparseIndexCacheKey(fixture.tenantId, fixture.kbId, fixture.revision), JSON.stringify({
    version: 1, algorithm: 'bm25', tenantId: fixture.tenantId,
    knowledgeBaseId: fixture.kbId, publicationRevision: fixture.revision,
    documents: [{
      id: fixture.recordId, recordType: 'FAQ', tenantId: fixture.tenantId,
      knowledgeBaseId: fixture.kbId, documentId: fixture.recordId,
      documentVersionId: fixture.recordId, publicationRevision: fixture.revision,
      language: fixture.language, usageDirection: 'both', content: fixture.fact,
      tokens: [...words(fixture.query), ...words(fixture.fact)],
    }],
  }));
  const point = (entry, revision = entry.revision) => ({
    id: entry.recordId, score: 0.97,
    payload: {
      tenant_id: entry.tenantId, knowledge_base_id: entry.kbId,
      publication_revision: revision, agent_usage: 'INBOUND',
      assigned_agent_ids: [entry.agentId], record_id: entry.recordId,
      record_type: 'FAQ', document_id: entry.recordId,
      document_version_id: entry.recordId, language: entry.language, content: entry.fact,
    },
  });
  return {
    cache, ragEnabled: true, embed: async () => [0.1],
    search: async () => [
      point(fixture),
      point(allFixtures.find((entry) => entry.tenantId !== fixture.tenantId)),
      point(fixture, fixture.revision - 1),
    ],
    contextRunner: async (auth, operation) => operation({
      async query(sql, values) {
        if (String(sql).includes('AS agent_usage') && String(sql).includes('knowledge_bases')) {
          assert.equal(auth.tenantId, fixture.tenantId);
          return { rows: [{
            agent_usage: 'inbound',
            knowledge_bases: [{ id: fixture.kbId, publicationRevision: fixture.revision, priority: 1 }],
          }] };
        }
        const requested = JSON.parse(values[3]);
        return { rows: requested.filter((candidate) => candidate.record_id === fixture.recordId).map((candidate) => ({
          record_type: 'FAQ', record_id: fixture.recordId, knowledge_base_id: fixture.kbId,
          document_id: fixture.recordId, document_version_id: fixture.recordId,
          document_name: 'fixture-faq.txt', source_page_start: 1, source_page_end: 1,
          language: fixture.language, content: fixture.fact, caller_facing: true,
          authoritative_data: { question: fixture.query, answer: fixture.fact },
          rank: candidate.rank, score: candidate.score,
        })) };
      },
    }),
  };
}

const retrievalSamples = [];
const rerankHydrationSamples = [];
for (const fixture of task10Industries) {
  const result = await searchHybridPublishedKnowledge({ tenantId: fixture.tenantId }, {
    agentId: fixture.agentId, query: fixture.query, usageDirection: 'inbound',
    language: fixture.language, topK: 5,
  }, dependencies(fixture, task10Industries));
  assert.equal(result.sources.length, 1, `${fixture.industry}: exactly one tenant source expected`);
  assert.equal(result.sources[0].content, fixture.fact);
  assert.equal(result.publicationRevisions[0].publicationRevision, fixture.revision);
  retrievalSamples.push(result.retrieval.vectorBm25Ms);
  rerankHydrationSamples.push(result.retrieval.rerankMs + result.retrieval.hydrationMs);
}
assert.ok(Math.max(...retrievalSamples) <= 100, 'Vector + BM25 fixture retrieval exceeded 100 ms');
assert.ok(Math.max(...rerankHydrationSamples) <= 30, 'Rerank + hydration fixture path exceeded 30 ms');

const envelope = {
  found: true,
  sources: [{ id: 'source_1', content: 'The verified value is 25.', recordId: 'record-1' }],
  entities: [],
};
const hallucination = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: 'The verified value is 99.', evidenceIds: ['source_1'],
  responseId: null,
  stateUpdate: { currentTopic: 'value', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
  pendingQuestion: null, toolRequest: null, clarification: null,
}), envelope, { fieldSchemas: [], toolSchemas: [] });
assert.equal(hallucination.valid, false);
assert.equal(hallucination.reason, 'unsupported_numeric_fact');

const unauthorized = validateDecisionSecurity({
  toolRequest: { name: 'unapproved_action', arguments: {} },
  runtime: { toolSchemas: [], actionEvidence: [] },
});
assert.equal(unauthorized.reason, 'unauthorized_tool_request');

const next = resolveNextConfiguredQuestion({
  decision: { pendingQuestionRelevant: true },
  beforeState: { pendingQuestion: { key: 'configured', text: 'Configured next question?', kind: 'conversation' } },
  afterState: { collectedInformation: {} },
});
assert.equal(next.question, 'Configured next question?');

let now = 0;
let interrupted = false;
const interruption = new InterruptionCandidateManager({
  configuration: {
    timeBased: { enabled: true, thresholdMs: 10 },
    wordBased: { enabled: true, minimumWords: 2 },
    explicitStopPhrases: [], acknowledgementPhrases: [],
  },
  now: () => now,
  setTimer: () => ({ unref() {} }), clearTimer: () => {},
  onConfirm: () => { interrupted = true; },
});
interruption.start();
now = 20;
interruption.observeTranscript('new meaningful question');
assert.equal(interrupted, true);

const runtimeFiles = [
  '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js',
  '../src/voice/interaction/generic-conversation-state.js',
  '../src/voice/interaction/grounded-llm-decision.js',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
assert.doesNotMatch(runtimeFiles[0], /intentKeywords|triggerPhrases|packageKeywords|hospital|appointment/iu);
assert.doesNotMatch(runtimeFiles.join('\n'), /FROM_STAGE|NEXT_STAGE|workflowStageGate/iu);

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const reportPath = resolve(process.env.TASK10_LATENCY_REPORT ?? 'artifacts/voice-latency-samples.json');
assert.ok(existsSync(reportPath),
  `Production first-audio report is required before legacy deletion: ${reportPath}`);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const firstAudio = (report.samples ?? []).map((sample) => Number(sample.firstAudioMs))
  .filter((value) => Number.isFinite(value) && value >= 0);
assert.ok(firstAudio.length >= 20, 'At least 20 production first-audio samples are required');
const audio = {
  p50: percentile(firstAudio, 0.50),
  p90: percentile(firstAudio, 0.90),
  p95: percentile(firstAudio, 0.95),
};
assert.ok(audio.p50 < 700, `p50 first audio ${audio.p50} ms must be below 700 ms`);
assert.ok(audio.p90 < 1000, `p90 first audio ${audio.p90} ms must be below 1000 ms`);
assert.ok(audio.p95 < 1500, `p95 first audio ${audio.p95} ms must be below 1500 ms`);

const acceptancePath = resolve(
  process.env.PRODUCTION_ACCEPTANCE_REPORT ?? 'artifacts/production-acceptance-report.json',
);
assert.ok(existsSync(acceptancePath),
  `Live PostgreSQL/Qdrant acceptance report is required before production activation: ${acceptancePath}`);
const acceptance = JSON.parse(readFileSync(acceptancePath, 'utf8'));
assert.equal(acceptance.mode, 'live_candidate_revision_postgresql_qdrant');
assert.equal(acceptance.passed, true);
assert.ok(Number(acceptance.version) >= 3,
  'Production activation requires the candidate-revision acceptance contract');
assert.equal(acceptance.verification?.candidateRevisionPinned, true,
  'Acceptance must be pinned to explicit PostgreSQL/Qdrant revisions');
assert.equal(acceptance.verification?.postgresRevisionValidated, true,
  'Candidate PostgreSQL revisions were not validated');
assert.equal(acceptance.verification?.qdrantRevisionValidated, true,
  'Candidate Qdrant revisions were not validated');
assert.ok(Array.isArray(acceptance.candidateRevisions) && acceptance.candidateRevisions.length > 0,
  'Acceptance report has no candidate revision manifest');
assert.ok(acceptance.candidateRevisions.every((entry) => (
  entry.postgresPublished === true && Number(entry.qdrantPointCount) > 0
)), 'Every candidate revision must exist in PostgreSQL and contain Qdrant points');
const reportAgeMs = Date.now() - new Date(acceptance.generatedAt).getTime();
const maximumReportAgeMs = Number(process.env.PRODUCTION_ACCEPTANCE_MAX_AGE_MS ?? 30 * 60 * 1000);
assert.ok(Number.isFinite(reportAgeMs) && reportAgeMs >= 0 && reportAgeMs <= maximumReportAgeMs,
  'Production acceptance report is stale; replay the current candidate revision');
assert.ok(Number(acceptance.callCount) > 0 && Number(acceptance.turnCount) > 0,
  'Live production acceptance must replay at least one call and one turn');
assert.ok(Number(acceptance.semanticCandidates) > 0,
  'Live production acceptance must observe Qdrant semantic candidates');
assert.ok(Array.isArray(acceptance.sourceCallIds)
  && acceptance.sourceCallIds.includes('c3559ea3-9074-477a-9982-becac294bdc6'),
  'Live acceptance must include the failed 2026-08-19 production call replay');
assert.equal(acceptance.verification?.allHydratedEvidenceScopeValidated, true,
  'Every hydrated evidence ID must pass tenant, agent, KB and revision validation');
assert.equal(acceptance.verification?.retrievedIdsRecorded, true,
  'The acceptance report must record every retrieved candidate ID');
assert.equal(acceptance.verification?.selectedEvidenceIdsValidated, true,
  'Every LLM-selected evidence ID must be validated');
assert.equal(acceptance.verification?.perTurnSemanticScoresValidated, true,
  'Every answerable replay turn must have non-zero semantic evidence');
assert.equal(acceptance.verification?.evidenceTypesValidated, true,
  'Every selected evidence record type must be validated');
assert.equal(acceptance.verification?.memoryValidated, true,
  'Conversation memory was not validated');
assert.equal(acceptance.verification?.toolSafetyValidated, true,
  'Tool and personal-data collection safety was not validated');
for (const language of ['ta', 'tanglish', 'en']) {
  assert.ok((acceptance.replayLanguages ?? []).includes(language),
    `Live acceptance is missing unseen ${language} turns`);
}
assert.ok(Number(acceptance.verification?.overviewResponsesValidated) >= 2,
  'Positive introduction and explicit overview responses must be verified');
assert.ok(Number(acceptance.verification?.followUpEntitiesValidated) >= 1,
  'Catalog selection and contextual follow-up entities must be verified');
assert.equal(acceptance.verification?.catalogDetailsValidated, true,
  'Complete Catalog hydration must be verified');
assert.equal(acceptance.verification?.fallbackValidated, true,
  'Configured fallback behavior must be verified');
assert.equal(Number(acceptance.verification?.finalTtsTextValidated), Number(acceptance.turnCount),
  'Final TTS text must be verified for every replay turn');
for (const field of ['retrievalMs', 'llmMs', 'totalMs']) {
  for (const percentileName of ['p50', 'p90', 'p95']) {
    assert.ok(Number.isFinite(Number(acceptance.latency?.[field]?.[percentileName])),
      `Live production acceptance is missing ${field}.${percentileName}`);
  }
}

console.log(JSON.stringify({
  gate: 'production-migration', passed: true,
  industries: task10Industries.map((fixture) => fixture.industry),
  retrievalMaxMs: Math.max(...retrievalSamples),
  rerankHydrationMaxMs: Math.max(...rerankHydrationSamples),
  firstAudio: audio,
  liveAcceptance: {
    calls: acceptance.callCount, turns: acceptance.turnCount,
    semanticCandidates: acceptance.semanticCandidates,
    latency: acceptance.latency,
  },
  legacyDeletionAuthorized: true,
}));
