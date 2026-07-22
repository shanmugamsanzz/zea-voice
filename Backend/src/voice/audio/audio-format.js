import { AppError } from '../../middleware/errors.js';

const aliases = new Map([
  ['mulaw', 'mulaw'], ['mu-law', 'mulaw'], ['ulaw', 'mulaw'], ['g711-ulaw', 'mulaw'],
  ['audio/x-mulaw', 'mulaw'], ['pcm-mulaw', 'mulaw'],
  ['pcm-s16le', 'pcm_s16le'], ['s16le', 'pcm_s16le'], ['linear16le', 'pcm_s16le'],
  ['pcm-l16', 'pcm_s16be'], ['pcm-s16be', 'pcm_s16be'], ['s16be', 'pcm_s16be'],
  ['linear16', 'pcm_s16be'], ['audio/x-l16', 'pcm_s16be'],
]);

function key(value) {
  return String(value ?? '').trim().toLowerCase().replaceAll('_', '-');
}

function parseContentType(value) {
  const [encoding, ...parameters] = String(value).split(';').map((item) => item.trim());
  const entries = Object.fromEntries(parameters.map((item) => item.split('=').map((part) => part.trim())));
  return { encoding, sampleRate: entries.rate ? Number(entries.rate) : undefined };
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function settingBySuffix(settings, suffixes) {
  const normalizedSuffixes = suffixes.map((suffix) => suffix.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [settingKey, settingValue] of Object.entries(settings)) {
    const normalizedKey = settingKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedSuffixes.some((suffix) => normalizedKey === suffix || normalizedKey.endsWith(suffix))) {
      return settingValue;
    }
  }
  return undefined;
}

export function normalizeAudioEncoding(value) {
  const normalized = aliases.get(key(value));
  if (!normalized) throw new AppError(409, `Unsupported audio encoding: ${value}`, 'VOICE_AUDIO_ENCODING_UNSUPPORTED');
  return normalized;
}

export function normalizeAudioFormat(value, defaults = {}) {
  const selected = first(value);
  const parsed = typeof selected === 'string' ? parseContentType(selected) : (selected ?? {});
  const encodingValue = parsed.encoding ?? parsed.codec ?? parsed.contentType ?? parsed.content_type
    ?? defaults.encoding;
  const sampleRate = Number(parsed.sampleRate ?? parsed.sample_rate ?? parsed.rate ?? defaults.sampleRate);
  const channels = Number(parsed.channels ?? parsed.channelCount ?? parsed.channel_count ?? defaults.channels ?? 1);
  const frameDurationMs = Number(parsed.frameDurationMs ?? parsed.frame_duration_ms ?? defaults.frameDurationMs ?? 20);
  const encoding = normalizeAudioEncoding(encodingValue);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new AppError(409, 'Audio sample rate must be between 8000 and 192000 Hz', 'VOICE_AUDIO_SAMPLE_RATE_INVALID');
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new AppError(409, 'Audio channel count must be between 1 and 8', 'VOICE_AUDIO_CHANNELS_INVALID');
  }
  if (!Number.isFinite(frameDurationMs) || frameDurationMs < 5 || frameDurationMs > 200) {
    throw new AppError(409, 'Audio frame duration must be between 5 and 200 ms', 'VOICE_AUDIO_FRAME_DURATION_INVALID');
  }
  return Object.freeze({
    encoding, sampleRate, channels, frameDurationMs,
    bytesPerSample: encoding === 'mulaw' ? 1 : 2,
  });
}

function declaredFormat(providerConfig, direction) {
  const capabilities = providerConfig?.modelCapabilities ?? {};
  const settings = providerConfig?.effectiveSettings ?? providerConfig?.modelSettings ?? {};
  const audio = capabilities.audio ?? {};
  const settingAudio = settings.audio ?? {};
  const title = direction === 'input' ? 'Input' : 'Output';
  const declaredCodec = settingBySuffix(settings, [
    `${direction}AudioCodec`, `${direction}AudioEncoding`, 'audioCodec', 'audioEncoding', 'encoding',
  ]);
  const declaredSampleRate = settingBySuffix(settings, [
    `${direction}SampleRate`, 'audioSampleRate', 'sampleRate',
  ]);
  const declaredChannels = settingBySuffix(settings, [`${direction}Channels`, 'audioChannels', 'channels']);
  return first(
    audio[direction]
    ?? capabilities[`${direction}Audio`]
    ?? capabilities[`${direction}AudioFormat`]
    ?? capabilities[`${direction}_audio`]
    ?? capabilities[`${direction}_audio_format`]
    ?? settingAudio[direction]
    ?? settings[`${direction}AudioFormat`]
    ?? settings[`${direction}_audio_format`]
    ?? settings[`${direction}AudioCodec`]
    ?? settings[`${direction}_audio_codec`]
    ?? (declaredCodec || declaredSampleRate ? {
      encoding: declaredCodec,
      sampleRate: declaredSampleRate,
      channels: declaredChannels ?? 1,
    } : null),
  ) ?? { missingDirection: title };
}

export function resolveModelAudioFormat(providerConfig, direction) {
  if (!['input', 'output'].includes(direction)) throw new TypeError('Audio direction must be input or output');
  const declared = declaredFormat(providerConfig, direction);
  if (declared.missingDirection) {
    throw new AppError(
      409,
      `Selected model ${providerConfig?.modelKey ?? '[unknown]'} has no declared ${direction} audio format`,
      'VOICE_AUDIO_CAPABILITY_MISSING',
      {
        direction,
        providerId: providerConfig?.providerId ?? null,
        modelId: providerConfig?.modelId ?? null,
        modelKey: providerConfig?.modelKey ?? null,
      },
    );
  }
  return normalizeAudioFormat(declared);
}

export const PLIVO_MULAW_8K = normalizeAudioFormat({
  encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1, frameDurationMs: 20,
});

export function audioFrameBytes(format, durationMs = format.frameDurationMs) {
  const samples = Math.round(format.sampleRate * durationMs / 1000);
  return samples * format.channels * format.bytesPerSample;
}

export function audioDurationMs(byteLength, format) {
  return byteLength / (format.sampleRate * format.channels * format.bytesPerSample) * 1000;
}
