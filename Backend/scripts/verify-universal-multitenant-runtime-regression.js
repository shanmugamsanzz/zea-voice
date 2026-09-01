import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal multi-tenant runtime regression requires at least three passes');

function run(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 240_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return JSON.parse(String(result.stdout ?? '').trim());
}

const evidencePath = run(
  'universal evidence path',
  'scripts/verify-universal-evidence-path-regression.js',
  [`--repeats=${repeats}`],
);
const productionRuntime = run(
  'universal production runtime',
  'scripts/verify-universal-production-regression.js',
  [`--repeats=${repeats}`],
);
const multitenant = run(
  'universal multi-tenant acceptance',
  'scripts/verify-universal-multitenant-acceptance.js',
  [`--repeats=${repeats}`],
);
const workflowState = run(
  'production-shaped Workflow state',
  'scripts/verify-production-shaped-workflow-state.js',
  [`--repeats=${repeats}`],
);
const memoryRuns = Array.from({ length: repeats }, (_, index) => run(
  `memory and routing continuity pass ${index + 1}`,
  'scripts/verify-memory-routing-end-to-end.js',
));

assert.equal(evidencePath.passed, true);
assert.equal(productionRuntime.passed, true);
assert.equal(multitenant.passed, true);
assert.equal(evidencePath.repeats, repeats);
assert.equal(productionRuntime.repeats, repeats);
assert.equal(multitenant.repeats, repeats);
assert.equal(workflowState.passed, true);
assert.equal(workflowState.repeats, repeats);
assert.ok(memoryRuns.every((result) => result.passed === true));
assert.ok(memoryRuns.every((result) => result.callerCorrections === true));
assert.ok(memoryRuns.every((result) => result.followUpPrices === true));
assert.ok(memoryRuns.every((result) => result.fieldCollection === true));
assert.ok(memoryRuns.every((result) => result.topicSwitching === true));
assert.ok(memoryRuns.every((result) => result.unavailableInformation === true));

assert.ok(multitenant.syntheticIndustries.length >= 3,
  'The gate must cover at least three synthetic industries');
assert.ok(multitenant.languages.length >= 3,
  'The gate must cover at least three languages');
assert.equal(multitenant.directQuestions, true);
assert.equal(multitenant.overviews, true);
assert.equal(multitenant.knownEvidencePackagesNonEmpty, true);
assert.ok(multitenant.coverage.includes('contextual_follow_up'));
assert.ok(multitenant.coverage.includes('multi_entity_comparison'));
assert.ok(multitenant.sourceMappingsValidated > 0);
assert.ok(multitenant.completeMetadataRecords >= multitenant.sourceMappingsValidated);

assert.ok(productionRuntime.missingEvidenceOperationalFailures > 0,
  'Missing evidence must exercise operational recovery');
assert.equal(
  productionRuntime.configuredTechnicalRecoveries,
  productionRuntime.missingEvidenceOperationalFailures,
  'Every missing-evidence failure must use configured technical recovery',
);
assert.equal(productionRuntime.processingTimeInactivityPrompts, 0);
assert.ok(productionRuntime.finalAnswersAfterAcknowledgement > 0);
assert.ok(productionRuntime.delayedTtsCompletions > 0);
assert.equal(productionRuntime.runtimeFailures, 0);
assert.equal(productionRuntime.audioFailures, 0);

for (const result of [evidencePath, productionRuntime]) {
  assert.equal(result.hardcodedBusinessVocabulary, false);
  assert.equal(result.crossTenantLeakage, false);
}
assert.equal(multitenant.crossTenantLeakage, false);
assert.equal(evidencePath.validationExceptions, 0);
assert.equal(evidencePath.runtimeExceptions, 0);
assert.equal(productionRuntime.runtimeErrors, 0);
assert.equal(multitenant.runtimeErrors, 0);
assert.equal(workflowState.preservedWorkflowState, true);
assert.ok(workflowState.partialFieldCollections > 0);
assert.ok(workflowState.completeFieldCollections > 0);
assert.ok(workflowState.dateTimeFollowUps > 0);
assert.ok(workflowState.confirmations > 0);
assert.ok(workflowState.cancellations > 0);
assert.ok(workflowState.decisions.RESPONSE > 0);
assert.ok(workflowState.decisions.CLARIFY > 0);
assert.ok(workflowState.decisions.TOOL > 0);
assert.ok(workflowState.verifiedToolExecutions > 0);
assert.ok(workflowState.verifiedToolFailures > 0);
assert.ok(workflowState.validationRejections > 0);
assert.equal(workflowState.repeatedCollectedQuestions, 0);
assert.equal(workflowState.falseTechnicalResponses, 0);
assert.equal(workflowState.silentTurns, 0);
assert.equal(workflowState.crossTenantLeakage, false);

console.log(JSON.stringify({
  gate: 'universal-multitenant-runtime-regression',
  passed: true,
  repeats,
  syntheticIndustries: multitenant.syntheticIndustries,
  languages: multitenant.languages,
  directQuestions: true,
  overviews: true,
  contextualFollowUps: true,
  comparisons: true,
  missingEvidenceOperationalRecovery: true,
  knownEvidencePackagesNonEmpty: true,
  sourceMappingsValidated: multitenant.sourceMappingsValidated,
  hardcodedBusinessVocabulary: false,
  crossTenantLeakage: false,
  falseInactivityPrompts: 0,
  finalAnswerAfterAcknowledgement: true,
  delayedTtsVerified: true,
  workflowStatePreserved: true,
  contextualPricesAndDetails: true,
  correctionsAndTopicSwitching: true,
  partialAndCompleteFieldCollection: true,
  dateTimeFollowUps: true,
  confirmationCancellationAndToolFailure: true,
  correctDecisionTypes: true,
  verifiedToolExecution: true,
  repeatedCollectedQuestions: 0,
  falseTechnicalResponses: 0,
  audioFailures: 0,
  validationExceptions: 0,
  runtimeExceptions: 0,
}, null, 2));
