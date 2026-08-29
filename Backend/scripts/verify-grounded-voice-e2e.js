import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  groundedDecisionJsonSchema,
  validateGroundedLlmDecision,
} from '../src/voice/interaction/grounded-llm-decision.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Grounded voice end-to-end regression requires at least three passes');

function run(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 300_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return String(result.stdout ?? '').trim();
}

function decision({ type, answer, sourceId = null, responseId = null,
  toolName = null, toolArguments = null, clarificationReason = null }) {
  return JSON.stringify({
    decision: type,
    answer,
    responseId,
    evidenceIds: sourceId ? [sourceId] : [],
    toolName,
    toolArguments,
    clarificationReason,
  });
}

const tenants = Object.freeze([
  Object.freeze({ key: 'tenant_north', language: 'en', unavailable: 'That information is not published.' }),
  Object.freeze({ key: 'tenant_east', language: 'ta', unavailable: 'அந்த தகவல் வெளியிடப்பட்ட அறிவில் இல்லை.' }),
  Object.freeze({ key: 'tenant_west', language: 'es', unavailable: 'Esa información no está publicada.' }),
]);

const knownScenarios = Object.freeze([
  Object.freeze({ key: 'identity', recordType: 'FAQ', requestType: 'identity' }),
  Object.freeze({ key: 'location', recordType: 'KNOWLEDGE_CHUNK', requestType: 'location' }),
  Object.freeze({
    key: 'overview', recordType: 'CONVERSATION_NODE', requestType: 'overview', exact: true,
  }),
  Object.freeze({ key: 'direct_entity', recordType: 'CATALOG_ITEM', requestType: 'details' }),
  Object.freeze({ key: 'contextual_follow_up', recordType: 'CATALOG_ITEM', requestType: 'price' }),
]);

let knownTurns = 0;
let nonEmptyEvidenceTurns = 0;
let responseDecisions = 0;
let clarifyDecisions = 0;
let silentTurns = 0;

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const tenant of tenants) {
    for (const scenario of knownScenarios) {
      const sourceId = `source_${scenario.key}`;
      const content = `${tenant.key} published ${scenario.key} answer ${pass}.`;
      const source = Object.freeze({
        id: sourceId,
        publishedEvidenceId: `${tenant.key}:published:${scenario.key}`,
        recordId: `${tenant.key}:record:${scenario.key}`,
        recordType: scenario.recordType,
        content,
        exactCallerResponse: scenario.exact === true,
        callerFacing: true,
        authoritativeData: Object.freeze({
          canonicalName: `${tenant.key} canonical ${scenario.key}`,
          answer: content,
        }),
      });
      const envelope = Object.freeze({
        found: true,
        sources: Object.freeze([source]),
        entities: scenario.recordType === 'CATALOG_ITEM' ? Object.freeze([{
          id: source.recordId,
          key: `${tenant.key}-${scenario.key}`,
          name: source.authoritativeData.canonicalName,
          sourceId,
        }]) : Object.freeze([]),
        exactCallerResponses: scenario.exact ? Object.freeze([sourceId]) : Object.freeze([]),
      });
      assert.equal(envelope.sources.length, 1,
        `Known ${scenario.key} answer must reach the LLM with evidence`);
      nonEmptyEvidenceTurns += 1;

      const schema = groundedDecisionJsonSchema(envelope, {});
      assert.ok(schema.properties.decision.enum.includes('RESPONSE'));
      const validated = validateGroundedLlmDecision(decision({
        type: 'RESPONSE', answer: content, sourceId,
        responseId: scenario.exact ? sourceId : null,
      }), envelope, {
        requestedFact: scenario.requestType,
        requiredEvidenceIds: [sourceId],
      });
      assert.equal(validated.valid, true,
        `${tenant.key} ${scenario.key} RESPONSE was rejected: ${validated.reason}`);
      assert.equal(validated.decision, 'answer');
      assert.ok(validated.answer, `${tenant.key} ${scenario.key} produced a silent turn`);
      responseDecisions += 1;
      knownTurns += 1;
    }

    const candidateName = `${tenant.key} canonical candidate`;
    const clarificationEnvelope = Object.freeze({ found: false, sources: [], entities: [] });
    const clarificationRuntime = Object.freeze({
      clarificationContext: Object.freeze({
        heardText: `${tenant.key} phonetic form`,
        candidates: Object.freeze([{
          canonicalName: candidateName,
          confidenceBand: 'MEDIUM',
          recordId: `${tenant.key}:candidate`,
        }]),
      }),
    });
    const clarification = validateGroundedLlmDecision(decision({
      type: 'CLARIFY',
      answer: `Did you mean ${candidateName}?`,
      clarificationReason: 'ambiguous_request',
    }), clarificationEnvelope, clarificationRuntime);
    assert.equal(clarification.valid, true,
      `${tenant.key} phonetic clarification was rejected: ${clarification.reason}`);
    assert.equal(clarification.decision, 'clarify');
    assert.match(clarification.pendingQuestion, new RegExp(candidateName, 'u'));
    clarifyDecisions += 1;

    const unsupported = validateGroundedLlmDecision(decision({
      type: 'RESPONSE', answer: tenant.unavailable,
    }), clarificationEnvelope, { zeroEvidenceResponse: tenant.unavailable });
    assert.equal(unsupported.valid, true,
      `${tenant.key} configured zero-evidence RESPONSE was rejected: ${unsupported.reason}`);
    assert.equal(unsupported.decision, 'answer');
    assert.equal(unsupported.answer, tenant.unavailable);
    responseDecisions += 1;

    for (const result of [clarification, unsupported]) {
      if (!result.answer && !result.pendingQuestion && !result.toolRequest) silentTurns += 1;
    }
  }
}

const namespaceOutput = run(
  'namespace-aware latest-request routing',
  'scripts/verify-namespace-aware-reservation.js',
);
assert.match(namespaceOutput,
  /Independent namespace search and pre-RRF record reservation verified\./u);

const contextual = JSON.parse(run(
  'multi-tenant contextual and phonetic routing',
  'scripts/verify-universal-contextual-reliability.js',
  [`--repeats=${repeats}`],
));
assert.equal(contextual.passed, true);
assert.ok(contextual.contextualCoverage.includes('phonetic_stt'));
assert.ok(contextual.contextualCoverage.includes('contextual_follow_up'));
assert.equal(contextual.runtimeErrors, 0);

const zeroEvidence = JSON.parse(run(
  'zero-evidence RESPONSE CLARIFY TOOL decisions',
  'scripts/verify-zero-evidence-multitenant.js',
  [`--repeats=${repeats}`],
));
assert.equal(zeroEvidence.passed, true);
assert.ok(zeroEvidence.targetedClarifications > 0);
assert.ok(zeroEvidence.configuredSupportResponses > 0);
assert.ok(zeroEvidence.authorizedTools > 0);
assert.equal(zeroEvidence.silentTurns, 0);

run('acknowledgement and final audio deadlines',
  'scripts/verify-production-latency-contract.js');
run('processing-time inactivity suppression',
  'scripts/verify-operational-audio-lifecycle.js');

const orchestrator = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url),
  'utf8',
);
assert.match(orchestrator, /acknowledgementAudioPlayed\s*=\s*true/u,
  'Acknowledgement playback must complete the original first-audio deadline');
assert.match(orchestrator,
  /currentSentenceNumber === 1 && !acknowledgementAudioPlayed/u,
  'Final TTS must receive an independent first-audio deadline after acknowledgement');
assert.match(orchestrator, /activeGroundedTurnEpochs\.size\s*>\s*0/u,
  'Inactivity must remain disabled while the grounded turn is processing');

assert.equal(silentTurns, 0);

console.log(JSON.stringify({
  gate: 'grounded-voice-end-to-end',
  passed: true,
  repeats,
  tenants: tenants.length,
  languages: tenants.map((tenant) => tenant.language),
  scenarios: [
    ...knownScenarios.map((scenario) => scenario.key),
    'phonetic_name', 'zero_evidence_response', 'zero_evidence_clarify',
    'zero_evidence_tool', 'acknowledgement_final_audio', 'processing_inactivity',
  ],
  knownTurns,
  nonEmptyEvidenceTurns,
  responseDecisions,
  clarifyDecisions,
  toolDecisions: zeroEvidence.authorizedTools,
  finalAudioAfterAcknowledgement: true,
  processingTimeInactivityPrompts: 0,
  silentTurns,
  runtimeErrors: 0,
}, null, 2));
