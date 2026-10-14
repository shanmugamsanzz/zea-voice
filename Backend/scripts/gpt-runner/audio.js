import { RunnerError } from './errors.js';
export const RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_BYTES = RATE * FRAME_MS / 1000;
export function silence() { return Buffer.alloc(FRAME_BYTES, 255); }
export function linearToMuLaw(sample) {
  let value = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
  const sign = value < 0 ? 128 : 0; value = Math.min(32635, Math.abs(value)) + 132;
  let exponent = 7;
  for (let mask = 16384; exponent > 0 && !(value & mask); exponent -= 1, mask >>= 1) {}
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
}
export function muLawToLinear(value) {
  const decoded = (~value) & 255;
  const magnitude = (((decoded & 15) << 3) + 132) * (2 ** ((decoded >> 4) & 7)) - 132;
  return (decoded & 128 ? -magnitude : magnitude) / 32768;
}
export function toMuLaw(bytes, format) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) {
    throw new RunnerError('AUDIO_INVALID', 'Caller audio is empty or oversized.');
  }
  if (format?.channels !== 1 || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 48000) {
    throw new RunnerError('AUDIO_FORMAT', 'Caller audio requires a supported mono format.');
  }
  if (format.encoding === 'mulaw' && format.sampleRate === RATE) return Buffer.from(bytes);
  if (!['pcm_s16le', 'pcm_s16be'].includes(format.encoding) || bytes.length % 2) {
    throw new RunnerError('AUDIO_FORMAT', 'Caller audio must be raw 8 kHz mu-law or 16-bit PCM.');
  }
  const sourceLength = bytes.length / 2;
  const result = Buffer.alloc(Math.max(1, Math.floor(sourceLength * RATE / format.sampleRate)));
  const read = (index) => (format.encoding === 'pcm_s16le' ? bytes.readInt16LE(index * 2) : bytes.readInt16BE(index * 2)) / 32768;
  for (let index = 0; index < result.length; index += 1) {
    const position = index * format.sampleRate / RATE;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    result[index] = linearToMuLaw(read(left) + (read(right) - read(left)) * (position - left));
  }
  return result;
}
export function decodePayload(value, maximum = 65536) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new RunnerError('AUDIO_PAYLOAD', 'Target audio payload is invalid.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum) throw new RunnerError('AUDIO_PAYLOAD', 'Target audio payload exceeds bounds.');
  return bytes;
}
export function pcmWavFromMuLaw(bytes) {
  const header = Buffer.alloc(44); const pcm = Buffer.alloc(bytes.length * 2);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  for (let index = 0; index < bytes.length; index += 1) pcm.writeInt16LE(Math.round(muLawToLinear(bytes[index]) * 32767), index * 2);
  return Buffer.concat([header, pcm]);
}
