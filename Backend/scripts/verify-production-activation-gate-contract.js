import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const gateSource = await readFile(new URL('scripts/verify-live-production-acceptance.js', root), 'utf8');
const deploymentGateSource = await readFile(
  new URL('scripts/verify-production-migration-gate.js', root), 'utf8',
);
const replay = JSON.parse(await readFile(
  new URL('fixtures/failed-call-2026-08-19-production.json', root), 'utf8',
));

assert.match(gateSource, /PRODUCTION_ACCEPTANCE_EXPECTED_REVISIONS/u);
assert.match(gateSource, /countTenantPointsByKnowledgeBaseRevision/u);
assert.match(gateSource, /candidateRevisionFingerprint/u);
assert.match(gateSource, /semantic retrieval returned no candidates/u);
assert.match(gateSource, /semantic retrieval trace has no genuine non-zero score/u);
assert.match(gateSource, /unsupported evidence type/u);
assert.match(gateSource, /personal\/configured fields were collected without authorization/u);
assert.match(gateSource, /internal JSON reached TTS/u);
assert.match(gateSource, /assistant response was duplicated in memory/u);
assert.match(gateSource, /retrievalP95/u);
assert.match(gateSource, /llmP95/u);
assert.match(gateSource, /totalP95/u);

const calls = replay.calls ?? [];
assert.ok(calls.some((call) => call.sourceCallId), 'A failed production call replay is required');
const languages = new Set(calls.flatMap((call) => (
  (call.turns ?? []).map((turn) => String(turn.language ?? call.language).toLowerCase())
)));
for (const language of ['ta', 'tanglish', 'en']) {
  assert.ok(languages.has(language), `Replay fixture is missing ${language}`);
}
assert.match(deploymentGateSource, /candidateRevisionPinned/u);
assert.match(deploymentGateSource, /qdrantRevisionValidated/u);
assert.match(deploymentGateSource, /PRODUCTION_ACCEPTANCE_MAX_AGE_MS/u);

console.log(JSON.stringify({
  gate: 'production-activation-contract', passed: true,
  failedCalls: calls.filter((call) => call.sourceCallId).length,
  unseenLanguages: [...languages].sort(),
}));
