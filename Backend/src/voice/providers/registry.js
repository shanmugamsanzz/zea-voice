import { AppError } from '../../middleware/errors.js';
import { assertSttAdapter } from './stt/stt.interface.js';
import { assertLlmAdapter } from './llm/llm.interface.js';
import { assertTtsAdapter } from './tts/tts.interface.js';

const kinds = new Set(['stt', 'llm', 'tts']);
const validators = { stt: assertSttAdapter, llm: assertLlmAdapter, tts: assertTtsAdapter };

function runtimeMetadata(providerConfig = {}) {
  const capabilities = providerConfig.modelCapabilities ?? {};
  const settings = providerConfig.modelSettings ?? {};
  const runtime = capabilities.runtime && typeof capabilities.runtime === 'object'
    ? capabilities.runtime : {};
  return {
    adapter: runtime.adapter ?? capabilities.runtimeAdapter ?? capabilities.adapter
      ?? settings.runtimeAdapter ?? providerConfig.providerSlug ?? providerConfig.providerName,
    streaming: runtime.streaming ?? capabilities.streaming ?? settings.streaming,
    protocol: runtime.protocol ?? capabilities.protocol ?? settings.protocol ?? null,
    capabilities,
  };
}

function modelIdentity(providerConfig = {}) {
  return {
    providerId: providerConfig.providerId ?? null,
    providerName: providerConfig.providerName ?? null,
    providerSlug: providerConfig.providerSlug ?? null,
    modelId: providerConfig.modelId ?? null,
    modelKey: providerConfig.modelKey ?? null,
  };
}

export function normalizeProviderKey(value) {
  const key = String(value ?? '').trim().toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!key) throw new TypeError('Provider adapter key is required');
  return key;
}

export class ProviderAdapterRegistry {
  #adapters = { stt: new Map(), llm: new Map(), tts: new Map() };

  register(kind, key, factory, options = {}) {
    if (!kinds.has(kind)) throw new TypeError(`Unsupported provider adapter kind: ${kind}`);
    if (typeof factory !== 'function') throw new TypeError('Provider adapter factory must be a function');
    const keys = [key, ...(options.aliases ?? [])].map(normalizeProviderKey);
    for (const candidate of keys) {
      if (this.#adapters[kind].has(candidate)) {
        throw new Error(`${kind.toUpperCase()} provider adapter is already registered: ${candidate}`);
      }
    }
    const registration = {
      kind,
      key: normalizeProviderKey(key),
      factory,
      supports: options.supports ?? null,
      metadata: options.metadata ?? {},
    };
    for (const candidate of keys) this.#adapters[kind].set(candidate, registration);
    return registration;
  }

  has(kind, providerName) {
    if (!kinds.has(kind)) return false;
    return this.#adapters[kind].has(normalizeProviderKey(providerName));
  }

  resolve(kind, providerConfig) {
    if (!kinds.has(kind)) throw new TypeError(`Unsupported provider adapter kind: ${kind}`);
    const identity = modelIdentity(providerConfig);
    const runtime = runtimeMetadata(providerConfig);
    const configuredAdapter = runtime.adapter;
    const registration = this.#adapters[kind].get(normalizeProviderKey(configuredAdapter));
    if (!registration) {
      throw new AppError(
        409,
        `Selected ${kind.toUpperCase()} model ${identity.modelKey ?? '[unknown]'} has no compatible runtime adapter`,
        'VOICE_PROVIDER_ADAPTER_NOT_FOUND',
        { kind, ...identity, configuredAdapter },
      );
    }
    if (runtime.streaming === false) {
      throw new AppError(
        409,
        `Selected ${kind.toUpperCase()} model ${identity.modelKey ?? '[unknown]'} does not support streaming`,
        'VOICE_PROVIDER_STREAMING_UNSUPPORTED',
        { kind, ...identity, configuredAdapter: registration.key },
      );
    }
    if (registration.supports && registration.supports({ providerConfig, runtime }) !== true) {
      throw new AppError(
        409,
        `Selected ${kind.toUpperCase()} model ${identity.modelKey ?? '[unknown]'} is incompatible with adapter ${registration.key}`,
        'VOICE_PROVIDER_MODEL_INCOMPATIBLE',
        { kind, ...identity, configuredAdapter: registration.key, protocol: runtime.protocol },
      );
    }
    return registration;
  }

  preflight(runtimeProfile) {
    const incompatible = [];
    for (const kind of kinds) {
      try {
        this.resolve(kind, runtimeProfile?.providers?.[kind]);
      } catch (error) {
        incompatible.push({
          kind,
          code: error.code ?? 'VOICE_PROVIDER_ADAPTER_INVALID',
          message: error.message,
          details: error.details ?? modelIdentity(runtimeProfile?.providers?.[kind]),
        });
      }
    }
    if (incompatible.length) {
      throw new AppError(
        409,
        `Voice agent cannot start because ${incompatible.length} selected model${incompatible.length === 1 ? '' : 's'} lack a compatible runtime adapter`,
        'VOICE_RUNTIME_ADAPTERS_UNAVAILABLE',
        { incompatible },
      );
    }
    return {
      compatible: true,
      adapters: Object.fromEntries([...kinds].map((kind) => [kind, this.resolve(kind, runtimeProfile.providers[kind]).key])),
    };
  }

  async create(kind, providerConfig, runtimeContext = {}) {
    const registration = this.resolve(kind, providerConfig);
    const adapter = await registration.factory({ providerConfig, runtimeContext });
    return validators[kind](adapter);
  }

  unregister(kind, key) {
    if (!kinds.has(kind)) throw new TypeError(`Unsupported provider adapter kind: ${kind}`);
    const normalized = normalizeProviderKey(key);
    const registration = this.#adapters[kind].get(normalized);
    if (!registration) return false;
    for (const [candidate, value] of this.#adapters[kind]) {
      if (value === registration) this.#adapters[kind].delete(candidate);
    }
    return true;
  }
}

export const providerAdapterRegistry = new ProviderAdapterRegistry();

export const registerSttAdapter = (key, factory, options) => providerAdapterRegistry.register('stt', key, factory, options);
export const registerLlmAdapter = (key, factory, options) => providerAdapterRegistry.register('llm', key, factory, options);
export const registerTtsAdapter = (key, factory, options) => providerAdapterRegistry.register('tts', key, factory, options);

export const assertRuntimeAdapterCompatibility = (runtimeProfile, registry = providerAdapterRegistry) => (
  registry.preflight(runtimeProfile)
);

export async function createRuntimeAdapters(runtimeProfile, runtimeContext = {}, registry = providerAdapterRegistry) {
  registry.preflight(runtimeProfile);
  const adapters = {};
  try {
    for (const kind of kinds) {
      adapters[kind] = await registry.create(kind, runtimeProfile.providers[kind], runtimeContext);
    }
    return adapters;
  } catch (error) {
    await Promise.allSettled(Object.values(adapters).map((adapter) => adapter.close()));
    throw error;
  }
}
