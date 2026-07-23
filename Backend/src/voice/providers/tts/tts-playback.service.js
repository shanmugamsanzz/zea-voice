import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/errors.js';
import { providerAdapterRegistry } from '../registry.js';

export async function streamSelectedTtsToPlivo(runtimeProfile, text, options = {}) {
  const providerConfig = runtimeProfile?.providers?.tts;
  if (!providerConfig) throw new AppError(409, 'Agent has no selected TTS provider', 'TTS_PROVIDER_MISSING');
  if (!options.audioEngine) throw new TypeError('TTS playback requires the provider-independent audio engine');
  const adapter = options.adapter ?? await (options.registry ?? providerAdapterRegistry)
    .create('tts', providerConfig, options.runtimeContext ?? {});
  const ownsAdapter = !options.adapter;
  const generationId = options.generationId ?? randomUUID();
  const audioEngine = options.audioEngine;
  const usageTracker = options.usageTracker;
  let completed = false;
  audioEngine.beginOutputGeneration(generationId);
  try {
    await adapter.connect();
    for await (const event of adapter.synthesizeStream({ text, generationId })) {
      if (event.type === 'audio_chunk') {
        const accepted = await audioEngine.enqueueSynthesized(event.audio, generationId);
        if (!accepted) {
          adapter.cancel('stale generation');
          return { generationId, cancelled: true, usage: null };
        }
      } else if (event.type === 'usage') {
        usageTracker?.record?.('tts', event.usage);
      } else if (event.type === 'error') {
        throw new AppError(event.retryable ? 502 : 409, event.message, event.code);
      } else if (event.type === 'cancelled') {
        return { generationId, cancelled: true, usage: null };
      } else if (event.type === 'completed') {
        completed = true;
      }
    }
    if (!completed) throw new AppError(502, 'TTS provider ended without a completion event', 'TTS_STREAM_INCOMPLETE');
    await audioEngine.flushSynthesized(generationId);
    return { generationId, cancelled: false };
  } catch (error) {
    audioEngine.cancelStaleAudio(error.code ?? 'tts failure');
    throw error;
  } finally {
    if (ownsAdapter) await adapter.close();
  }
}

export function cancelTtsPlayback(adapter, audioEngine, reason = 'barge-in') {
  const providerCancelled = adapter?.cancel?.(reason) ?? false;
  const audio = audioEngine.cancelStaleAudio(reason);
  return { providerCancelled, ...audio };
}
