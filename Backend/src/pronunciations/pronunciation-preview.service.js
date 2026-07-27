import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { redis } from '../infrastructure/redis.js';
import { AppError } from '../middleware/errors.js';
import { loadAgentRuntimeProfile } from '../voice/providers/provider-config.js';
import { providerAdapterRegistry } from '../voice/providers/registry.js';
import { registerImplementedProviderAdapters } from '../voice/providers/defaults.js';
import { resolveModelAudioFormat } from '../voice/audio/audio-format.js';
import { decodeAudio, encodeAudio, normalizeMono } from '../voice/audio/codec.js';
import { createPronunciationTextProcessor } from '../voice/pronunciation/pronunciation-text-processor.js';

const MAX_PREVIEW_AUDIO_BYTES = 5 * 1024 * 1024;
const PREVIEW_RATE_LIMIT_PER_MINUTE = 10;

async function enforcePreviewRateLimit(auth, redisClient = redis) {
  const key = `${env.QUEUE_PREFIX}:pronunciation-preview:${auth.tenantId}:${auth.userId}`;
  const count = await redisClient.incr(key);
  if (count === 1) await redisClient.expire(key, 60);
  if (count > PREVIEW_RATE_LIMIT_PER_MINUTE) {
    throw new AppError(429, 'Pronunciation preview limit reached; try again in one minute', 'PRONUNCIATION_PREVIEW_RATE_LIMITED');
  }
}

function wavAudio(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function selectedGroups(auth, groupIds, contextRunner) {
  if (groupIds === undefined) return null;
  if (!groupIds.length) return { groups: [] };
  return contextRunner(auth, async (client) => {
    const result = await client.query(
      `SELECT pg.id, pg.name, pg.language, pg.status,
              pr.id AS rule_id, pr.source_text, pr.spoken_text, pr.match_type,
              pr.case_sensitive, pr.priority AS rule_priority, pr.enabled
         FROM pronunciation_groups pg
         LEFT JOIN pronunciation_rules pr
           ON pr.tenant_id=pg.tenant_id AND pr.group_id=pg.id
          AND pr.enabled=true AND pr.deleted_at IS NULL
        WHERE pg.tenant_id=$1 AND pg.id=ANY($2::uuid[])
          AND pg.status='active' AND pg.deleted_at IS NULL
        ORDER BY array_position($2::uuid[], pg.id), pr.priority, length(pr.source_text) DESC, pr.id`,
      [auth.tenantId, groupIds],
    );
    const found = new Map();
    for (const row of result.rows) {
      if (!found.has(row.id)) found.set(row.id, {
        id: row.id, name: row.name, language: row.language, status: row.status,
        priority: groupIds.indexOf(row.id) * 100, rules: [],
      });
      if (row.rule_id) found.get(row.id).rules.push({
        id: row.rule_id,
        sourceText: row.source_text,
        spokenText: row.spoken_text,
        matchType: row.match_type,
        caseSensitive: row.case_sensitive,
        priority: row.rule_priority,
        enabled: row.enabled,
      });
    }
    if (found.size !== groupIds.length) {
      throw new AppError(409, 'One or more pronunciation groups are unavailable for this company', 'PRONUNCIATION_PREVIEW_GROUP_UNAVAILABLE');
    }
    return { groups: groupIds.map((id) => found.get(id)) };
  });
}

export async function generatePronunciationPreview(auth, agentId, input, dependencies = {}) {
  await (dependencies.enforceRateLimit ?? enforcePreviewRateLimit)(auth, dependencies.redisClient);
  const loadProfile = dependencies.loadProfile ?? loadAgentRuntimeProfile;
  const profile = await loadProfile({
    agentId,
    tenantId: auth.tenantId,
    workspaceId: auth.workspaceId,
    callDirection: null,
  });
  const previewPronunciation = await selectedGroups(
    auth,
    input.groupIds,
    dependencies.contextRunner ?? withTenantContext,
  );
  const pronunciation = previewPronunciation ?? profile.pronunciation;
  const processed = createPronunciationTextProcessor(pronunciation).process(input.text);
  registerImplementedProviderAdapters(dependencies.registry ?? providerAdapterRegistry);
  const registry = dependencies.registry ?? providerAdapterRegistry;
  const adapter = dependencies.adapter ?? await registry.create(
    'tts',
    profile.providers.tts,
    { fetch: dependencies.fetchImpl, callId: `preview:${agentId}` },
  );
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  try {
    await adapter.connect();
    for await (const event of adapter.synthesizeStream({
      text: processed.text,
      generationId: `preview-${randomUUID()}`,
    })) {
      if (event.type === 'audio_chunk') {
        totalBytes += event.audio.length;
        if (totalBytes > MAX_PREVIEW_AUDIO_BYTES) {
          adapter.cancel('preview too large');
          throw new AppError(413, 'Pronunciation preview audio is too large', 'PRONUNCIATION_PREVIEW_TOO_LARGE');
        }
        chunks.push(Buffer.from(event.audio));
      } else if (event.type === 'completed') completed = true;
      else if (event.type === 'error') {
        throw new AppError(event.retryable ? 502 : 409, event.message, event.code);
      } else if (event.type === 'cancelled') {
        throw new AppError(409, 'Pronunciation preview was cancelled', 'PRONUNCIATION_PREVIEW_CANCELLED');
      }
    }
    if (!completed || !chunks.length) {
      throw new AppError(502, 'TTS provider returned no preview audio', 'PRONUNCIATION_PREVIEW_EMPTY');
    }
    const sourceFormat = resolveModelAudioFormat(profile.providers.tts, 'output');
    const samples = normalizeMono(decodeAudio(Buffer.concat(chunks), sourceFormat), sourceFormat.channels);
    const pcmFormat = { encoding: 'pcm_s16le', sampleRate: sourceFormat.sampleRate, channels: 1, bytesPerSample: 2 };
    const wav = wavAudio(encodeAudio(samples, pcmFormat), sourceFormat.sampleRate);
    return {
      mimeType: 'audio/wav',
      audioBase64: wav.toString('base64'),
      originalText: input.text,
      spokenText: processed.text,
      replacementCount: processed.replacementCount,
      appliedRuleIds: processed.appliedRuleIds,
      provider: profile.providers.tts.providerName,
      model: profile.providers.tts.modelName,
      voiceId: profile.agent.voiceId,
      durationMs: Math.round(samples.length / sourceFormat.sampleRate * 1000),
    };
  } finally {
    await adapter.close();
  }
}
