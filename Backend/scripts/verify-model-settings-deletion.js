import assert from 'node:assert/strict';
import { normalizedModelSettings } from '../src/providers/model-settings.js';
import { updateModelSchema } from '../src/providers/provider.schemas.js';

const original = { CARTESIA_SPEED: 1, legacyVoice: 'old', voiceId: 'valid-voice', language: 'ta', streaming: true };
const request = updateModelSchema.parse({
  settings: { CARTESIA_SPEED: 0.9, voiceId: 'new-voice', language: 'ta' },
  removedSettingsKeys: ['legacyVoice'],
});
const saved = normalizedModelSettings(request, original);
assert.equal(saved.CARTESIA_SPEED, 0.9);
assert.equal(saved.voiceId, 'new-voice');
assert.equal(saved.streaming, true); // Other PATCH clients retain unspecified values.
assert.ok(!Object.hasOwn(saved, 'legacyVoice'));
assert.ok(!Object.hasOwn(normalizedModelSettings(request, saved), 'legacyVoice')); // Repeated save.
assert.equal(original.legacyVoice, 'old'); // Do not mutate a fetched object.
assert.deepEqual(normalizedModelSettings({ status: 'inactive' }, original), original);
assert.equal(normalizedModelSettings({ settings: { language: 'en' } }, original).voiceId, 'valid-voice');
assert.equal(normalizedModelSettings({ voiceId: 'stale', language: 'en', settings: { voiceId: '', language: '' } }, original).voiceId, '');
assert.equal(normalizedModelSettings({ voiceId: 'legacy-client' }, original).voiceId, 'legacy-client');
assert.deepEqual(normalizedModelSettings({ removedSettingsKeys: Object.keys(original), settings: {} }, original), {});
assert.equal(normalizedModelSettings({ removedSettingsKeys: ['legacyVoice'], settings: { renamedVoice: 'new' } }, original).renamedVoice, 'new');
assert.equal(updateModelSchema.safeParse({ removedSettingsKeys: [''] }).success, false);
assert.equal(updateModelSchema.safeParse({ removedSettingsKeys: 'legacyVoice' }).success, false);
console.log('Model settings deletion, rename, repeated save, partial updates and explicit clears passed.');
