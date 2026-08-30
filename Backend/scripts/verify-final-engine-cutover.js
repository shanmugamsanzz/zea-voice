import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const [contract, orchestrator, server, env, packageJson] = await Promise.all([
  read('src/knowledge-engine/engine-contract.js'),
  read('src/voice/realtime-conversation-orchestrator.js'),
  read('src/server.js'),
  read('src/config/env.js'),
  read('package.json'),
]);

const activeRuntime = [contract, orchestrator, server, env].join('\n');
assert.doesNotMatch(activeRuntime, /knowledgeEngineDecisionTypes\.(?:DIRECT|LLM)/u);
assert.doesNotMatch(activeRuntime, /VOICE_UNIFIED_GROUNDED_DECISION_ENABLED/u);
assert.doesNotMatch(activeRuntime, /interaction\/live-call-memory/u);
assert.doesNotMatch(orchestrator, /openGenericConversationState/u);
assert.match(orchestrator, /openIsolatedCallMemory/u);
assert.match(orchestrator, /applyUnifiedGroundedTurn/u);
assert.match(orchestrator, /finalizeConfiguredToolResults/u);

const obsoleteFiles = [
  'src/voice/interaction/live-call-memory.js',
  'scripts/verify-confidence-response-routing.js',
  'scripts/verify-grounded-llm-response.js',
  'scripts/verify-hybrid-production-engine.js',
  'scripts/verify-llm-first-understanding.js',
  'src/knowledge-engine/compact-evidence-bundle.js',
  'src/knowledge-bases/hybrid-knowledge-retrieval.service.js',
  'scripts/verify-final-stt-hybrid-hydration.js',
  'scripts/verify-concurrent-hybrid-retrieval.js',
  'scripts/verify-complete-health-call-production-replay.js',
  'scripts/verify-clean-hybrid-retrieval.js',
  'scripts/verify-direct-conversation-message.js',
  'scripts/verify-document-driven-conversation-runtime.js',
  'scripts/verify-exact-guidance-priority.js',
  'scripts/verify-failed-production-replay.js',
  'scripts/verify-guidance-continuation-grounding.js',
  'scripts/verify-generic-meaning-resolution.js',
  'scripts/verify-production-migration-gate.js',
  'scripts/verify-production-activation-gate-contract.js',
  'scripts/verify-welcome-acknowledgement-memory.js',
];
for (const path of obsoleteFiles) {
  await assert.rejects(access(new URL(path, root)), undefined, `${path} must remain removed`);
}

const scripts = JSON.parse(packageJson).scripts;
for (const [name, command] of Object.entries(scripts)) {
  for (const match of command.matchAll(/node\s+(scripts\/[^\s&]+\.js)/gu)) {
    await access(new URL(match[1], root)).catch(() => {
      assert.fail(`${name} references missing ${match[1]}`);
    });
  }
}

console.log(JSON.stringify({
  success: true,
  task: 'Final unified knowledge-engine cutover',
  outputTypes: ['RESPONSE', 'TOOL', 'CLARIFY'],
  obsoleteRuntimePaths: 0,
  missingScriptTargets: 0,
}));
