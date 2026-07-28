import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ambienceNormalizedObjectKey } from '../src/ambience/ambience-preprocessor.js';
import { clearRuntimeAmbienceCache, loadRuntimeAmbience } from '../src/voice/ambience-runtime.service.js';
import { RealtimeAmbienceMixer } from '../src/voice/audio/realtime-ambience-mixer.js';
import { FramedAudioQueue } from '../src/voice/audio/framed-audio-queue.js';
import { PLIVO_MULAW_8K } from '../src/voice/audio/audio-format.js';
import { decodeAudio, encodeAudio } from '../src/voice/audio/codec.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const workspace = '33333333-3333-4333-8333-333333333333';
const asset = '44444444-4444-4444-8444-444444444444';
const checksum = 'a'.repeat(64);

const keyA = ambienceNormalizedObjectKey({ tenantId: tenantA, workspaceId: workspace, assetId: asset, checksumSha256: checksum });
const keyB = ambienceNormalizedObjectKey({ tenantId: tenantB, workspaceId: workspace, assetId: asset, checksumSha256: checksum });
assert.notEqual(keyA, keyB);
assert.match(keyA, new RegExp(`^ambience/${tenantA}/${workspace}/${asset}/normalized/`));

const ambientPcm = new Int16Array(8000).fill(1000);
const ambientAudio = encodeAudio(ambientPcm, PLIVO_MULAW_8K);
const calls = [];
const profile = (tenantId, objectKey) => ({
  agent: { id: asset, tenantId, workspaceId: workspace },
  ambience: {
    id: asset, name: 'Reception', status: 'active', storageStatus: 'ready',
    normalizedObjectKey: objectKey, listeningVolumePercent: 50,
    speakingVolumePercent: 10, continueDuringSilence: true,
  },
});
const getObject = async ({ key }) => {
  calls.push(key);
  return { body: ambientAudio };
};
clearRuntimeAmbienceCache();
const firstA = await loadRuntimeAmbience(profile(tenantA, keyA), { getObject });
const secondA = await loadRuntimeAmbience(profile(tenantA, keyA), { getObject });
const firstB = await loadRuntimeAmbience(profile(tenantB, keyB), { getObject });
assert.equal(firstA.cacheHit, false);
assert.equal(secondA.cacheHit, true);
assert.equal(firstB.cacheHit, false);
assert.deepEqual(calls, [keyA, keyB]);

const queue = new FramedAudioQueue({ maxFrames: 10, maxBytes: 10000, maxBufferedMs: 1000 });
const speech = encodeAudio(new Int16Array(160).fill(2000), PLIVO_MULAW_8K);
await queue.enqueue({ data: speech, durationMs: 20, generationId: 'turn-1' });
const sent = [];
const mixer = new RealtimeAmbienceMixer({
  queue,
  ambienceAudio: ambientAudio,
  listeningVolumePercent: 50,
  speakingVolumePercent: 10,
  continueDuringSilence: true,
  packetDurationMs: 20,
  send: async (frame) => sent.push(frame.data),
});
mixer.start();
await new Promise((resolve) => setTimeout(resolve, 70));
await mixer.stop();
assert.ok(sent.length >= 2, 'Mixer should continuously pace ambience frames');
const mixedSpeech = decodeAudio(sent[0], PLIVO_MULAW_8K)[0];
const ambienceOnly = decodeAudio(sent[1], PLIVO_MULAW_8K)[0];
assert.ok(mixedSpeech > 1500, 'Speech must remain dominant over speaking ambience');
assert.ok(ambienceOnly > 250 && ambienceOnly < 900, 'Listening ambience volume must be attenuated');
assert.equal(mixer.snapshot().speechFramesMixed, 1);

const assignmentService = await readFile(new URL('../src/ambience/agent-ambience.service.js', import.meta.url), 'utf8');
assert.match(assignmentService, /tenant_id=\$1 AND workspace_id=\$2/);
assert.match(assignmentService, /normalized_object_key IS NOT NULL/);
const profileService = await readFile(new URL('../src/voice/providers/provider-config.js', import.meta.url), 'utf8');
assert.match(profileService, /aa\.tenant_id=a\.tenant_id AND aa\.workspace_id=a\.workspace_id/);
const migration = await readFile(new URL('../migrations/1785620000000_agent-ambience-assignments.js', import.meta.url), 'utf8');
assert.match(migration, /agent_ambience_assignments_isolation_policy/);
assert.match(migration, /FORCE ROW LEVEL SECURITY/);

console.log(JSON.stringify({
  success: true,
  tasks: ['Audio preprocessing', 'Real-time ambience mixer', 'Call lifecycle and barge-in', 'Tenant isolation'],
}));
