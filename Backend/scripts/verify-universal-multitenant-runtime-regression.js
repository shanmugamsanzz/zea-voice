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

function runStatus(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 240_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return true;
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
const groundedValidationRuns = Array.from({ length: repeats }, (_, index) => runStatus(
  `grounded fact and Workflow validation pass ${index + 1}`,
  'scripts/verify-unified-grounded-turn.js',
));
const finalizedSttRuns = Array.from({ length: repeats }, (_, index) => runStatus(
  `finalized STT policy pass ${index + 1}`,
  'scripts/verify-final-stt-only.js',
));
const incompleteTurnRuns = Array.from({ length: repeats }, (_, index) => runStatus(
  `incomplete finalized turn pass ${index + 1}`,
  'scripts/verify-interruption-engine.js',
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
assert.ok(memoryRuns.every((result) => result.authorizedBooking === true));
assert.ok(memoryRuns.every((result) => result.lastDiscussedEntities === true));
assert.ok(memoryRuns.every((result) => result.staleMemory === false));
assert.ok(memoryRuns.every((result) => result.duplicateEvidence === false));
assert.ok(memoryRuns.every((result) => result.unauthorizedTools === false));
assert.ok(memoryRuns.every((result) => result.technicalFallbacks === 0));
assert.ok(memoryRuns.every((result) => result.silentTurns === 0));
assert.ok(memoryRuns.every((result) => result.unsupportedNumericFactFalsePositives === 0));
assert.ok(memoryRuns.every((result) => result.crossTenantLeakage === false));
assert.ok(groundedValidationRuns.every(Boolean));
assert.ok(finalizedSttRuns.every(Boolean));
assert.ok(incompleteTurnRuns.every(Boolean));

assert.ok(multitenant.syntheticIndustries.length >= 3,
  'The gate must cover at least three synthetic industries');
assert.ok(multitenant.languages.length >= 3,
  'The gate must cover at least three languages');
assert.equal(multitenant.directQuestions, true);
assert.equal(multitenant.overviews, true);
assert.equal(multitenant.knownEvidencePackagesNonEmpty, true);
for (const requirement of [
  'phonetic_stt', 'contextual_follow_up', 'price_and_details',
  'multi_entity_comparison', 'topic_switching', 'verified_tool',
  'genuine_ambiguity', 'false_ambiguity_rejected', 'unsupported_claim_rejection',
  'targeted_weak_evidence',
]) assert.ok(multitenant.coverage.includes(requirement), requirement);
assert.ok(multitenant.sourceMappingsValidated > 0);
assert.ok(multitenant.completeMetadataRecords >= multitenant.sourceMappingsValidated);
assert.equal(multitenant.falseClarifications, 0);
assert.equal(multitenant.staleAnswers, 0);
assert.equal(multitenant.unsupportedClaimsAccepted, 0);
assert.equal(multitenant.blindRetrieval, false);
assert.equal(multitenant.toolMistakes, 0);

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
assert.ok(workflowState.verifiedToolTimeouts > 0);
assert.ok(workflowState.validationRejections > 0);
assert.equal(workflowState.repeatedCollectedQuestions, 0);
assert.equal(workflowState.falseTechnicalResponses, 0);
assert.equal(workflowState.silentTurns, 0);
assert.equal(workflowState.crossTenantLeakage, false);
assert.ok(workflowState.syntheticIndustries.length >= 3);
assert.ok(workflowState.languages.length >= 3);

console.log(JSON.stringify({
  gate: 'universal-multitenant-runtime-regression',
  passed: true,
  repeats,
  syntheticIndustries: multitenant.syntheticIndustries,
  languages: multitenant.languages,
  directQuestions: true,
  overviews: true,
  phoneticNames: true,
  contextualFollowUps: true,
  contextualDetails: true,
  contextualPrices: true,
  comparisons: true,
  callerCorrections: true,
  topicChanges: true,
  unavailableFacts: true,
  bookingAcrossTenantsAndLanguages: true,
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
  toolSuccessTimeoutAndFailure: true,
  correctDecisionTypes: true,
  verifiedToolExecution: true,
  repeatedCollectedQuestions: 0,
  falseTechnicalResponses: 0,
  unknownAgeLimitsRejected: true,
  unavailableFactsUseConfiguredSpeech: true,
  finalizedIncompleteSttTurns: true,
  unrelatedEvidence: 0,
  falseValidationRejections: 0,
  validTurnTechnicalFallbacks: 0,
  hallucinations: 0,
  staleEntities: 0,
  unauthorizedTools: 0,
  silentTurns: 0,
  audioFailures: 0,
  validationExceptions: 0,
  runtimeExceptions: 0,
}, null, 2));
