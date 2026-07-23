import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs, resolveModelAudioFormat } from '../../audio/audio-format.js';
import { normalizeTtsEvent, normalizeTtsUsage } from './tts.interface.js';

const normalizedKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parameter(parameters, ...names) {
  const wanted = new Set(names.map(normalizedKey));
  return Object.entries(parameters ?? {}).find(([key]) => wanted.has(normalizedKey(key)))?.[1] ?? null;
}

export function setting(settings, ...names) {
  const wanted = names.map((name) => normalizedKey(name));
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const normalized = normalizedKey(key);
    if (wanted.some((name) => normalized === name || normalized.endsWith(name))) return value;
  }
  return null;
}

function finite(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function normalizeLanguage(value, fallback = null) {
  if (!value) return fallback;
  return String(value).trim();
}

export function firstPronunciationDictionary(rules, provider) {
  const list = Array.isArray(rules) ? rules : [];
  const matching = list.find((rule) => {
    if (typeof rule === 'string') return true;
    return !rule?.provider || normalizedKey(rule.provider) === normalizedKey(provider);
  });
  if (typeof matching === 'string') return { id: matching };
  if (!matching || typeof matching !== 'object') return null;
  return {
    id: matching.dictionaryId ?? matching.pronunciationDictionaryId ?? matching.id ?? null,
    versionId: matching.versionId ?? matching.version_id ?? null,
    lexiconUri: matching.lexiconUri ?? matching.uri ?? null,
  };
}

export function resolveCommonTtsConfiguration(providerConfig) {
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  const parameters = providerConfig.parameters ?? {};
  const outputFormat = resolveModelAudioFormat(providerConfig, 'output');
  const voiceId = setting(settings, 'voiceId', 'voice', 'speaker')
    ?? setting(parameters, 'ttsVoiceId', 'voiceId', 'speaker');
  if (!voiceId) throw new AppError(409, 'Selected TTS model has no voice ID', 'TTS_VOICE_ID_MISSING');
  const language = normalizeLanguage(
    setting(settings, 'ttsLanguage', 'languageCode', 'language')
      ?? setting(parameters, 'ttsLanguage', 'languageCode', 'language'),
  );
  if (!language) throw new AppError(409, 'Selected TTS model has no language', 'TTS_LANGUAGE_MISSING');
  const configured = (...names) => setting(settings, ...names) ?? setting(parameters, ...names);
  const pronunciationRules = configured('pronunciationGroups', 'pronunciationRules', 'pronunciationDictionaryId');
  return Object.freeze({
    model: providerConfig.modelKey,
    voiceId: String(voiceId),
    language,
    speed: finite(configured('ttsSpeed', 'pace', 'speed'), 1, 0.25, 4),
    style: configured('ttsEmotion', 'emotion', 'styleName') ?? null,
    styleDegree: finite(configured('ttsStyleDegree', 'styleDegree', 'ttsStyle'), 1, 0, 2),
    stability: finite(configured('ttsStability', 'stability'), 0.5, 0, 1),
    similarity: finite(configured('ttsSimilarityBoost', 'similarityBoost'), 0.75, 0, 1),
    volume: finite(configured('ttsVolume', 'volume', 'loudness'), 1, 0, 2),
    pronunciationRules: Array.isArray(pronunciationRules)
      ? pronunciationRules : (pronunciationRules ? [pronunciationRules] : []),
    outputFormat,
  });
}

export function createTtsRequestState(providerConfig, runtimeContext = {}) {
  let active = null;
  let closed = false;
  return {
    begin(generationId = randomUUID()) {
      if (closed) throw new AppError(409, 'TTS adapter is closed', 'TTS_ADAPTER_CLOSED');
      active?.controller.abort('superseded');
      const controller = new AbortController();
      const request = { controller, generationId, cancelled: false, timedOut: false, startedAt: Date.now() };
      const timer = setTimeout(() => {
        request.timedOut = true;
        controller.abort('timeout');
      }, runtimeContext.timeoutMs ?? env.TTS_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      request.finish = () => {
        clearTimeout(timer);
        if (active === request) active = null;
      };
      active = request;
      return request;
    },
    cancel(reason = 'barge-in') {
      if (!active) return false;
      active.cancelled = true;
      active.cancelReason = reason;
      active.controller.abort(reason);
      return true;
    },
    close() {
      closed = true;
      if (active) {
        active.cancelled = true;
        active.cancelReason = 'closed';
        active.controller.abort('closed');
      }
    },
  };
}

export function synthesisInput(input) {
  const value = typeof input === 'string' ? { text: input } : input ?? {};
  const text = String(value.text ?? '').trim();
  if (!text) throw new TypeError('TTS synthesis text is required');
  return { text, generationId: value.generationId ?? randomUUID() };
}

export async function requireAudioResponse(response, providerConfig) {
  if (response.ok && response.body?.getReader) return response;
  const details = await response.text?.().catch(() => '') ?? '';
  throw new AppError(response.status === 429 ? 503 : 502, 'Selected TTS provider request failed', 'TTS_PROVIDER_REQUEST_FAILED', {
    providerId: providerConfig.providerId,
    modelId: providerConfig.modelId,
    status: response.status,
    providerMessage: details.slice(0, 500),
  });
}

export async function* parseSse(body) {
  if (!body?.getReader) throw new AppError(502, 'TTS provider returned no streaming body', 'TTS_STREAM_MISSING');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  } finally { reader.releaseLock(); }
}

export async function* binaryAudioEvents(response, request, providerConfig, configuration, characters) {
  const reader = response.body.getReader();
  let sequence = 0;
  let bytes = 0;
  let firstAudioLatencyMs = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const audio = Buffer.from(value);
      if (!audio.length) continue;
      if (firstAudioLatencyMs === null) firstAudioLatencyMs = Date.now() - request.startedAt;
      bytes += audio.length;
      yield normalizeTtsEvent({ type: 'audio_chunk', audio, sequence: sequence++ }, {
        ...providerConfig, generationId: request.generationId,
      });
    }
    const usage = normalizeTtsUsage({
      characters, audioBytes: bytes, firstAudioLatencyMs,
      audioOutputMs: audioDurationMs(bytes, configuration.outputFormat),
    });
    yield normalizeTtsEvent({ type: 'usage', usage }, { ...providerConfig, generationId: request.generationId });
    yield normalizeTtsEvent({ type: 'completed', usage }, { ...providerConfig, generationId: request.generationId });
  } finally {
    reader.releaseLock();
  }
}

export function ttsFailure(error, request, providerConfig) {
  if (request?.cancelled) return null;
  if (request?.timedOut) return new AppError(504, 'Selected TTS provider timed out', 'TTS_PROVIDER_TIMEOUT', {
    providerId: providerConfig.providerId, modelId: providerConfig.modelId,
  });
  if (error instanceof AppError) return error;
  return new AppError(502, 'Selected TTS provider is unavailable', 'TTS_PROVIDER_UNAVAILABLE', {
    providerId: providerConfig.providerId, modelId: providerConfig.modelId,
  });
}

export function ttsErrorEvent(error, providerConfig, generationId) {
  return normalizeTtsEvent({
    type: 'error', code: error.code, message: error.message, retryable: error.statusCode >= 500,
  }, { ...providerConfig, generationId });
}
