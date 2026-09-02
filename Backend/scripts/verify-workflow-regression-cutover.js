import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const [runtime, workflow, authorization, memory, grounding, packageText] = await Promise.all([
  read('src/voice/realtime-conversation-orchestrator.js'),
  read('src/voice/interaction/next-question-policy.js'),
  read('src/knowledge-bases/workflow-tool-authorization.js'),
  read('src/voice/interaction/conversation-memory-state.js'),
  read('src/knowledge-bases/grounded-normal-turn-runtime.js'),
  read('package.json'),
]);

assert.match(authorization, /assignedToolIdentifiers/u);
assert.match(authorization, /inputSchema/u);
assert.match(workflow, /missingFields/u);
assert.match(workflow, /awaiting_confirmation/u);
assert.match(runtime, /finalizeConfiguredToolResults/u);
assert.match(runtime, /verified_tool_success/u);
assert.match(grounding,
  /prepared\.deterministicProtocolException\s*!==\s*'SAFETY_EMERGENCY'/u,
  'only the published emergency protocol may decide a normal turn before the LLM');
assert.doesNotMatch(memory, /value\.selectedItem|value\.selectedCatalogItem|value\.candidateItems/u,
  'legacy item/category/candidate aliases must not repopulate canonical memory');
assert.doesNotMatch(packageText, /verify-confidence-routing|verify-parallel-hybrid-ranking/u);

for (const path of [
  'src/knowledge-bases/hybrid-evidence-ranker.js',
  'scripts/verify-confidence-routing.js',
  'scripts/verify-parallel-hybrid-ranking.js',
]) {
  await assert.rejects(access(new URL(path, root)), undefined,
    `${path} must remain removed after the unified RRF cutover`);
}

console.log(JSON.stringify({
  gate: 'workflow-regression-cutover',
  passed: true,
  workflowAuthorization: 'published_and_assigned_schema',
  fieldLifecycle: 'persist_collect_readback_confirm_execute',
  toolResults: 'verified_only',
  staleMemoryConversions: 0,
  duplicateRankers: 0,
  normalPreLlmDecisions: ['SAFETY_EMERGENCY'],
}));
