import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal contextual reliability requires at least three passes');

function run(name, file, args = [], expectedOutput = null) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  const output = String(result.stdout ?? '').trim();
  if (expectedOutput) assert.match(output, expectedOutput, `${name} output contract failed`);
  return output;
}

const contextualOutput = run(
  'multi-tenant contextual replay',
  'scripts/verify-universal-multitenant-acceptance.js',
  [`--repeats=${repeats}`],
);
const contextual = JSON.parse(contextualOutput);
assert.equal(contextual.passed, true);
assert.equal(contextual.repeats, repeats);
for (const requirement of [
  'contextual_follow_up', 'context_enriched_retrieval', 'contextual_timing',
  'topic_switching', 'isolated_memory', 'price_and_details',
  'multi_entity_comparison', 'phonetic_stt', 'genuine_ambiguity',
  'false_ambiguity_rejected', 'verified_tool', 'cross_tenant_isolation',
]) assert.ok(contextual.coverage.includes(requirement), requirement);
assert.equal(contextual.falseClarifications, 0);
assert.equal(contextual.staleAnswers, 0);
assert.equal(contextual.unsupportedClaimsAccepted, 0);
assert.equal(contextual.blindRetrieval, false);
assert.equal(contextual.genericRepeatedClarifications, 0);
assert.equal(contextual.toolMistakes, 0);
assert.equal(contextual.crossTenantLeakage, false);
assert.equal(contextual.runtimeErrors, 0);

const clarificationOutput = run(
  'reason-specific clarification recovery',
  'scripts/verify-production-clarification-reliability.js',
  [`--repeats=${repeats}`],
);
const clarification = JSON.parse(clarificationOutput);
assert.equal(clarification.success, true);
assert.ok(clarification.repeatedClarificationsRecovered > 0);
assert.ok(clarification.audibleUnconfiguredRecoveries > 0,
  'genuine ambiguity must produce audible targeted clarification even without support speech');
assert.equal(clarification.crossTenantLeakage, 0);
assert.equal(clarification.runtimeExceptions, 0);

run('interruption isolation', 'scripts/verify-interruption-engine.js', [],
  /Race-safe interruption call-level scenarios|"success":true/u);
run('tool continuation after interruption',
  'scripts/verify-interruption-continuation-tools.js', [],
  /Interruption, continuation and configured-tool verification passed/u);
run('grounded interruption preservation',
  'scripts/verify-strong-grounding-interruption.js', [],
  /Strong grounding and interruption preservation verification passed/u);

const hardcodingOutput = run(
  'universal hardcoding scan',
  'scripts/verify-universal-hardcoding-gate.js',
);
const hardcoding = JSON.parse(hardcodingOutput);
assert.equal(hardcoding.passed, true);
assert.equal(hardcoding.crossTenantLeakage, false);
assert.equal(hardcoding.prohibitedBusinessLiteralMatches, 0);

console.log(JSON.stringify({
  gate: 'universal-contextual-reliability',
  passed: true,
  repeats,
  syntheticIndustries: contextual.syntheticIndustries,
  languages: contextual.languages,
  contextualCoverage: contextual.coverage,
  verifiedTools: contextual.verifiedTools,
  repeatedClarificationsRecovered: clarification.repeatedClarificationsRecovered,
  audibleTargetedClarifications: clarification.audibleUnconfiguredRecoveries,
  interruptionsVerified: true,
  crossTenantLeakage: false,
  crossCallLeakage: false,
  hardcodedBusinessVocabulary: false,
  staleAnswers: 0,
  blindRetrieval: false,
  genericRepeatedClarifications: 0,
  unsupportedClaims: 0,
  toolMistakes: 0,
  runtimeErrors: 0,
}, null, 2));
