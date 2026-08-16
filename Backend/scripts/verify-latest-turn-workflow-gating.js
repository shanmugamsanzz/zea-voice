import assert from 'node:assert/strict';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { latestTurnWorkflowActivation } from '../src/knowledge-bases/workflow-activation-policy.js';

function extraction(text) {
  const lines = text.trim().split(/\r?\n/u);
  return { fullText: lines.join('\n'), pages: [{ pageNumber: 1, lines }] };
}

const parsed = processExtractedCategory('workflow_rules', extraction(`
RULE: submit_request
SITUATION: caller explicitly asks to submit the request
EXAMPLE: please submit my request
RESPONSE_MODE: instruction
TOOL: tenant.request.submit_v1
RESPONSE: Collect the configured fields and request execution.
`));
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.records.length, 1);
const conditions = parsed.records[0].conditions;

assert.deepEqual(latestTurnWorkflowActivation({
  latestUtterance: 'please submit my request', conditions,
}), { allowed: true, method: 'exact', matchedPhrase: 'please submit my request' });
assert.equal(latestTurnWorkflowActivation({
  latestUtterance: 'Okay, please submit my request now', conditions,
}).allowed, true);
assert.deepEqual(latestTurnWorkflowActivation({
  latestUtterance: 'Tell me the available colours', conditions,
}), { allowed: false, method: 'semantic_only', matchedPhrase: null });
assert.equal(latestTurnWorkflowActivation({
  latestUtterance: 'request', conditions: { examples: ['request'] },
}).allowed, true, 'A one-token phrase is valid only as a complete utterance');
assert.equal(latestTurnWorkflowActivation({
  latestUtterance: 'show request status', conditions: { examples: ['request'] },
}).allowed, false, 'A generic one-token phrase cannot activate by containment');

console.log(JSON.stringify({
  task: 'latest-turn-workflow-gating', passed: true,
  parserToPolicy: true, semanticOnlyActivationBlocked: true,
}));
