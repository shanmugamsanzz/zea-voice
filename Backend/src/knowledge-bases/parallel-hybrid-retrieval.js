export async function runParallelHybridRetrieval(channels = {}) {
  const startedAt = performance.now();
  const entries = Object.entries(channels).filter(([, retrieve]) => typeof retrieve === 'function');
  const settled = await Promise.allSettled(entries.map(([, retrieve]) => Promise.resolve().then(retrieve)));
  const candidates = [];
  const failures = [];
  settled.forEach((result, index) => {
    const channel = entries[index][0];
    if (result.status === 'rejected') {
      failures.push({ channel, code: result.reason?.code ?? 'RETRIEVAL_CHANNEL_FAILED' });
      return;
    }
    const values = Array.isArray(result.value) ? result.value : [result.value];
    for (const value of values.filter(Boolean)) {
      candidates.push(Object.freeze({
        ...value,
        retrieval: Object.freeze({ ...(value.retrieval ?? {}), channel, parallel: true }),
      }));
    }
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze(failures),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
}
