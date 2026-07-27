import assert from 'node:assert/strict';
import {
  ambienceSourceObjectKey,
  validateAmbienceAudioFile,
} from '../src/ambience/ambience-audio-validation.js';
import { getAmbienceAudio, uploadAmbienceAudio } from '../src/ambience/ambience-storage.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const auth = { tenantId, workspaceId, userId, role: 'COMPANY_DEVELOPER' };
const storageConfiguration = {
  B2_BUCKET: 'private-test-bucket', B2_S3_ENDPOINT: 'https://example.invalid',
  B2_BUCKET_ID: 'private-bucket-id', B2_REGION: 'test-region',
  B2_KEY_ID: 'key-id', B2_APPLICATION_KEY: 'secret', AMBIENCE_AUDIO_MAX_BYTES: 20_971_520,
};

function wav(seconds = 5, sampleRate = 8000) {
  const dataBytes = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function mp3(frameCount = 192) {
  const frameLength = 417;
  const buffer = Buffer.alloc(frameLength * frameCount);
  for (let offset = 0; offset < buffer.length; offset += frameLength) {
    buffer[offset] = 0xff; buffer[offset + 1] = 0xfb; buffer[offset + 2] = 0x90; buffer[offset + 3] = 0x00;
  }
  return buffer;
}

const wavBuffer = wav();
const validWav = validateAmbienceAudioFile({ buffer: wavBuffer, size: wavBuffer.length, originalname: 'reception.wav', mimetype: 'audio/wav' });
assert.equal(validWav.type, 'wav');
assert.equal(validWav.durationMs, 5000);
assert.equal(validWav.sampleRate, 8000);
assert.match(validWav.checksumSha256, /^[0-9a-f]{64}$/);

const mp3Buffer = mp3();
const validMp3 = validateAmbienceAudioFile({ buffer: mp3Buffer, size: mp3Buffer.length, originalname: 'office.mp3', mimetype: 'audio/mpeg' });
assert.equal(validMp3.type, 'mp3');
assert.ok(validMp3.durationMs >= 5000);
assert.equal(validMp3.frameCount, 192);

assert.throws(
  () => validateAmbienceAudioFile({ buffer: wavBuffer, originalname: 'spoof.wav', mimetype: 'audio/mpeg' }),
  (error) => error.code === 'AMBIENCE_AUDIO_MIME_MISMATCH',
);
assert.throws(
  () => validateAmbienceAudioFile({ buffer: Buffer.from('not audio'), originalname: 'broken.mp3', mimetype: 'audio/mpeg' }),
  (error) => error.code === 'AMBIENCE_AUDIO_INVALID',
);
const shortWav = wav(1);
assert.throws(
  () => validateAmbienceAudioFile({ buffer: shortWav, originalname: 'short.wav', mimetype: 'audio/wav' }),
  (error) => error.code === 'AMBIENCE_AUDIO_TOO_SHORT',
);

const expectedKey = ambienceSourceObjectKey({
  tenantId, workspaceId, assetId, checksumSha256: validWav.checksumSha256, extension: 'wav',
});
assert.equal(expectedKey, `ambience/${tenantId}/${workspaceId}/${assetId}/source/${validWav.checksumSha256}.wav`);

const storedUploads = [];
const storage = {
  async putObject(input) {
    storedUploads.push(input);
    return { storageVersionId: 'private-version', etag: 'private-etag' };
  },
  async getObject(input) {
    assert.equal(input.key, expectedKey);
    assert.equal(input.versionId, 'private-version');
    return { body: wavBuffer, contentType: 'audio/wav' };
  },
  async deleteAllVersions() { return { deleted: true }; },
};

let transaction = 0;
const contextRunner = async (context, operation) => {
  assert.equal(context.tenantId, tenantId);
  transaction += 1;
  let query = 0;
  return operation({
    async query(sql, values) {
      query += 1;
      assert.deepEqual(values?.slice(0, 2), [tenantId, workspaceId]);
      if (transaction === 1 && query === 1) return { rowCount: 1, rows: [{ id: assetId, tenant_id: tenantId, workspace_id: workspaceId, status: 'active', checksum_sha256: null, object_key: null, normalized_object_key: null }] };
      if (transaction === 1 && query === 2) return { rowCount: 0, rows: [] };
      if (transaction === 1 && query === 3) return { rowCount: 1, rows: [] };
      if (transaction === 2 && query === 1) return { rowCount: 1, rows: [{ id: assetId, tenant_id: tenantId, workspace_id: workspaceId, status: 'active' }] };
      if (transaction === 2 && query === 2) return { rowCount: 1, rows: [{
        id: assetId, tenant_id: tenantId, workspace_id: workspaceId, name: 'Reception', status: 'active',
        storage_status: 'ready', original_file_name: 'reception.wav', object_key: expectedKey,
        mime_type: 'audio/wav', size_bytes: wavBuffer.length, duration_ms: 5000,
        audio_metadata: { type: 'wav' }, uploaded_at: new Date(), updated_at: new Date(),
      }] };
      if (transaction === 2 && query === 3) return { rowCount: 1, rows: [] };
      if (transaction === 3 && query === 1) return { rowCount: 1, rows: [{
        id: assetId, tenant_id: tenantId, workspace_id: workspaceId, status: 'active',
        storage_status: 'ready', object_key: expectedKey, storage_version_id: 'private-version',
        original_file_name: 'reception.wav', mime_type: 'audio/wav',
      }] };
      throw new Error(`Unexpected test query ${transaction}.${query}: ${sql}`);
    },
  });
};

const uploaded = await uploadAmbienceAudio(
  auth, assetId,
  { buffer: wavBuffer, size: wavBuffer.length, originalname: 'reception.wav', mimetype: 'audio/wav' },
  storage, contextRunner, storageConfiguration,
  async () => Buffer.alloc(40_000, 0xff),
);
assert.equal(storedUploads[0].key, expectedKey);
assert.match(storedUploads[1].key, /\/normalized\/mulaw-8000-mono\//);
assert.equal(storedUploads[0].metadata.tenant_id, tenantId);
assert.equal(storedUploads[0].metadata.workspace_id, workspaceId);
assert.equal(uploaded.storageStatus, 'ready');
assert.equal(Object.hasOwn(uploaded, 'objectKey'), false);
assert.equal(Object.hasOwn(uploaded, 'storageVersionId'), false);

const downloaded = await getAmbienceAudio(auth, assetId, storage, contextRunner, storageConfiguration);
assert.equal(downloaded.body, wavBuffer);
assert.equal(downloaded.mimeType, 'audio/wav');

console.log(JSON.stringify({ success: true, tasks: ['Private B2 ambience storage', 'Secure ambience upload validation'] }));
