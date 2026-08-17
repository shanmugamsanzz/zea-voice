import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateGroundedClaim,
  validateGroundedClaims,
  hydrateSelectedEvidence,
  hydrateGroundingEnvelope,
  rankRelevantHydratedEvidence,
  validateCallerProvidedState,
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
assert.equal(validateGroundedClaim('The request was confirmed.', [{
  content: 'Verified tool result: failure.', recordType: 'TOOL_RESULT',
  authoritativeData: { verified: true, success: false },
}]).reason, 'unauthorized_action_claim');
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
assert.equal(validateGroundedClaim('Any answer without selected evidence.', []).reason,
  'selected_evidence_missing');
assert.equal(validateGroundedClaim(
  'This screening detects cancer at an early stage.',
  [{ content: 'This is an approved cancer screening package.', recordType: 'CATALOG_ITEM' }],
).reason, 'unsupported_medical_claim');
assert.equal(validateGroundedClaim(
  'Premium Plan costs INR 3200.',
  [{ content: 'Standard Plan costs INR 1200.', recordType: 'CATALOG_ITEM' }],
  { knownEntities: [{ key: 'premium', name: 'Premium Plan' }] },
).reason, 'unsupported_numeric_fact');
const hydrated = hydrateSelectedEvidence(
  { evidenceIds: ['envelope-1'] },
  { sources: [{ id: 'envelope-1', recordId: 'record-1', content: 'partial snippet' }] },
  [{ id: 'postgres-1', recordId: 'record-1', content: 'complete authoritative record' }],
);
assert.equal(hydrated.length, 1);
assert.equal(hydrated[0].content, 'complete authoritative record');
assert.equal(hydrateSelectedEvidence(
  { evidenceIds: ['envelope-1'] },
  { sources: [{ id: 'envelope-1', recordId: 'record-1', content: 'partial snippet' }] },
  [],
).length, 0, 'A discovery snippet must never substitute for PostgreSQL hydration');
const hydratedEnvelope = hydrateGroundingEnvelope(
  { found: true, sources: [{ id: 'envelope-1', recordId: 'record-1', content: 'partial' }], entities: [] },
  [{ id: 'postgres-1', recordId: 'record-1', content: 'complete authoritative record' }],
);
assert.equal(hydratedEnvelope.sources[0].content, 'complete authoritative record');
assert.equal(validateCallerProvidedState(
  { collectedInformation: { contact_name: 'Asha', age: 21 } },
  'My name is Asha and age is 21', { collectedInformation: {} },
).valid, true);
assert.equal(validateCallerProvidedState(
  { collectedInformation: { contact_name: 'Priya' } },
  'My name is Asha', { collectedInformation: {} },
).reason, 'unsupported_caller_value');
assert.equal(validateCallerProvidedState(
  { collectedInformation: { contact_name: 'Asha' } },
  'What is the location?', { collectedInformation: { contact_name: 'Asha' } },
).valid, true);
const relevant = rankRelevantHydratedEvidence(
  'Tell me about premium plan',
  { sources: [
    { id: 'overview', recordId: 'overview-record', content: 'Available plans overview' },
    { id: 'premium', recordId: 'premium-record', content: 'partial premium' },
  ] },
  [
    { recordId: 'overview-record', content: 'Available plans are Standard and Premium.', rank: 1, score: 0.8, callerFacing: true },
    { recordId: 'premium-record', content: 'Premium Plan costs INR 3200.', rank: 2, score: 0.75, callerFacing: true },
  ],
);
assert.equal(relevant[0].source.recordId, 'premium-record');

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
assert.match(orchestrator, /const documentFallback = unifiedGroundedDecision[\s\S]*approvedHydratedEvidenceFallback/u);
assert.match(orchestrator, /hydrateSelectedEvidence\(decoded\.decision, groundingEnvelope, authoritativeEvidence\)/u);

console.log('Strong grounding and interruption preservation verification passed.');
