const muLawBias = 0x84;
const muLawClip = 32635;

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export function decodeMuLawSample(value) {
  const encoded = (~value) & 0xff;
  const sign = encoded & 0x80;
  const exponent = (encoded >> 4) & 0x07;
  const mantissa = encoded & 0x0f;
  const magnitude = (((mantissa << 3) + muLawBias) << exponent) - muLawBias;
  return sign ? -magnitude : magnitude;
}

export function encodeMuLawSample(value) {
  let sample = clamp16(value);
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample = Math.min(sample, muLawClip) + muLawBias;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(sample & mask); mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function decodeAudio(buffer, format) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Audio input must be a Buffer');
  if (buffer.length % format.bytesPerSample !== 0) throw new RangeError('Audio buffer is not sample-aligned');
  const samples = new Int16Array(buffer.length / format.bytesPerSample);
  if (format.encoding === 'mulaw') {
    for (let index = 0; index < buffer.length; index += 1) samples[index] = decodeMuLawSample(buffer[index]);
  } else if (format.encoding === 'pcm_s16le') {
    for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(index * 2);
  } else if (format.encoding === 'pcm_s16be') {
    for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16BE(index * 2);
  } else {
    throw new TypeError(`Unsupported decoded audio format: ${format.encoding}`);
  }
  return samples;
}

export function encodeAudio(samples, format) {
  if (!(samples instanceof Int16Array)) throw new TypeError('PCM samples must be an Int16Array');
  const buffer = Buffer.allocUnsafe(samples.length * format.bytesPerSample);
  if (format.encoding === 'mulaw') {
    for (let index = 0; index < samples.length; index += 1) buffer[index] = encodeMuLawSample(samples[index]);
  } else if (format.encoding === 'pcm_s16le') {
    for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  } else if (format.encoding === 'pcm_s16be') {
    for (let index = 0; index < samples.length; index += 1) buffer.writeInt16BE(samples[index], index * 2);
  } else {
    throw new TypeError(`Unsupported encoded audio format: ${format.encoding}`);
  }
  return buffer;
}

export function normalizeMono(samples, channels) {
  if (!(samples instanceof Int16Array)) throw new TypeError('PCM samples must be an Int16Array');
  if (!Number.isInteger(channels) || channels < 1) throw new TypeError('Channel count must be a positive integer');
  if (samples.length % channels !== 0) throw new RangeError('PCM samples are not channel-aligned');
  if (channels === 1) return samples;
  const mono = new Int16Array(samples.length / channels);
  for (let frame = 0; frame < mono.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += samples[frame * channels + channel];
    mono[frame] = clamp16(sum / channels);
  }
  return mono;
}
