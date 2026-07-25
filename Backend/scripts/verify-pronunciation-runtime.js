import assert from 'node:assert/strict';
import {
  compilePronunciationRules,
  createPronunciationTextProcessor,
} from '../src/voice/pronunciation/pronunciation-text-processor.js';
import { streamSelectedTtsToPlivo } from '../src/voice/providers/tts/tts-playback.service.js';
import { resolveSarvamTtsConfiguration } from '../src/voice/providers/tts/sarvam.adapter.js';
import { resolveCartesiaTtsConfiguration } from '../src/voice/providers/tts/cartesia.adapter.js';
import { resolveElevenLabsTtsConfiguration } from '../src/voice/providers/tts/elevenlabs.adapter.js';
import { resolveAzureTtsConfiguration } from '../src/voice/providers/tts/azure.adapter.js';
import { generatePronunciationPreview } from '../src/pronunciations/pronunciation-preview.service.js';

const groups = [{
  id: 'medical', name: 'Medical Terms', status: 'active', priority: 0,
  rules: [
    { id: 'phrase', sourceText: 'Shanmuga Hospital', spokenText: 'சண்முகா ஹாஸ்பிட்டல்', matchType: 'whole_word', priority: 10, enabled: true },
    { id: 'name', sourceText: 'Shanmuga', spokenText: 'சண்முகா', matchType: 'whole_word', priority: 20, enabled: true },
    { id: 'ecg', sourceText: 'ECG', spokenText: 'E C G', matchType: 'whole_word', priority: 30, enabled: true },
    { id: 'slash', sourceText: '/', spokenText: ' or ', matchType: 'exact', priority: 40, enabled: true },
    { id: 'disabled', sourceText: 'MRI', spokenText: 'M R I', matchType: 'whole_word', enabled: false },
  ],
}];

assert.equal(compilePronunciationRules(groups).length, 4);
const processor = createPronunciationTextProcessor({ groups });
const processed = processor.process('Shanmuga Hospital ECG / MRI');
assert.equal(processed.text, 'சண்முகா ஹாஸ்பிட்டல் E C G or MRI');
assert.equal(processed.replacementCount, 3);
assert.deepEqual(processed.appliedRuleIds, ['phrase', 'ecg', 'slash']);
assert.equal(processor.process('Shanmugam').changed, false);
assert.equal(processor.process('ecg').text, 'E C G');

const nonRecursive = createPronunciationTextProcessor({ groups: [{ rules: [
  { id: 'a', sourceText: 'A', spokenText: 'B', matchType: 'exact', priority: 1 },
  { id: 'b', sourceText: 'B', spokenText: 'C', matchType: 'exact', priority: 2 },
] }] });
assert.equal(nonRecursive.process('A').text, 'B');

let synthesizedText = '';
const adapter = {
  async connect() {},
  async *synthesizeStream(input) {
    synthesizedText = input.text;
    yield { type: 'completed' };
  },
  cancel() {},
  async close() {},
};
const audioEngine = {
  beginOutputGeneration() {},
  async enqueueSynthesized() { return true; },
  async flushSynthesized() {},
  cancelStaleAudio() {},
};
await streamSelectedTtsToPlivo({ providers: { tts: { providerName: 'Test' } }, pronunciation: { groups } }, 'Shanmuga ECG', {
  adapter, audioEngine, generationId: 'pronunciation-test',
});
assert.equal(synthesizedText, 'சண்முகா E C G');

let previewClosed = false;
const preview = await generatePronunciationPreview(
  {
    tenantId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
  },
  '44444444-4444-4444-8444-444444444444',
  { text: 'Shanmuga', groupIds: ['55555555-5555-4555-8555-555555555555'] },
  {
    enforceRateLimit: async () => {},
    loadProfile: async () => ({
      agent: { voiceId: 'voice-1' },
      providers: { tts: {
        providerName: 'Test TTS', modelName: 'Test Voice', modelKey: 'test-voice',
        modelCapabilities: { audio: { output: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } } },
      } },
      pronunciation: { groups: [] },
    }),
    contextRunner: async (auth, operation) => operation({
      async query(_text, values) {
        assert.equal(values[0], auth.tenantId);
        return { rows: [{
          id: values[1][0], name: 'Medical', language: 'ta-IN', status: 'active',
          rule_id: 'rule-1', source_text: 'Shanmuga', spoken_text: 'சண்முகா',
          match_type: 'whole_word', case_sensitive: false, rule_priority: 100, enabled: true,
        }] };
      },
    }),
    adapter: {
      async connect() {},
      async *synthesizeStream(input) {
        assert.equal(input.text, 'சண்முகா');
        yield { type: 'audio_chunk', audio: Buffer.alloc(640) };
        yield { type: 'completed' };
      },
      cancel() {},
      async close() { previewClosed = true; },
    },
  },
);
const previewAudio = Buffer.from(preview.audioBase64, 'base64');
assert.equal(previewAudio.subarray(0, 4).toString(), 'RIFF');
assert.equal(previewAudio.subarray(8, 12).toString(), 'WAVE');
assert.equal(preview.spokenText, 'சண்முகா');
assert.equal(preview.replacementCount, 1);
assert.equal(preview.durationMs, 20);
assert.equal(previewClosed, true);

const baseConfig = (providerName, parameters = {}, effectiveSettings = {}) => ({
  providerId: `${providerName}-provider`, providerName, providerSlug: providerName.toLowerCase(),
  modelId: `${providerName}-model`, modelKey: 'voice-model', baseUrl: `https://${providerName.toLowerCase()}.example.com`,
  modelCapabilities: { streaming: true, audio: { output: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } } },
  modelSettings: {},
  effectiveSettings: { voiceId: 'voice-1', ttsLanguage: 'ta-IN', ...effectiveSettings },
  parameters,
});

const sarvam = resolveSarvamTtsConfiguration(baseConfig('Sarvam', {
  SARVAM_API_KEY: 'secret', SARVAM_DICTIONARY_ID: 'sarvam-dictionary',
}));
assert.equal(sarvam.dictionaryId, 'sarvam-dictionary');

const cartesia = resolveCartesiaTtsConfiguration(baseConfig('Cartesia', {
  CARTESIA_API_KEY: 'secret', CARTESIA_PRONUNCIATION_DICTIONARY_ID: 'cartesia-dictionary',
}));
assert.equal(cartesia.dictionary.id, 'cartesia-dictionary');

const elevenlabs = resolveElevenLabsTtsConfiguration(baseConfig('ElevenLabs', {
  ELEVENLABS_API_KEY: 'secret',
  ELEVENLABS_PRONUNCIATION_DICTIONARY_ID: 'eleven-dictionary',
  ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID: 'version-2',
}));
assert.deepEqual(elevenlabs.dictionaries, [{
  id: 'eleven-dictionary', versionId: 'version-2', lexiconUri: null,
}]);

const azure = resolveAzureTtsConfiguration(baseConfig('Azure', {
  AZURE_SPEECH_KEY: 'secret', AZURE_LEXICON_URI: 'https://example.com/medical.pls',
}));
assert.deepEqual(azure.dictionaries, [{
  id: null, versionId: null, lexiconUri: 'https://example.com/medical.pls',
}]);

console.log(JSON.stringify({ success: true, task: 'Provider-independent pronunciation and native dictionaries' }));
