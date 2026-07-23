function identity(config = {}) {
  return `${config.providerId ?? config.providerSlug ?? config.providerName}:${config.modelId ?? config.modelKey}`;
}

export class TenantProviderHealthMonitor {
  #tenants = new Map();

  record(tenantId, kind, config, outcome, details = {}) {
    if (!tenantId || !['stt', 'llm', 'tts'].includes(kind)) return;
    const providers = this.#tenants.get(tenantId) ?? new Map();
    const key = `${kind}:${identity(config)}`;
    const previous = providers.get(key) ?? { successes: 0, failures: 0 };
    providers.set(key, {
      kind,
      providerId: config.providerId ?? null,
      modelId: config.modelId ?? null,
      status: outcome === 'success' ? 'healthy' : 'degraded',
      successes: previous.successes + (outcome === 'success' ? 1 : 0),
      failures: previous.failures + (outcome === 'failure' ? 1 : 0),
      lastCode: details.code ?? null,
      lastLatencyMs: Number(details.latencyMs ?? 0),
      checkedAt: new Date().toISOString(),
    });
    this.#tenants.set(tenantId, providers);
  }

  snapshot(tenantId) {
    return [...(this.#tenants.get(tenantId)?.values() ?? [])].map((entry) => ({ ...entry }));
  }

  clearTenant(tenantId) { return this.#tenants.delete(tenantId); }
}

export const tenantProviderHealth = new TenantProviderHealthMonitor();
