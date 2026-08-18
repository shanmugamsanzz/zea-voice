import assert from 'node:assert/strict';
import {
  findCallCheckPhraseCandidate,
  isCallCheckOnlyUtterance,
  resolveCallCheckConfiguration,
} from '../src/voice/interaction/call-check-config.js';

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

console.log(JSON.stringify({
  exactCallCheckUsesShortcut: true,
  mixedUtteranceContinuesToUnifiedDecision: true,
  completeUtterancePreserved: true,
}, null, 2));
