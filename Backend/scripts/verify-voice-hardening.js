import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { VoiceCallOwnership } = await import('../src/voice/call-ownership.service.js');
const { WelcomeAudioCache } = await import('../src/voice/welcome-audio-cache.service.js');
const { TenantProviderHealthMonitor } = await import('../src/voice/provider-health.service.js');
const { LlmCircuitBreaker } = await import('../src/voice/providers/llm/streaming-runtime.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { loggerRedactPaths } = await import('../src/config/logger.js');
const { validateAgentRuntimeModels } = await import('../src/agents/agent.service.js');

class MemoryRedis {
  status = 'ready';
  owners = new Map();
  calls = new Map();
  values = new Map();

  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, value); return 'OK'; }

  async eval(script, _keyCount, tenantKey, callKey, ...args) {
    if (script.includes('voice-call-acquire')) {
      const [tenantId, ownerId, _now, _ttl, limit, providerCallId] = args;
      const current = this.owners.get(callKey);
      if (current) return current.startsWith(`${tenantId}|`) ? 2 : -1;
      const calls = this.calls.get(tenantKey) ?? new Set();
      if (calls.size >= Number(limit)) return 0;
      calls.add(providerCallId);
      this.calls.set(tenantKey, calls);
      this.owners.set(callKey, `${tenantId}|reserved|${ownerId}`);
      return 1;
    }
    if (script.includes('voice-call-claim')) {
      const [tenantId, ownerId] = args;
      const current = this.owners.get(callKey);
      if (!current?.startsWith(`${tenantId}|`) || (!current.includes('|reserved|') && current !== `${tenantId}|active|${ownerId}`)) return 0;
      this.owners.set(callKey, `${tenantId}|active|${ownerId}`);
      return 1;
    }
    if (script.includes('voice-call-heartbeat')) {
      const [tenantId, ownerId] = args;
      return this.owners.get(callKey) === `${tenantId}|active|${ownerId}` ? 1 : 0;
    }
    if (script.includes('voice-call-release-validated')) return 1;
    if (script.includes('voice-call-release')) {
      const [tenantId, ownerId, providerCallId] = args;
      const current = this.owners.get(callKey);
      if (current && current !== `${tenantId}|reserved|${ownerId}` && current !== `${tenantId}|active|${ownerId}`) return 0;
      this.owners.delete(callKey);
      this.calls.get(tenantKey)?.delete(providerCallId);
      return 1;
    }
    throw new Error('Unknown Redis script');
  }
}

const redis = new MemoryRedis();
const owners = new VoiceCallOwnership({ redis, instanceId: 'runtime-a', ttlSeconds: 60, now: () => 1000 });
const admitted = [];
const rejected = [];
await Promise.all(Array.from({ length: 10 }, async (_unused, companyIndex) => {
  const tenantId = `tenant-${companyIndex}`;
  for (let callIndex = 0; callIndex < 10; callIndex += 1) {
    const providerCallId = `call-${companyIndex}-${callIndex}`;
    try {
      admitted.push(await owners.acquire({ tenantId, providerCallId, limit: 4 }));
    } catch (error) {
      rejected.push({ tenantId, providerCallId, code: error.code });
    }
  }
}));
assert.equal(admitted.length, 40);
assert.equal(rejected.length, 60);
assert.ok(rejected.every((entry) => entry.code === 'VOICE_COMPANY_CONCURRENCY_LIMIT'));
assert.equal((await owners.acquire({ tenantId: 'tenant-0', providerCallId: 'call-0-0', limit: 4 })).idempotent, true);
await owners.claimMedia({ tenantId: 'tenant-0', providerCallId: 'call-0-0' });
assert.equal(await owners.heartbeat({ tenantId: 'tenant-0', providerCallId: 'call-0-0' }), true);
assert.equal(await owners.release({ tenantId: 'tenant-0', providerCallId: 'call-0-0' }), true);
assert.equal((await owners.acquire({ tenantId: 'tenant-0', providerCallId: 'replacement', limit: 4 })).acquired, true);

const profile = {
  agent: { tenantId: 'tenant-a', voiceId: 'voice-a', language: 'en-US' },
  providers: { tts: { providerId: 'tts-a', modelId: 'model-a', effectiveSettings: { speed: 1 } } },
};
const cache = new WelcomeAudioCache({ redis, timeoutMs: 50, ttlSeconds: 60, maxBytes: 1024 });
const welcome = Buffer.alloc(320, 7);
assert.equal(await cache.set(profile, 'Welcome', welcome), true);
const cacheStarted = performance.now();
assert.deepEqual(await cache.get(profile, 'Welcome'), welcome);
const cachedWelcomeLookupMs = performance.now() - cacheStarted;
assert.ok(cachedWelcomeLookupMs < 300, `Cached welcome lookup took ${cachedWelcomeLookupMs} ms`);
assert.equal(await cache.get({ ...profile, agent: { ...profile.agent, tenantId: 'tenant-b' } }, 'Welcome'), null);

const health = new TenantProviderHealthMonitor();
health.record('tenant-a', 'llm', { providerId: 'p1', modelId: 'm1' }, 'success', { latencyMs: 20 });
health.record('tenant-b', 'llm', { providerId: 'p2', modelId: 'm2' }, 'failure', { code: 'TIMEOUT' });
assert.deepEqual(health.snapshot('tenant-a').map((entry) => entry.providerId), ['p1']);
assert.deepEqual(health.snapshot('tenant-b').map((entry) => entry.providerId), ['p2']);

const healthyBreaker = new LlmCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000, now: () => 1000 });
const failedCallBreaker = new LlmCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000, now: () => 1000 });
failedCallBreaker.failure();
assert.throws(() => failedCallBreaker.assertAvailable(), (error) => error.code === 'LLM_CIRCUIT_OPEN');
assert.doesNotThrow(() => healthyBreaker.assertAvailable());

const registry = new ProviderAdapterRegistry();
for (const kind of ['stt', 'llm', 'tts']) {
  registry.register(kind, `${kind}-supported`, () => ({ close() {} }));
}
assert.throws(() => registry.preflight({ providers: {
  stt: { providerName: 'stt-supported', modelKey: 'stt-model' },
  llm: { providerName: 'not-implemented', modelKey: 'unknown-model' },
  tts: { providerName: 'tts-supported', modelKey: 'tts-model' },
} }), (error) => error.code === 'VOICE_RUNTIME_ADAPTERS_UNAVAILABLE'
  && error.details.incompatible[0].message.includes('no compatible runtime adapter'));
assert.ok(loggerRedactPaths.includes('req.headers.authorization'));
assert.ok(loggerRedactPaths.includes('*.secretConfiguration'));
assert.ok(loggerRedactPaths.includes('*.auth_token_encrypted'));

const configuredRegistry = new ProviderAdapterRegistry();
for (const kind of ['stt', 'llm', 'tts']) configuredRegistry.register(kind, `${kind}-ok`, () => ({ close() {} }));
let modelQuery = 0;
await assert.rejects(validateAgentRuntimeModels({
  async query() {
    modelQuery += 1;
    const kind = ['stt', 'llm', 'tts'][modelQuery - 1];
    return { rowCount: 1, rows: [{
      model_id: `${kind}-model`, model_key: `${kind}-model`, model_settings: {}, model_capabilities: {},
      provider_id: `${kind}-provider`, provider_name: kind === 'llm' ? 'unsupported' : `${kind}-ok`,
      provider_slug: kind === 'llm' ? 'unsupported' : `${kind}-ok`,
    }] };
  },
}, { sttModelId: 's', llmModelId: 'l', ttsModelId: 't' }, configuredRegistry),
(error) => error.code === 'AGENT_MODEL_RUNTIME_INCOMPATIBLE' && error.details.field === 'llmModelId');

const inheritedRegistry = new ProviderAdapterRegistry();
inheritedRegistry.register('stt', 'stt-inherited', () => ({ close() {} }), {
  supports: ({ providerConfig }) => providerConfig.effectiveSettings.inputSampleRate === '16000'
    && providerConfig.effectiveSettings.inputAudioCodec === 'pcm_s16le',
});
inheritedRegistry.register('llm', 'llm-inherited', () => ({ close() {} }));
inheritedRegistry.register('tts', 'tts-inherited', () => ({ close() {} }));
let inheritedQuery = 0;
await validateAgentRuntimeModels({
  async query() {
    const kind = ['stt', 'llm', 'tts'][inheritedQuery++];
    return { rowCount: 1, rows: [{
      model_id: `${kind}-model`, model_key: `${kind}-model`, model_settings: {}, model_capabilities: {},
      provider_settings: kind === 'stt' ? { inputSampleRate: '16000', inputAudioCodec: 'pcm_s16le' } : {},
      provider_id: `${kind}-provider`, provider_name: `${kind}-inherited`, provider_slug: `${kind}-inherited`,
    }] };
  },
}, { sttModelId: 's', llmModelId: 'l', ttsModelId: 't' }, inheritedRegistry);

console.log(JSON.stringify({
  success: true,
  task: 'Voice Task 10 - hardening and scale simulation',
  companies: 10,
  simulatedCalls: 100,
  admittedCalls: admitted.length,
  rejectedCalls: rejected.length,
  cachedWelcomeLookupMs: Math.round(cachedWelcomeLookupMs * 100) / 100,
  providerFailureIsolation: true,
  compatibilityRejection: true,
}));
