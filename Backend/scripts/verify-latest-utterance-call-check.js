import assert from 'node:assert/strict';
import {
  classifyFinalCallCheckUtterance,
  configuredCallCheckEvidence,
  findCallCheckPhraseCandidate,
  isCallCheckOnlyUtterance,
  resolveCallCheckConfiguration,
} from '../src/voice/interaction/call-check-config.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';
import { readFileSync } from 'node:fs';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';
import { validateGroundedClaims } from '../src/voice/interaction/grounded-claim-validator.js';

const configuration = resolveCallCheckConfiguration({
  callCheckPhrases: ['Hello', 'Are you there?'],
  callCheckResponse: 'I can hear you. Please continue.',
});

const exact = findCallCheckPhraseCandidate('Hello', configuration);
assert.equal(exact, 'Hello');
assert.equal(isCallCheckOnlyUtterance('Hello', exact, configuration), true);

const mixed = 'Hello, what services are available?';
const mixedCandidate = findCallCheckPhraseCandidate(mixed, configuration);
assert.equal(mixedCandidate, 'Hello');
assert.equal(isCallCheckOnlyUtterance(mixed, mixedCandidate, configuration), false);

const followUp = 'Are you there? I want to change the appointment time.';
const followUpCandidate = findCallCheckPhraseCandidate(followUp, configuration);
assert.equal(followUpCandidate, 'Are you there?');
assert.equal(isCallCheckOnlyUtterance(followUp, followUpCandidate, configuration), false);

assert.equal(findCallCheckPhraseCandidate('No configured phrase here', configuration), null);

assert.deepEqual(classifyFinalCallCheckUtterance('Hello', configuration), {
  matchedPhrase: null, shortcut: false,
});
assert.deepEqual(classifyFinalCallCheckUtterance('Hello', configuration, { finalized: true }), {
  matchedPhrase: 'Hello', shortcut: true,
});
assert.deepEqual(classifyFinalCallCheckUtterance(
  'Hello, please continue with my request', configuration, { finalized: true },
), { matchedPhrase: 'Hello', shortcut: false });

const semanticEvidence = configuredCallCheckEvidence(configuration, {
  tenantId: 'tenant-1', agentId: 'agent-1',
});
assert.equal(semanticEvidence.content, configuration.response);
assert.equal(evidenceBelongsToRuntime(semanticEvidence, {
  tenantId: 'tenant-1', agentId: 'agent-1', publicationRevisions: [],
  requireHydratedEvidence: true,
}), true);
assert.equal(evidenceBelongsToRuntime(semanticEvidence, {
  tenantId: 'tenant-2', agentId: 'agent-1', publicationRevisions: [],
  requireHydratedEvidence: true,
}), false);

const semanticEnvelope = buildGroundingEnvelope({
  found: true, tenantEvidence: { sources: [semanticEvidence], entities: [] },
}, { includePublishedMap: false });
const semanticDecision = validateGroundedLlmDecision(JSON.stringify({
  decision: 'answer', answer: configuration.response, evidenceIds: ['source_1'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
}), semanticEnvelope);
assert.equal(semanticDecision.valid, true);
assert.equal(validateGroundedClaims(semanticDecision.answer, [semanticEvidence]).valid, true);

const orchestratorSource = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestratorSource, /semanticCallCheckResolution/u);
assert.match(orchestratorSource, /withConfiguredCallCheckEvidence/u);

console.log(JSON.stringify({
  exactCallCheckUsesShortcut: true,
  mixedUtteranceContinuesToUnifiedDecision: true,
  completeUtterancePreserved: true,
}, null, 2));
