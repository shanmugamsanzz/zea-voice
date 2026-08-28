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
  'unsupported_claim_polarity');
assert.equal(validateGroundedClaim('Priority service does not include standard support.', factualSources).reason,
  'unsupported_claim_polarity');
assert.equal(validateGroundedClaims('Priority service costs INR 3500.', factualSources).reason,
  'unsupported_numeric_fact');
assert.equal(validateGroundedClaim(
  'Tests: 1. CBC, 2. RBS.',
  [{
    content: 'Approved package.', recordType: 'CATALOG_ITEM',
    authoritativeData: { attributes: { tests: ['CBC', 'RBS'] } },
  }],
).valid, true, 'ordered-list markers are presentation, not factual numeric claims');
assert.equal(validateGroundedClaim(
  'The package includes 9 tests.',
  [{ content: 'Approved package.', recordType: 'CATALOG_ITEM' }],
).reason, 'unsupported_numeric_fact', 'a calculated count remains a checked factual number');
assert.equal(validateGroundedClaim('The request was confirmed.', factualSources).reason,
  'unauthorized_action_claim');
assert.equal(validateGroundedClaim('Caller asked information; retrieve approved evidence.', factualSources).reason,
  'internal_guidance');
assert.equal(validateGroundedClaim('Priority service is available.', [{
  content: 'Priority service is not available.', recordType: 'GENERAL_KNOWLEDGE',
}]).reason, 'unsupported_claim_polarity');
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
).reason, 'unsupported_claim_polarity');
assert.equal(validateGroundedClaim(
  '\u0B87\u0BB2\u0BCD\u0BB2\u0BC8, Priority service costs INR 3200.', factualSources,
).valid, true, 'a conversational correction marker must not become a negative factual claim');
const multilingualGrounding = validateGroundedClaim(
  'இந்த சேவையில் standard support கிடைக்கும்.', factualSources,
);
assert.equal(multilingualGrounding.valid, true);
assert.equal(Object.hasOwn(multilingualGrounding, 'overlap'), false);
assert.equal(validateGroundedClaim('Any answer without selected evidence.', []).reason,
  'selected_evidence_missing');
assert.equal(validateGroundedClaim(
  'This screening detects cancer at an early stage.',
  [{ content: 'This is an approved cancer screening package.', recordType: 'CATALOG_ITEM' }],
).reason, 'unsupported_medical_claim');
assert.equal(validateGroundedClaim(
  'This screening detects cancer at an early stage.',
  [{ content: 'The screening detects cancer indicators.', recordType: 'CATALOG_ITEM' }],
).valid, true);
assert.equal(validateGroundedClaim(
  'The published relationship recommends the Mobility Review option, but a qualified professional must confirm personal suitability.',
  [{
    content: 'Mobility Review is a published screening option.',
    recordType: 'CATALOG_ITEM',
    authoritativeData: {
      name: 'Mobility Review',
      relationships: { recommendedFor: ['joint discomfort'] },
    },
  }],
  {
    finalizedUtterance: 'I have joint discomfort; which option is related?',
    knownEntities: [{ key: 'mobility-review', name: 'Mobility Review' }],
  },
).valid, true, 'Published structured relationships must support qualified recommendations');
assert.equal(validateGroundedClaim(
  'The Mobility Review option is best for headaches.',
  [{
    content: 'Mobility Review is a published screening option.',
    recordType: 'CATALOG_ITEM',
    authoritativeData: {
      name: 'Mobility Review',
      relationships: { recommendedFor: ['breathing concern'] },
    },
  }],
  { finalizedUtterance: 'I have joint pain; which option is best?' },
).reason, 'unsupported_suitability_recommendation',
'A relationship for a different concern must not authorize a recommendation');
assert.equal(validateGroundedClaim(
  'The package includes CBC.',
  [{ content: 'Approved package.', recordType: 'CATALOG_ITEM', authoritativeData: { attributes: { tests: ['CBC'] } } }],
).valid, true);
assert.equal(validateGroundedClaim(
  'The package includes MRI.',
  [{ content: 'Approved package.', recordType: 'CATALOG_ITEM', authoritativeData: { attributes: { tests: ['CBC'] } } }],
).reason, 'unsupported_structured_fact');
assert.equal(validateGroundedClaim(
  'The package includes CBC, RBS, CRP, ESR, X-Ray, ECG and PFT.',
  [{
    content: 'Approved package.', recordType: 'CATALOG_ITEM',
    authoritativeData: {
      attributes: [{ key: 'tests', value: ['Cbc', 'rbs', 'Crp', 'esr', 'X-Ray', 'Ecg', 'pft'] }],
    },
  }],
).valid, true, 'Catalog identifier validation must be casing-neutral and preserve X-Ray');
assert.equal(validateGroundedClaim(
  'The package includes CA 19.9 and CT Scan.',
  [{
    content: 'Approved package.', recordType: 'CATALOG_ITEM',
    authoritativeData: { attributes: [{ key: 'tests', value: ['CA 19.9', 'CT Scan'] }] },
  }],
).valid, true, 'two-letter Catalog abbreviations must remain valid evidence');
assert.equal(validateGroundedClaim(
  'The package includes CBC, RBS, CRP, ESR, ECG and PFT.',
  [{
    content: `Long approved narrative ${'description '.repeat(1_200)}`,
    recordType: 'CATALOG_ITEM',
    authoritativeData: {
      attributes: [{ key: 'tests', value: ['Cbc', 'rbs', 'Crp', 'esr', 'Ecg', 'pft'] }],
    },
  }],
).valid, true, 'long source narratives must not truncate canonical structured attributes');
assert.equal(validateGroundedClaim(
  'The package includes CBC, RBS, CRP, ESR, ECG and PFT.',
  [{
    content: 'Approved package includes CBC and ECG.', recordType: 'CATALOG_ITEM',
    authoritativeData: {
      sourceText: 'ATTRIBUTES: tests CBC, RBS, CRP, ESR, ECG, PFT',
      attributes: [{ key: 'tests', value: ['CBC', 'ECG'] }],
    },
  }],
).valid, true, 'approved Catalog source text must prevent normalized child-data loss');
assert.equal(validateGroundedClaim(
  'The Lungs Health Checkup includes CBC, RBS, CRP, ESR, ECG and PFT.',
  [{
    content: 'Approved Lungs Health Checkup package.', recordType: 'CATALOG_ITEM',
    authoritativeData: {
      description: 'x'.repeat(12_000),
      sourceText: 'Approved package source.',
      attributes: [{ key: 'tests', value: ['CBC', 'RBS', 'CRP', 'ESR', 'ECG', 'PFT'] }],
    },
  }],
).valid, true, 'Catalog attributes must remain visible after large descriptive fields');
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
const mappedDespiteStaleDiscoveryFlag = hydrateGroundingEnvelope(
  { found: false, sources: [{ id: 'envelope-1', recordId: 'record-1', content: 'partial' }], entities: [] },
  [{ id: 'postgres-1', recordId: 'record-1', content: 'complete authoritative record' }],
);
assert.equal(mappedDespiteStaleDiscoveryFlag.found, true,
  'PostgreSQL hydration must prevent false verified_evidence_missing rejection');
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
memory.beginTurn('interrupted-answer');
const beforeInterruptedAnswer = memory.snapshot();
memory.observeAssistantResponse('First audible sentence. Second sentence was never played.', {
  turnToken: 'interrupted-answer',
});
memory.append({
  role: 'assistant', content: 'First audible sentence. Second sentence was never played.',
}, { turnToken: 'interrupted-answer' });
memory.reconcileInterruptedAssistantResponse('First audible sentence.', beforeInterruptedAnswer, {
  turnToken: 'interrupted-answer',
});
memory.cancelTurn('interrupted-answer');
assert.equal(memory.snapshot().lastAnswer, 'First audible sentence.');
assert.equal(memory.snapshot().recentTurns.at(-1).content, 'First audible sentence.',
  'Interrupted memory must retain only validated speech that was actually audible');
memory.beginTurn('turn-2');
memory.append({ role: 'user', content: 'Can you hear me?' }, { turnToken: 'turn-2' });
assert.equal(memory.snapshot().pendingQuestion.text, 'Which option do you prefer?');
memory.applyGroundedDecision({
  stateUpdate: {
    currentTopic: 'new topic', knownEntities: [{ key: 'new', name: 'New option' }],
    collectedInformation: {}, contextDependent: false,
  }, pendingQuestionRelevant: true,
}, { turnToken: 'turn-2' });
assert.deepEqual(memory.snapshot().knownEntities.map((entity) => entity.key), ['new']);
assert.equal(memory.snapshot().pendingQuestion, null,
  'a validated explicit topic change must discard the obsolete pending question');
memory.close();

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /typeof liveMemory\.pendingQuestion === 'object'/u);
assert.match(orchestrator, /fieldSchemas\?\.\(\)/u);
assert.match(orchestrator, /pendingField\?\.question \?\? pendingQuestion\?\.text/u);
assert.match(orchestrator, /configuredSafeFailureResponse/u);
assert.doesNotMatch(orchestrator, /approvedHydratedEvidenceFallback|approvedDocumentFallback/u);
assert.match(orchestrator, /applyUnifiedGroundedTurn\(\{[\s\S]*?evidence:\s*authoritativeEvidence/u,
  'the unified validator must receive complete authoritative hydrated evidence');

console.log('Strong grounding and interruption preservation verification passed.');
