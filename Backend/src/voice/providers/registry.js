import { AppError } from '../../middleware/errors.js';
import { assertSttAdapter } from './stt/stt.interface.js';
import { assertLlmAdapter } from './llm/llm.interface.js';
import { assertTtsAdapter } from './tts/tts.interface.js';

const kinds = new Set(['stt', 'llm', 'tts']);
const validators = { stt: assertSttAdapter, llm: assertLlmAdapter, tts: assertTtsAdapter };

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
    const registration = { kind, key: normalizeProviderKey(key), factory };
    for (const candidate of keys) this.#adapters[kind].set(candidate, registration);
    return registration;
  }

  has(kind, providerName) {
    if (!kinds.has(kind)) return false;
    return this.#adapters[kind].has(normalizeProviderKey(providerName));
  }

  resolve(kind, providerConfig) {
    if (!kinds.has(kind)) throw new TypeError(`Unsupported provider adapter kind: ${kind}`);
    const providerName = providerConfig?.providerName;
    const configuredAdapter = providerConfig?.modelSettings?.runtimeAdapter
      ?? providerConfig?.modelCapabilities?.runtimeAdapter
      ?? providerName;
    const registration = this.#adapters[kind].get(normalizeProviderKey(configuredAdapter));
    if (!registration) {
      throw new AppError(
        409,
        `No ${kind.toUpperCase()} runtime adapter is registered for provider ${providerName}`,
        'VOICE_PROVIDER_ADAPTER_NOT_FOUND',
        { kind, providerName, configuredAdapter },
      );
    }
    return registration;
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

export function createRuntimeAdapters(runtimeProfile, runtimeContext = {}, registry = providerAdapterRegistry) {
  return Promise.all([
    registry.create('stt', runtimeProfile.providers.stt, runtimeContext),
    registry.create('llm', runtimeProfile.providers.llm, runtimeContext),
    registry.create('tts', runtimeProfile.providers.tts, runtimeContext),
  ]).then(([stt, llm, tts]) => ({ stt, llm, tts }));
}
