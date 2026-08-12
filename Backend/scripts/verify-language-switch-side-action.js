import assert from 'node:assert/strict';

const {
  findLanguageSwitchRequest,
  languageSwitchAcknowledgement,
} = await import('../src/voice/interaction/language-switch.js');
const { openLiveCallMemory } = await import('../src/voice/interaction/live-call-memory.js');

assert.equal(findLanguageSwitchRequest('தமிழ்ல பேசுங்க'), 'ta');
assert.equal(findLanguageSwitchRequest('Please continue in English'), 'en');
assert.equal(findLanguageSwitchRequest('I studied Tamil yesterday'), null);
assert.equal(languageSwitchAcknowledgement('ta'), 'சரிங்க, தமிழ்ல பேசுறேன்.');

const memory = openLiveCallMemory({
  tenantId: 'tenant-language', workspaceId: 'workspace-language', agentId: 'agent-language', callId: 'call-language',
}, {
  conversationLanguage: 'en', conversationContextMode: 'last_n_turns', conversationMemoryFields: [],
});
memory.setPosition({
  currentTopic: 'Published category',
  pendingQuestion: 'Which approved item do you need?',
  pendingQuestionText: 'Which approved item do you need?',
});
memory.suspendForDetour();
memory.setLanguage('ta');
memory.resumeFromDetour();
const state = memory.snapshot();
assert.equal(state.language, 'ta');
assert.equal(state.currentTopic, 'Published category');
assert.equal(state.pendingQuestionText, 'Which approved item do you need?');
memory.close();

console.log('Language switch and call-frame preservation verified.');
