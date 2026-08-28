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

assert.equal(evidencePath.passed, true);
assert.equal(productionRuntime.passed, true);
assert.equal(multitenant.passed, true);
assert.equal(evidencePath.repeats, repeats);
assert.equal(productionRuntime.repeats, repeats);
assert.equal(multitenant.repeats, repeats);

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
  audioFailures: 0,
  validationExceptions: 0,
  runtimeExceptions: 0,
}, null, 2));
