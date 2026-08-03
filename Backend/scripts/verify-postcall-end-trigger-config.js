import assert from 'node:assert/strict';
import {
  defaultCallEndTriggerPhrases,
  findCallEndTriggerPhrase,
  normalizePostCallEndTriggerSettings,
  resolveCallEndTriggerPhrases,
  resolvePostCallEndTriggerConfiguration,
} from '../src/voice/integrations/postcall-end-trigger-config.js';

assert.deepEqual(normalizePostCallEndTriggerSettings({}).callEndTriggerPhrases, []);

const normalized = normalizePostCallEndTriggerSettings({
  callEndTriggerPhrases: [' Bye ', 'bye', 'CALL   ME   LATER', 'போதும்', '', '  '],
});
assert.deepEqual(normalized.callEndTriggerPhrases, ['Bye', 'CALL ME LATER', 'போதும்']);

assert.throws(() => normalizePostCallEndTriggerSettings({ callEndTriggerPhrases: 'bye' }), {
  code: 'POSTCALL_END_TRIGGER_CONFIGURATION_INVALID',
});
assert.throws(() => normalizePostCallEndTriggerSettings({
  callEndTriggerPhrases: ['x'.repeat(161)],
}), { code: 'POSTCALL_END_TRIGGER_CONFIGURATION_INVALID' });
assert.deepEqual(resolvePostCallEndTriggerConfiguration({ callEndTriggerPhrases: 'bye' }).phrases, []);

assert.equal(resolveCallEndTriggerPhrases({}).source, 'default');
assert.ok(defaultCallEndTriggerPhrases.includes('போதும்'));
assert.equal(findCallEndTriggerPhrase('Okay, goodbye for now', {}).phrase, 'goodbye');
assert.equal(findCallEndTriggerPhrase('போதும், அழைப்பை முடிக்கலாம்', {}).phrase, 'போதும்');
assert.equal(findCallEndTriggerPhrase('This is a byeline update', {}), null);

const companyA = { callEndTriggerPhrases: ['stop the demo', 'பிறகு பேசலாம்'] };
const companyB = { callEndTriggerPhrases: ['end the survey'] };
assert.deepEqual(resolveCallEndTriggerPhrases(companyA), {
  source: 'agent', phrases: ['stop the demo', 'பிறகு பேசலாம்'],
});
assert.equal(findCallEndTriggerPhrase('Please stop the demo now', companyA).phrase, 'stop the demo');
assert.equal(findCallEndTriggerPhrase('Please stop the demo now', companyB), null);
assert.equal(findCallEndTriggerPhrase('Could you call me after 5 minutes?', companyA), null);

console.log('Post-call end-trigger configuration verification passed.');
