import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';
import {
  awaitLlmWithSafeLatency,
  VoiceTurnLatencyTracker,
} from '../src/voice/interaction/grounded-turn-latency.js';
import { assertGroundedStructuredCompletion } from '../src/voice/providers/llm/llm-response.service.js';
import {
  configuredOperationalFailureResponse,
  llmOperationalFailureClass,
} from '../src/voice/realtime-conversation-orchestrator.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal production regression requires at least three passes');

function run(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return String(result.stdout ?? '').trim();
}

const contextual = JSON.parse(run(
  'universal contextual scenarios',
  'scripts/verify-universal-contextual-reliability.js',
  [`--repeats=${repeats}`],
));
assert.equal(contextual.passed, true);
assert.equal(contextual.repeats, repeats);
for (const requirement of [
  'natural_non_exact', 'contextual_follow_up', 'topic_switching',
  'price_and_details', 'multi_entity_comparison', 'phonetic_stt',
  'cross_tenant_isolation',
]) assert.ok(contextual.contextualCoverage.includes(requirement), requirement);
assert.ok(contextual.syntheticIndustries.length >= 3);
assert.ok(contextual.languages.length >= 3);
assert.equal(contextual.staleAnswers, 0);
assert.equal(contextual.genericRepeatedClarifications, 0);
assert.equal(contextual.crossTenantLeakage, false);
assert.equal(contextual.runtimeErrors, 0);

const tenantFixtures = Object.freeze([
  Object.freeze({
    tenantId: 'd1000000-0000-4000-8000-000000000001',
    agentId: 'd1000000-0000-4000-8000-000000000002',
    language: 'en', technicalMessage: 'The configured information service is temporarily unavailable.',
  }),
  Object.freeze({
    tenantId: 'd2000000-0000-4000-8000-000000000001',
    agentId: 'd2000000-0000-4000-8000-000000000002',
    language: 'ta', technicalMessage: 'கட்டமைக்கப்பட்ட தகவல் சேவை தற்காலிகமாக கிடைக்கவில்லை.',
  }),
  Object.freeze({
    tenantId: 'd3000000-0000-4000-8000-000000000001',
    agentId: 'd3000000-0000-4000-8000-000000000002',
    language: 'es', technicalMessage: 'El servicio de información configurado no está disponible temporalmente.',
  }),
]);

function missingEvidenceInput(fixture, pass) {
  const recordId = `${fixture.tenantId}:record:${pass}`;
  return {
    input: {
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      callId: `${fixture.tenantId}:call:${pass}`,
      latestQuestion: `question-${pass}`,
      utterance: `question-${pass}`,
      usageDirection: 'inbound',
      canonicalCallMemory: {},
      queryUnderstanding: {
        explicitEntities: [{ recordId, recordType: 'CATALOG_ITEM', name: `entity-${pass}` }],
        explicitCategories: [], comparisonEntities: [], contextDependent: false,
      },
    },
    classification: { intentClass: 'DETAILS_OR_PRICE' },
    resolution: { candidateNamespace: 'CATALOG', contextDependent: false },
    authoritative: {
      reservations: [{
        recordId, recordType: 'CATALOG_ITEM', reason: 'explicit_entity',
      }],
      evidence: [],
    },
    runtimeProfile: { tools: [] },
  };
}

let malformedJsonFailures = 0;
let timeoutFailures = 0;
let missingEvidenceFailures = 0;
let technicalRecoveries = 0;
let processingAcknowledgements = 0;

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const fixture of tenantFixtures) {
    const profile = {
      agent: {
        tenantId: fixture.tenantId,
        id: fixture.agentId,
        language: fixture.language,
        settings: { technicalFailureMessage: fixture.technicalMessage },
      },
    };

    assert.throws(
      () => assertGroundedStructuredCompletion(
        { type: 'completed', finishReason: 'stop' }, '{',
      ),
      (error) => {
        malformedJsonFailures += 1;
        assert.equal(llmOperationalFailureClass(error), 'structured_output');
        return error.code === 'LLM_STRUCTURED_OUTPUT_INVALID_JSON';
      },
    );

    assert.throws(
      () => buildGroundedLlmInput(missingEvidenceInput(fixture, pass)),
      (error) => {
        missingEvidenceFailures += 1;
        return [
          'KNOWLEDGE_REQUIRED_EVIDENCE_NOT_PACKAGED',
          'KNOWLEDGE_CONTEXT_RECORD_NOT_HYDRATED',
        ].includes(error.code);
      },
    );

    const operationalMessage = configuredOperationalFailureResponse(profile, {});
    assert.equal(operationalMessage, fixture.technicalMessage);
    assert.ok(operationalMessage);
    technicalRecoveries += 1;

    let cancelled = false;
    let acknowledged = false;
    const tracker = new VoiceTurnLatencyTracker({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      callId: `timeout-call-${pass}`,
      turnId: `timeout-turn-${pass}`,
    });
    await assert.rejects(() => awaitLlmWithSafeLatency(
      new Promise((resolve) => setTimeout(() => resolve('{}'), 80)),
      {
        tracker,
        acknowledgementEnabled: true,
        acknowledgementAfterMs: 2,
        ttsReserveMs: 1,
        acknowledgementText: `configured-ack-${fixture.language}`,
        completionTimeoutMs: 8,
        onAcknowledgement: async () => {
          acknowledged = true;
          processingAcknowledgements += 1;
        },
        cancel: () => { cancelled = true; },
      },
    ), (error) => {
      timeoutFailures += 1;
      assert.equal(llmOperationalFailureClass(error), 'timeout');
      return error.code === 'VOICE_TURN_STAGE_TIMEOUT';
    });
    assert.equal(acknowledged, true);
    assert.equal(cancelled, true);
  }
}

const orchestratorSource = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url),
  'utf8',
);
const runTurnStart = orchestratorSource.indexOf('async #runTurn(');
const groundedTurnStart = orchestratorSource.indexOf('async #runGroundedTurn(', runTurnStart);
const runTurn = orchestratorSource.slice(runTurnStart, groundedTurnStart);
assert.match(runTurn, /activeGroundedTurnEpochs\.add\(epoch\)/u);
assert.match(runTurn, /#clearInactivity\(\)/u);
assert.match(runTurn, /activeGroundedTurnEpochs\.delete\(epoch\)/u);
assert.match(runTurn, /outcome\?\.suppressInactivity\s*!==\s*true/u,
  'Operational response configuration failures must suppress inactivity fallback');
const inactivityStart = orchestratorSource.indexOf('async #handleInactivity()');
const inactivityEnd = orchestratorSource.indexOf('async #closingMessage(', inactivityStart);
const inactivity = orchestratorSource.slice(inactivityStart, inactivityEnd);
assert.match(inactivity, /activeGroundedTurnEpochs\.size\s*>\s*0/u,
  'Inactivity callback must reject processing-time execution');
const finalPlayback = orchestratorSource.indexOf('await this.controller.playbackComplete();', groundedTurnStart);
const finalGroundedEnd = orchestratorSource.indexOf('async #synthesizeWelcome(', groundedTurnStart);
assert.ok(finalPlayback > groundedTurnStart && finalPlayback < finalGroundedEnd,
  'Grounded turn must remain active through final playback');
const missingRuntimeMessageStart = orchestratorSource.indexOf('if (!finalAnswer)', groundedTurnStart);
const missingRuntimeMessageEnd = orchestratorSource.indexOf('if (validatedNormalTurn)', missingRuntimeMessageStart);
const missingRuntimeMessage = orchestratorSource.slice(
  missingRuntimeMessageStart, missingRuntimeMessageEnd,
);
assert.match(missingRuntimeMessage, /operational_response_unconfigured/u);
assert.match(missingRuntimeMessage, /suppressInactivity:\s*true/u);

const hardcoding = JSON.parse(run(
  'universal runtime hardcoding scan',
  'scripts/verify-universal-hardcoding-gate.js',
));
assert.equal(hardcoding.passed, true);
assert.equal(hardcoding.prohibitedBusinessLiteralMatches, 0);
assert.equal(hardcoding.crossTenantLeakage, false);

assert.equal(malformedJsonFailures, tenantFixtures.length * repeats);
assert.equal(timeoutFailures, tenantFixtures.length * repeats);
assert.equal(missingEvidenceFailures, tenantFixtures.length * repeats);
assert.equal(technicalRecoveries, tenantFixtures.length * repeats);
assert.equal(processingAcknowledgements, tenantFixtures.length * repeats);

console.log(JSON.stringify({
  gate: 'universal-production-regression',
  passed: true,
  repeats,
  syntheticTenants: tenantFixtures.length,
  languages: tenantFixtures.map((fixture) => fixture.language),
  directQuestions: true,
  contextualFollowUps: true,
  explicitTopicSwitching: true,
  pricesAndDetails: true,
  comparisons: true,
  phoneticSttVariations: true,
  malformedJsonOperationalFailures: malformedJsonFailures,
  timeoutOperationalFailures: timeoutFailures,
  missingEvidenceOperationalFailures: missingEvidenceFailures,
  configuredTechnicalRecoveries: technicalRecoveries,
  processingTimeInactivityPrompts: 0,
  hardcodedBusinessVocabulary: false,
  staleAnswers: 0,
  emptyEvidenceAccepted: 0,
  falseClarifications: 0,
  crossTenantLeakage: false,
  runtimeErrors: 0,
}, null, 2));
