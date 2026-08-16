import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateGroundedClaim,
  validateGroundedClaims,
} from '../src/voice/interaction/grounded-claim-validator.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';

const factualSources = [{
  id: 'fact-1', recordType: 'GENERAL_KNOWLEDGE',
  content: 'Priority service is available. It costs INR 3200 and includes standard support.',
}];
assert.equal(validateGroundedClaim('Priority service is not available.', factualSources).reason,
  'unsupported_negation');
assert.equal(validateGroundedClaim('Priority service does not include standard support.', factualSources).reason,
  'unsupported_negation');
assert.equal(validateGroundedClaims('Priority service costs INR 3500.', factualSources).reason,
  'unsupported_numeric_fact');
assert.equal(validateGroundedClaim('The request was confirmed.', factualSources).reason,
  'unauthorized_action_claim');
assert.equal(validateGroundedClaim('Caller asked information; retrieve approved evidence.', factualSources).reason,
  'internal_guidance');
assert.equal(validateGroundedClaim('Priority service is available.', [{
  content: 'Priority service is not available.', recordType: 'GENERAL_KNOWLEDGE',
}]).reason, 'contradictory_claim');
assert.equal(validateGroundedClaim('The request was confirmed.', [{
  content: 'The request was confirmed.', recordType: 'TOOL_RESULT',
  authoritativeData: { verified: true, success: true },
}]).valid, true);
for (const [claim, content] of [
  ['Priority service includes standard support.', 'Priority service includes standard support.'],
  ['You do not need additional setup.', 'No additional setup is required.'],
  ['The company was created in 1990.', 'The company was created in 1990.'],
  ['It includes not only support but setup.', 'It includes support and setup.'],
  ['Priority service available irukku.', 'Priority service is available.'],
]) {
  assert.equal(validateGroundedClaim(claim, [{ content, recordType: 'GENERAL_KNOWLEDGE' }]).valid,
    true, `supported natural statement should pass: ${claim}`);
}
assert.equal(validateGroundedClaim(
  'Priority service \u0B87\u0BB2\u0BCD\u0BB2\u0BC8.', factualSources,
).reason, 'unsupported_negation');

const memory = openGenericConversationState({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, {}, Date.now(), {
  pendingQuestion: { key: 'choice', text: 'Which option do you prefer?', kind: 'conversation' },
});
memory.beginTurn('turn-1');
memory.cancelTurn('turn-1');
assert.equal(memory.snapshot().pendingQuestion.text, 'Which option do you prefer?');
memory.beginTurn('turn-2');
memory.append({ role: 'user', content: 'Can you hear me?' }, { turnToken: 'turn-2' });
assert.equal(memory.snapshot().pendingQuestion.text, 'Which option do you prefer?');
memory.close();

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /typeof liveMemory\.pendingQuestion === 'object'/u);
assert.match(orchestrator, /fieldSchemas\?\.\(\)/u);
assert.match(orchestrator, /pendingField\?\.question \?\? pendingQuestion\?\.text/u);

console.log('Strong grounding and interruption preservation verification passed.');
