import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');
const release = await readFile(new URL(
  '../src/release/runtime-release-metadata.js', import.meta.url,
), 'utf8');

assert.match(source, /outcome\s*=\s*await this\.#runTemplateEngineTurn\(/u);
assert.match(source, /engine:\s*'template_engine_v1'/u);
assert.doesNotMatch(source, /#runGroundedTurn\s*\(/u);
assert.doesNotMatch(source, /#llmAttempt\s*\(/u);
assert.doesNotMatch(source, /#knowledge\s*\(/u);
assert.doesNotMatch(source, /retrieveTenantEvidence/u);
assert.doesNotMatch(source, /applyUnifiedGroundedTurn/u);
assert.doesNotMatch(source, /createGroundedLlmOutput/u);
assert.doesNotMatch(source, /createSelectedLlmStream/u);
assert.doesNotMatch(source, /templateEngineCutover/u);
assert.match(release, /engine:\s*'template_engine_v1'/u);
assert.doesNotMatch(release, /unified_grounded_decision/u);
assert.doesNotMatch(release, /GROUNDED_NORMAL_TURN_RUNTIME_VERSION/u);

console.log('Template-engine direct live cutover verification passed.');
