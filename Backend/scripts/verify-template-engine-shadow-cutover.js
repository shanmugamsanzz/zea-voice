import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTemplateEngineCutoverController,
  requiredTemplateEngineScenarios,
  validateTemplateEngineActivationEvidence,
} from '../src/voice/interaction/template-engine-shadow-cutover.js';

const tenants = ['tenant-one', 'tenant-two', 'tenant-three'];
const languages = ['ta', 'en', 'hi'];
const decisionFor = (scenario) => {
  if (['missing_information'].includes(scenario)) return 'NO_MATCH';
  if (['phonetic_variations', 'corrections'].includes(scenario)) return 'CLARIFY';
  if (scenario.includes('workflow') || scenario.includes('field')
    || ['confirmation', 'cancellation', 'tool_success', 'tool_timeout', 'tool_failure']
      .includes(scenario)) return 'TOOL';
  return 'RESPONSE';
};

let calls = 0;
const controller = createTemplateEngineCutoverController({
  mode: 'shadow', timeoutMs: 1_000,
}, {
  executeShadowTurn: async (input) => {
    calls += 1;
    assert.equal(input.shadow, true);
    assert.equal(input.sideEffectsAllowed, false);
    const decision = decisionFor(input.scenario);
    return {
      decision: {
        decision,
        response: decision === 'RESPONSE' || decision === 'NO_MATCH' ? 'Safe speech.' : '',
        clarification: decision === 'CLARIFY' ? { question: 'Which option?' } : null,
      },
      speech: decision === 'TOOL' ? 'Please provide the next configured value.' : null,
      outputValidation: { valid: true, ttsAllowed: decision !== 'TOOL' },
      sideEffectsExecuted: false, toolExecuted: false, ttsExecuted: false,
    };
  },
});

for (let repeat = 1; repeat <= 3; repeat += 1) {
  for (let index = 0; index < requiredTemplateEngineScenarios.length; index += 1) {
    const scenario = requiredTemplateEngineScenarios[index];
    const result = await controller.observeFinalizedTurn({
      callId: `call-${repeat}-${index}`, turnId: String(index), scenario,
      tenantId: tenants[index % tenants.length],
      language: languages[index % languages.length],
      latestUtterance: `generic utterance ${index}`,
      legacyOutcome: { decision: decisionFor(scenario) },
    });
    assert.equal(result.status, 'COMPLETED');
  }
}
assert.equal(calls, requiredTemplateEngineScenarios.length * 3);
const snapshot = controller.snapshot();
assert.equal(snapshot.failed, 0);
assert.equal(snapshot.unsafeResults, 0);
assert.equal(snapshot.observed, calls);
assert.equal(snapshot.completed, calls);
assert.equal(snapshot.mismatched, 0);

const unsafe = createTemplateEngineCutoverController({ mode: 'shadow' }, {
  executeShadowTurn: async () => ({
    decision: { decision: 'RESPONSE', response: 'Unsafe.' },
    outputValidation: { valid: true }, ttsExecuted: true,
  }),
});
assert.equal((await unsafe.observeFinalizedTurn({ callId: 'unsafe' })).status, 'FAILED');
assert.equal(unsafe.snapshot().unsafeResults, 1);

const incompleteEvidence = validateTemplateEngineActivationEvidence({
  passed: true, repeats: 3, productionPublishedData: false,
  liveFinalizedTurns: false, tenants, languages, scenarios: requiredTemplateEngineScenarios,
});
assert.equal(incompleteEvidence.valid, false);
assert.ok(incompleteEvidence.reasons.includes('not_production_published_data'));

const liveEvidence = {
  passed: true, repeats: 3, productionPublishedData: true, liveFinalizedTurns: true,
  tenants, languages, scenarios: requiredTemplateEngineScenarios,
  crossTenantLeakage: 0, unrelatedEvidence: 0, hallucinations: 0,
  unauthorizedTools: 0, falseTechnicalFallbacks: 0, silentTurns: 0,
  gitSha: 'release-sha',
};
assert.equal(validateTemplateEngineActivationEvidence(liveEvidence, 'release-sha').valid, true);
assert.throws(() => createTemplateEngineCutoverController({
  mode: 'active', acceptanceEvidence: liveEvidence, gitSha: 'release-sha',
}), (error) => error.code === 'TEMPLATE_ENGINE_ACTIVE_RUNTIME_NOT_READY');

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-shadow-cutover.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false,
    `Shadow cutover contains domain vocabulary: ${forbidden}`);
}

console.log(JSON.stringify({
  gate: 'template-engine-shadow-cutover', passed: true,
  repeats: 3, tenants: tenants.length, languages,
  scenarios: requiredTemplateEngineScenarios,
  productionLiveEvidence: false,
  legacyDeletionAuthorized: false,
}, null, 2));
