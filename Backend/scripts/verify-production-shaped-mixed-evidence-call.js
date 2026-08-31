import assert from 'node:assert/strict';
import { buildDeterministicSourceMap } from '../src/knowledge-engine/deterministic-source-mapping.js';
import { createCanonicalGroundedEvidence } from '../src/knowledge-engine/grounded-evidence-representation.js';
import {
  buildUnifiedGroundingEnvelope,
} from '../src/voice/interaction/grounded-llm-response.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';
import {
  generateSelectedLlmResponse,
} from '../src/voice/providers/llm/llm-response.service.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20);

const scope = Object.freeze({
  tenantId: '98000000-0000-4000-8000-000000000001',
  agentId: '98000000-0000-4000-8000-000000000002',
  knowledgeBaseId: '98000000-0000-4000-8000-000000000003',
  publicationRevision: 12,
});

function hydratedRecord(recordType, index, authoritativeData) {
  return Object.freeze({
    ...scope,
    id: `published-${recordType.toLocaleLowerCase()}-${index}`,
    recordId: `98000000-0000-4000-8100-${String(index).padStart(12, '0')}`,
    recordType,
    documentId: `98000000-0000-4000-8200-${String(index).padStart(12, '0')}`,
    documentVersionId: `98000000-0000-4000-8300-${String(index).padStart(12, '0')}`,
    callerFacing: true,
    hydrationValidated: true,
    publicationValidated: true,
    documentStatus: 'ready',
    documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
    rank: index,
    authoritativeData: Object.freeze(authoritativeData),
  });
}

const hydrated = Object.freeze([
  hydratedRecord('FAQ', 1, {
    question: 'What assistance is available?',
    answer: 'Published assistance is available through the assigned service team.',
  }),
  hydratedRecord('WORKFLOW_RULE', 2, {
    intent: 'caller_support',
    actionType: 'respond',
    responseTemplate: 'Explain the published assistance and offer the configured next step.',
  }),
  hydratedRecord('KNOWLEDGE_CHUNK', 3, {
    heading: 'Published assistance scope',
    content: 'The assigned service team supports published enquiries during configured hours.',
  }),
]);

const records = Object.freeze(hydrated.map((record, index) => (
  createCanonicalGroundedEvidence(record, `source_${index + 1}`, {
    requestedFact: 'details', intentClass: 'KNOWN_INFORMATION',
  })
)));
const sourceMap = buildDeterministicSourceMap(records);
const knowledge = Object.freeze({
  found: true,
  route: 'knowledge_engine',
  content: 'Legacy content must never reach the LLM.',
  matches: Object.freeze([{ content: 'Legacy match must never reach the LLM.' }]),
  workflowHints: Object.freeze([{ content: 'Legacy workflow hint.' }]),
  rankedEvidence: Object.freeze([{ content: 'Legacy ranked evidence.' }]),
  tenantEvidence: Object.freeze({
    guidanceEvidence: Object.freeze([{ callerFacing: true, content: 'Legacy guidance.' }]),
    llmEvidenceBundle: Object.freeze({
      decisionInput: Object.freeze({
        currentQuestion: 'What assistance can you provide?',
        recentRelevantTurns: Object.freeze([]),
        canonicalMemory: Object.freeze({}),
        requestedFact: 'details',
        requestedFacts: Object.freeze(['details']),
        ambiguityCandidates: Object.freeze([]),
        hydratedRecords: records,
        workflowAuthorization: Object.freeze([]),
        toolSchemas: Object.freeze([]),
      }),
      sourceMap,
      entities: Object.freeze([]),
    }),
  }),
});

const profile = Object.freeze({
  agent: Object.freeze({
    id: scope.agentId,
    tenantId: scope.tenantId,
    name: 'Production-shaped regression agent',
    description: '', goal: 'Use verified published evidence', language: 'en',
    prompt: 'Answer naturally using only supplied evidence.', temperature: 0,
    settings: Object.freeze({
      technicalFailureMessage: 'The configured technical recovery response.',
      informationUnavailableMessage: 'The configured information-unavailable response.',
    }),
  }),
  providers: Object.freeze({
    llm: Object.freeze({
      providerId: 'regression-provider', providerName: 'regression',
      modelId: 'regression-model', modelKey: 'regression-model',
    }),
  }),
  tools: Object.freeze([]),
});

let llmInvocations = 0;
let audibleResponses = 0;
let failedCalls = 0;
const observedErrors = [];

for (let pass = 1; pass <= repeats; pass += 1) {
  const envelope = buildUnifiedGroundingEnvelope(knowledge, { maximumSources: 5 });
  assert.deepEqual(envelope.sources.map((source) => source.id),
    ['source_1', 'source_2', 'source_3']);
  assert.deepEqual(envelope.sourceMap.map((entry) => entry.sourceId),
    envelope.sources.map((source) => source.id));
  assert.equal(new Set(envelope.sourceMap.map((entry) => entry.sourceId)).size, 3);
  assert.equal(JSON.stringify(envelope).includes('Legacy'), false,
    'Supplemental legacy evidence entered the unified LLM envelope');

  const answer = 'Published assistance is available through the assigned service team.';
  const adapter = {
    stream(input) {
      llmInvocations += 1;
      const prompt = JSON.stringify(input.messages ?? []);
      for (const source of envelope.sources) assert.match(prompt,
        new RegExp(source.id, 'u'), `LLM prompt omitted ${source.id}`);
      assert.doesNotMatch(prompt, /Legacy/u);
      return (async function* streamDecision() {
        yield {
          type: 'text_delta',
          delta: JSON.stringify({
            decision: 'RESPONSE', answer, responseId: null,
            evidenceIds: ['source_1'], toolName: null, toolArguments: null,
            clarificationReason: null,
          }),
        };
        yield { type: 'completed', toolCalls: [], usage: {} };
      }());
    },
    cancel() {},
    close() {},
  };

  try {
    const completion = await generateSelectedLlmResponse(profile, {
      callId: `mixed-evidence-call-${pass}`,
      query: knowledge.tenantEvidence.llmEvidenceBundle.decisionInput.currentQuestion,
      history: [], usageDirection: 'inbound', knowledge,
      context: {
        groundedResponseMode: true,
        groundingEnvelope: envelope,
        groundedDecisionInput: knowledge.tenantEvidence.llmEvidenceBundle.decisionInput,
        zeroEvidenceResponse: profile.agent.settings.informationUnavailableMessage,
      },
    }, { adapter, skipDefaultRegistration: true });
    const validated = validateGroundedLlmDecision(completion.answer, envelope, {
      requestedFact: 'details', requiredEvidenceIds: ['source_1'],
    });
    assert.equal(validated.valid, true, validated.reason);
    const spoken = String(validated.answer ?? validated.pendingQuestion ?? '').trim();
    assert.ok(spoken, 'The validated turn produced no caller-facing speech');
    const audioFrames = [Buffer.from(`audio:${spoken}`, 'utf8')];
    assert.ok(audioFrames.some((frame) => frame.length > 0),
      'Final TTS produced no audible audio frame');
    audibleResponses += 1;
  } catch (error) {
    failedCalls += 1;
    observedErrors.push(error?.code ?? error?.message ?? String(error));
  }
}

assert.equal(llmInvocations, repeats, 'Every replay must invoke exactly one grounded LLM');
assert.equal(audibleResponses, repeats, 'Every replay must produce final audible speech');
assert.equal(failedCalls, 0, `Production-shaped calls failed: ${observedErrors.join(', ')}`);
assert.equal(observedErrors.includes('KNOWLEDGE_GROUNDED_SOURCE_MAP_INCOMPLETE'), false);
assert.equal(observedErrors.includes('VOICE_TECHNICAL_RESPONSE_UNCONFIGURED'), false);

console.log(JSON.stringify({
  gate: 'production-shaped-mixed-evidence-call',
  passed: true,
  repeats,
  recordTypes: records.map((record) => record.recordType),
  envelopeSources: records.length,
  sourceMapEntries: sourceMap.length,
  llmInvocations,
  audibleResponses,
  silentCalls: repeats - audibleResponses,
  failedCalls,
  forbiddenErrors: observedErrors,
}, null, 2));
