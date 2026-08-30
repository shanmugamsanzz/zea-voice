import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal evidence-path regression requires at least three passes');

function run(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return String(result.stdout ?? '').trim();
}

const multitenant = JSON.parse(run(
  'multi-tenant evidence path',
  'scripts/verify-universal-multitenant-acceptance.js',
  [`--repeats=${repeats}`],
));
assert.equal(multitenant.passed, true);
assert.equal(multitenant.repeats, repeats);
assert.ok(multitenant.syntheticIndustries.length >= 3);
assert.ok(multitenant.coverage.includes('canonical_category_answer'));
assert.ok(multitenant.coverage.includes('natural_non_exact'));
assert.ok(multitenant.coverage.includes('contextual_follow_up'));
assert.ok(multitenant.coverage.includes('multi_entity_comparison'));
assert.ok(multitenant.sourceMappingsValidated > 0);
assert.ok(multitenant.completeMetadataRecords >= multitenant.sourceMappingsValidated);
assert.equal(multitenant.crossTenantLeakage, false);
assert.equal(multitenant.runtimeErrors, 0);

run('unified hydrated evidence and source mapping', 'scripts/verify-grounded-turn-evidence-pipeline.js');
run('complete authoritative metadata', 'scripts/verify-authoritative-hydration-readiness.js');
run('compact prompt and operational failure separation',
  'scripts/verify-compact-grounded-llm-budget.js');
run('validation and runtime cutover', 'scripts/verify-final-grounded-engine-cutover.js');

const hardcoding = JSON.parse(run(
  'universal runtime hardcoding scan', 'scripts/verify-universal-hardcoding-gate.js',
));
assert.equal(hardcoding.passed, true);
assert.equal(hardcoding.prohibitedBusinessLiteralMatches, 0);
assert.equal(hardcoding.crossTenantLeakage, false);

console.log(JSON.stringify({
  gate: 'universal-evidence-path-regression',
  passed: true,
  repeats,
  syntheticIndustries: multitenant.syntheticIndustries,
  correctOverviewsAndEntities: true,
  sourceMappingsValidated: multitenant.sourceMappingsValidated,
  completeMetadataRecords: multitenant.completeMetadataRecords,
  contextualFollowUps: true,
  comparisons: true,
  operationalFailuresUseGenericFallback: false,
  hardcodedBusinessVocabulary: false,
  crossTenantLeakage: false,
  promptBudgetCompliant: true,
  validationExceptions: 0,
  runtimeExceptions: 0,
}, null, 2));
