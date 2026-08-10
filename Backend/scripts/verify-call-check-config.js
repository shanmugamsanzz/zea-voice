import assert from 'node:assert/strict';
import {
  findCallCheckPhrase,
  normalizeCallCheckSettings,
  resolveCallCheckConfiguration,
} from '../src/voice/interaction/call-check-config.js';

const normalized = normalizeCallCheckSettings({
  callCheckPhrases: [' Hello ', 'hello', 'கேக்குதா', 'இருக்கீங்களா'],
  callCheckResponse: '  ஆமாங்க, கேக்குதுங்க. சொல்லுங்க.  ',
});
assert.deepEqual(normalized.callCheckPhrases, ['Hello', 'கேக்குதா', 'இருக்கீங்களா']);
assert.equal(normalized.callCheckResponse, 'ஆமாங்க, கேக்குதுங்க. சொல்லுங்க.');

const configuration = resolveCallCheckConfiguration(normalized);
assert.equal(findCallCheckPhrase('HELLO?', configuration), 'Hello');
assert.equal(findCallCheckPhrase('கேக்குதா?', configuration), 'கேக்குதா');
assert.equal(findCallCheckPhrase('hello, tell me the package', configuration), null,
  'A real question must not be swallowed by exact call-check routing');

assert.throws(() => normalizeCallCheckSettings({
  callCheckPhrases: ['hello'], callCheckResponse: '',
}), (error) => error.code === 'CALL_CHECK_CONFIGURATION_INVALID'
  && error.field === 'callCheckResponse');

assert.throws(() => normalizeCallCheckSettings({
  callCheckPhrases: ['x'.repeat(101)], callCheckResponse: 'Yes.',
}), (error) => error.code === 'CALL_CHECK_CONFIGURATION_INVALID'
  && error.field === 'callCheckPhrases');

console.log(JSON.stringify({ success: true, task: 'Per-agent call-check configuration' }));
