import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repeats = Number(process.argv.find((value) => value.startsWith('--repeats='))
  ?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20);

function run(name, file, args = [], pattern = null) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0,
    [`${name} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'));
  const output = String(result.stdout ?? '').trim();
  if (pattern) {
    assert.match(output, pattern);
    return output;
  }
  return JSON.parse(output);
}

function requireTrue(value, fields) {
  for (const field of fields) assert.equal(value[field], true, field);
}

function requireZero(value, fields) {
  for (const field of fields) assert.equal(value[field], 0, field);
}

const universal = run('multi-tenant grounded replay',
  'scripts/verify-universal-multitenant-acceptance.js', [`--repeats=${repeats}`]);
requireTrue(universal, ['passed', 'directQuestions', 'knownEvidencePackagesNonEmpty']);
assert.equal(universal.repeats, repeats);
assert.ok(universal.languages.length >= 3 && universal.syntheticIndustries.length >= 3);
for (const scenario of [
  'phonetic_stt', 'contextual_follow_up', 'price_and_details',
  'multi_entity_comparison', 'topic_switching', 'genuine_ambiguity',
  'cross_tenant_isolation', 'unsupported_claim_rejection',
]) assert.ok(universal.coverage.includes(scenario), scenario);
requireZero(universal, [
  'falseClarifications', 'staleAnswers', 'unsupportedClaimsAccepted', 'runtimeErrors',
]);
assert.equal(universal.crossTenantLeakage, false);

const memory = run('memory and correction replay',
  'scripts/verify-memory-routing-end-to-end.js');
requireTrue(memory, [
  'passed', 'followUpPrices', 'lastDiscussedEntities', 'callerCorrections', 'topicSwitching',
]);
assert.ok(memory.tenants >= 3 && memory.languages.length >= 3);
requireZero(memory, ['technicalFallbacks', 'silentTurns']);
for (const field of ['staleMemory', 'duplicateEvidence', 'crossTenantLeakage']) {
  assert.equal(memory[field], false, field);
}

const categories = run('category-child handling',
  'scripts/verify-category-item-handling.js');
requireTrue(categories, [
  'passed', 'uniqueChildReserved', 'multipleChildrenClarified',
  'nonSelectableChildExcluded', 'unrelatedItemExcluded',
]);

const isolation = run('evidence isolation',
  'scripts/verify-latest-request-evidence-isolation.js');
requireTrue(isolation, [
  'passed', 'focusedCatalogIsolation', 'workflowIsolation', 'conversationIsolation',
  'latestRequestRelevanceBand', 'crossNamespaceRelevanceBand',
]);
assert.equal(isolation.maximumVerifiedRecords, 5);

const zeroEvidence = run('zero-evidence replay',
  'scripts/verify-zero-evidence-multitenant.js', [`--repeats=${repeats}`]);
assert.equal(zeroEvidence.passed, true);
assert.ok(zeroEvidence.tenants >= 3 && zeroEvidence.languages.length >= 3);
assert.equal(zeroEvidence.llmDecisions, zeroEvidence.turns);
requireZero(zeroEvidence, [
  'hallucinationsAccepted', 'falseValidationRejections', 'silentTurns',
]);
assert.equal(zeroEvidence.crossTenantLeakage, false);

const hardcoding = run('hardcoding gate', 'scripts/verify-universal-hardcoding-gate.js');
assert.equal(hardcoding.passed, true);
assert.equal(hardcoding.prohibitedBusinessLiteralMatches, 0);
assert.equal(hardcoding.crossTenantLeakage, false);
run('audio lifecycle', 'scripts/verify-operational-audio-lifecycle.js', [],
  /Operational recovery and final-playback inactivity lifecycle verification passed/u);

console.log(JSON.stringify({
  gate: 'template-engine-regression', passed: true, repeats,
  tenants: universal.syntheticIndustries.length, languages: universal.languages,
  scenarios: [
    'direct_entities', 'phonetic_names', 'contextual_prices_and_details',
    'categories_with_multiple_children', 'corrections', 'comparisons',
    'topic_switching', 'zero_evidence',
  ],
  hardcodedVocabulary: false, staleMemory: false, unrelatedEvidence: false,
  hallucinations: 0, technicalFallbacks: 0, silentTurns: 0,
  crossTenantLeakage: false,
}, null, 2));
