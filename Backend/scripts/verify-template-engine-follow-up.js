import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  candidateTemplateEngineSpeech,
  repairTemplateEngineFollowUp,
  validateAndComposeTemplateEngineSpeech,
} from '../src/voice/interaction/template-engine-follow-up.js';
import {
  runTemplateEngineProductionTurn,
  templateEngineEvidenceSuppressesFollowUp,
} from '../src/voice/interaction/template-engine-production-runtime.js';

const guidance = Object.freeze({
  recordId: 'guidance-1',
  purpose: 'Continue after explaining the selected option.',
  nextQuestion: 'Would you like the next step or another option?',
});
const decision = Object.freeze({
  decision: 'RESPONSE', response: 'The selected option is available.',
  clarification: null, search: null, tool: null,
  nextQuestion: {
    question: 'Would you like another option?', reason: 'Relevant continuation',
  },
  stateUpdate: null,
});

assert.equal(candidateTemplateEngineSpeech(decision),
  'The selected option is available. Would you like another option?');
const accepted = validateAndComposeTemplateEngineSpeech({
  decision, conversationGuidance: guidance, claimsValidated: true,
});
assert.equal(accepted.followUp.accepted, true);
assert.equal(accepted.speech,
  'The selected option is available. Would you like another option?');
assert.equal(accepted.decision.nextQuestion.question, 'Would you like another option?');

const multiple = validateAndComposeTemplateEngineSpeech({
  decision: {
    ...decision,
    nextQuestion: { question: 'Would you like the next step? Or another option?', reason: null },
  },
  conversationGuidance: guidance,
});
assert.equal(multiple.followUp.reason, 'not_exactly_one_question');
assert.equal(multiple.decision.nextQuestion, null);
assert.equal(multiple.speech, decision.response);
const repairedMultiple = await repairTemplateEngineFollowUp({
  decision: {
    ...decision,
    nextQuestion: { question: 'Would you like the next step? Or another option?', reason: null },
  },
  mainPrompt: 'Use concise natural language.',
  latestUtterance: 'Explain the selected option.',
  conversationGuidance: guidance,
  initialValidation: multiple.followUp,
  invokeStructuredLlm: async () => ({
    nextQuestion: { question: 'Would you like another option?', reason: 'Relevant continuation' },
  }),
});
assert.equal(repairedMultiple.attempted, true);
assert.equal(repairedMultiple.reason, null);
assert.equal(repairedMultiple.decision.nextQuestion.question, 'Would you like another option?');

const repeated = validateAndComposeTemplateEngineSpeech({
  decision,
  conversationGuidance: guidance,
  recentCompleteTurns: [{
    role: 'assistant',
    content: 'The details are ready. Would you like another option?',
  }],
});
assert.equal(repeated.followUp.reason, 'repeated_question');
assert.equal(repeated.speech, decision.response);

const unrelated = validateAndComposeTemplateEngineSpeech({
  decision: {
    ...decision,
    nextQuestion: { question: 'Which unrelated destination should I use?', reason: null },
  },
  conversationGuidance: guidance,
});
assert.equal(unrelated.followUp.reason, 'unrelated_question');

const unsupported = validateAndComposeTemplateEngineSpeech({
  decision, conversationGuidance: guidance, claimsValidated: false,
});
assert.equal(unsupported.followUp.reason, 'unsupported_question_claim');

for (const terminal of [
  { name: 'emergency', suppressFollowUp: true, conversationGuidance: guidance },
  { name: 'cancellation', suppressFollowUp: false, conversationGuidance: {
    recordId: 'cancel-guidance', purpose: 'End the active operation.', nextQuestion: null,
  } },
  { name: 'completion', suppressFollowUp: false, conversationGuidance: {
    recordId: 'terminal-guidance', purpose: 'Close the conversation.', nextQuestion: null,
  } },
]) {
  const result = validateAndComposeTemplateEngineSpeech({
    decision,
    conversationGuidance: terminal.conversationGuidance,
    suppressFollowUp: terminal.suppressFollowUp,
  });
  assert.equal(result.followUp.accepted, false, `${terminal.name} must suppress follow-up`);
  assert.equal(result.decision.nextQuestion, null);
  assert.equal(result.speech, decision.response);
}
assert.equal(templateEngineEvidenceSuppressesFollowUp([{
  recordType: 'WORKFLOW_RULE',
  authoritativeData: { actionType: 'respond', actionConfig: { responseMode: 'exact' } },
}]), true);
assert.equal(templateEngineEvidenceSuppressesFollowUp([{
  recordType: 'CATALOG_ITEM', authoritativeData: {},
}]), false);

const noMatch = validateAndComposeTemplateEngineSpeech({
  decision: {
    decision: 'NO_MATCH', response: 'That information is not available.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  },
  conversationGuidance: guidance,
});
assert.equal(noMatch.speech, 'That information is not available.');
assert.equal(noMatch.decision.nextQuestion, null);

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const scope = {
  tenantId, agentId,
  publications: [{ knowledgeBaseId, publicationRevision: 2 }],
};
const evidence = Object.freeze([Object.freeze({
  verified: true, callerFacing: true,
  evidenceId: 'evidence-1', recordId: 'record-1', recordType: 'CATALOG_ITEM',
  tenantId, agentId, knowledgeBaseId, publicationRevision: 2,
  content: 'The selected option is available.', canonicalName: 'Selected Option',
  authoritativeData: { name: 'Selected Option' },
})]);
const decisions = [{
  decision: 'SEARCH', response: '', clarification: null,
  search: {
    query: 'selected option details', requestedFact: 'details',
    contextualReference: 'selected option', preferredRecordIds: [],
  },
  tool: null, nextQuestion: null, stateUpdate: null,
}, {
  decision: 'RESPONSE', response: 'The selected option is available.',
  clarification: null, evidenceIds: ['E1'],
  nextQuestion: null,
  stateUpdate: null,
}, {
  nextQuestion: { question: 'Would you like another option?', reason: 'Relevant continuation' },
}];
let guidanceDiagnostics = null;
let followUpDiagnostics = null;
const production = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-follow-up', usageDirection: 'inbound',
  language: 'en', mainPrompt: 'Search facts and continue using published guidance.',
  latestUtterance: 'Explain the selected option.', conversationHistory: [], state: {},
  assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => decisions.shift(),
  loadPublishedContext: async () => ({
    scope, artifacts: {}, publishedWorkflows: [],
    publishedConversationGuidance: [{
      ...guidance, recordType: 'CONVERSATION_NODE', tenantId, agentId,
      knowledgeBaseId, publicationRevision: 2, published: true,
      situation: 'The caller requests details about a selected option.',
      examples: ['Explain the selected option'], context: null,
      catalogReferences: [], intentClass: null, nodeKey: 'details',
    }],
  }),
  retrieveEvidence: async () => ({
    scope, evidence,
    diagnostics: { retrievalCount: 1, hydrationCount: 1, verifiedEvidenceCount: 1 },
  }),
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onConversationGuidanceSelected: (details) => { guidanceDiagnostics = details; },
  onFollowUpDiagnostics: (details) => { followUpDiagnostics = details; },
});
assert.equal(production.speech,
  'The selected option is available. Would you like another option?');
assert.equal(production.followUpValidation.accepted, true);
assert.equal(production.decision.nextQuestion.question, 'Would you like another option?');
assert.equal(production.followUpValidation.reason, null);
assert.equal(guidanceDiagnostics.selected, true);
assert.equal(guidanceDiagnostics.hasNextQuestion, true);
assert.equal(followUpDiagnostics.repairAttempted, true);
assert.equal(followUpDiagnostics.accepted, true);
assert.equal(decisions.length, 0);

const source = readFileSync(
  new URL('../src/voice/interaction/template-engine-follow-up.js', import.meta.url), 'utf8',
).toLocaleLowerCase();
for (const forbidden of ['silver', 'gold', 'platinum', 'hospital', 'appointment']) {
  assert.equal(source.includes(forbidden), false);
}

console.log('Template-engine follow-up validation and composition verification passed');
