import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

const acceptedMimeTypes = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
]);
const mp3Bitrates = Object.freeze({
  mpeg1Layer3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2Layer3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
});
const mp3SampleRates = Object.freeze({ 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] });

function invalid(message, code = 'AMBIENCE_AUDIO_INVALID') {
  throw new AppError(400, message, code);
}

function safeOriginalName(value) {
  const name = path.basename(String(value ?? '').replaceAll('\0', '')).trim();
  if (!name || name.length > 255) invalid('Audio file name must contain between 1 and 255 characters', 'AMBIENCE_FILENAME_INVALID');
  return name;
}

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    invalid('The uploaded WAV header is invalid or incomplete');
  }
  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize > buffer.length || declaredSize < 44) invalid('The uploaded WAV file is truncated');
  let offset = 12;
  let format;
  let dataBytes = 0;
  while (offset + 8 <= declaredSize) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > declaredSize) invalid('The uploaded WAV file contains a truncated audio chunk');
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') dataBytes += size;
    offset = end + (size % 2);
  }
  if (!format || !dataBytes) invalid('The WAV file must contain valid format and audio-data chunks');
  if (![1, 3].includes(format.audioFormat)) invalid('Only uncompressed PCM or IEEE-float WAV audio is supported');
  if (![1, 2].includes(format.channels)) invalid('WAV audio must be mono or stereo');
  if (format.sampleRate < 8000 || format.sampleRate > 96000) invalid('WAV sample rate must be between 8 kHz and 96 kHz');
  if (![8, 16, 24, 32].includes(format.bitsPerSample) || format.byteRate <= 0) invalid('WAV audio format is not supported');
  const durationMs = Math.round((dataBytes / format.byteRate) * 1000);
  return { type: 'wav', extension: 'wav', mimeType: 'audio/wav', durationMs, ...format };
}

function synchsafeInteger(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);
}

function parseMp3(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = synchsafeInteger(buffer, 6);
    offset = 10 + tagSize + ((buffer[5] & 0x10) ? 10 : 0);
    if (offset >= buffer.length) invalid('The MP3 contains an invalid ID3 tag');
  }
  let frames = 0;
  let durationSeconds = 0;
  let sampleRate = null;
  let channels = null;
  let searchedBytes = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 3) === 'TAG' && buffer.length - offset >= 128) break;
    const header = buffer.readUInt32BE(offset);
    if ((header >>> 21) !== 0x7ff) {
      if (frames > 0 || searchedBytes >= 4096) break;
      offset += 1;
      searchedBytes += 1;
      continue;
    }
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 0x1;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      if (frames > 0) break;
      offset += 1;
      searchedBytes += 1;
      continue;
    }
    const rates = mp3SampleRates[versionBits];
    const currentSampleRate = rates?.[sampleRateIndex];
    const bitrate = (versionBits === 3 ? mp3Bitrates.mpeg1Layer3 : mp3Bitrates.mpeg2Layer3)[bitrateIndex] * 1000;
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLength = Math.floor(((versionBits === 3 ? 144 : 72) * bitrate) / currentSampleRate) + padding;
    if (!currentSampleRate || frameLength < 24 || offset + frameLength > buffer.length) break;
    sampleRate ??= currentSampleRate;
    channels ??= ((header >>> 6) & 0x3) === 3 ? 1 : 2;
    durationSeconds += samplesPerFrame / currentSampleRate;
    frames += 1;
    offset += frameLength;
  }
  if (frames < 3 || durationSeconds <= 0) invalid('The uploaded MP3 is corrupted or does not contain enough valid audio frames');
  return {
    type: 'mp3', extension: 'mp3', mimeType: 'audio/mpeg',
    durationMs: Math.round(durationSeconds * 1000), sampleRate, channels, frameCount: frames,
  };
}

export function validateAmbienceAudioFile(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    invalid('Choose one WAV or MP3 ambience audio file', 'AMBIENCE_AUDIO_REQUIRED');
  }
  if (file.buffer.length > env.AMBIENCE_AUDIO_MAX_BYTES) {
    invalid(`Ambience audio must not exceed ${env.AMBIENCE_AUDIO_MAX_BYTES} bytes`, 'AMBIENCE_AUDIO_TOO_LARGE');
  }
  if (!acceptedMimeTypes.has(String(file.mimetype ?? '').toLowerCase())) {
    invalid('Only WAV and MP3 audio files are accepted', 'AMBIENCE_AUDIO_TYPE_UNSUPPORTED');
  }
  const originalFileName = safeOriginalName(file.originalname);
  const detected = file.buffer.length >= 12 && file.buffer.toString('ascii', 0, 4) === 'RIFF'
    ? parseWav(file.buffer)
    : parseMp3(file.buffer);
  const claimedType = String(file.mimetype).toLowerCase();
  const claimedFamily = claimedType.includes('mpeg') || claimedType.includes('mp3') ? 'mp3' : 'wav';
  if (claimedFamily !== detected.type) {
    invalid('Declared audio type does not match the file signature', 'AMBIENCE_AUDIO_MIME_MISMATCH');
  }
  const extension = path.extname(originalFileName).toLowerCase();
  if (extension !== `.${detected.extension}`) {
    invalid(`File extension does not match the detected ${detected.type.toUpperCase()} audio format`, 'AMBIENCE_AUDIO_EXTENSION_MISMATCH');
  }
  if (detected.durationMs < env.AMBIENCE_AUDIO_MIN_DURATION_SECONDS * 1000) {
    invalid(`Ambience audio must be at least ${env.AMBIENCE_AUDIO_MIN_DURATION_SECONDS} seconds long`, 'AMBIENCE_AUDIO_TOO_SHORT');
  }
  if (detected.durationMs > env.AMBIENCE_AUDIO_MAX_DURATION_SECONDS * 1000) {
    invalid(`Ambience audio must not exceed ${env.AMBIENCE_AUDIO_MAX_DURATION_SECONDS} seconds`, 'AMBIENCE_AUDIO_TOO_LONG');
  }
  return Object.freeze({
    ...detected,
    originalFileName,
    sizeBytes: file.buffer.length,
    checksumSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  });
}

export function ambienceSourceObjectKey({ tenantId, workspaceId, assetId, checksumSha256, extension }) {
  for (const [name, value] of Object.entries({ tenantId, workspaceId, assetId })) {
    if (!/^[0-9a-f-]{36}$/i.test(String(value))) throw new TypeError(`${name} must be a UUID`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(checksumSha256))) throw new TypeError('checksumSha256 must be a SHA-256 hash');
  if (!['wav', 'mp3'].includes(extension)) throw new TypeError('Ambience extension must be wav or mp3');
  return `ambience/${tenantId}/${workspaceId}/${assetId}/source/${checksumSha256}.${extension}`;
}
