const CHANNEL_TIMEOUT = Symbol('CHANNEL_TIMEOUT');
const CHANNEL_ABORTED = Symbol('CHANNEL_ABORTED');

function channelConfiguration(value, defaultDeadlineMs) {
  if (typeof value === 'function') return { retrieve: value, deadlineMs: defaultDeadlineMs };
  if (!value || typeof value.retrieve !== 'function') return null;
  const deadlineMs = Number(value.deadlineMs);
  return {
    retrieve: value.retrieve,
    deadlineMs: Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : defaultDeadlineMs,
  };
}

async function retrieveChannel(configuration, signal) {
  if (signal?.aborted) return CHANNEL_ABORTED;
  const work = Promise.resolve().then(configuration.retrieve);
  if (!configuration.deadlineMs && !signal) return work;
  let timer;
  let abortHandler;
  const deadline = new Promise((resolve) => {
    if (configuration.deadlineMs) timer = setTimeout(() => resolve(CHANNEL_TIMEOUT), configuration.deadlineMs);
    if (signal) {
      abortHandler = () => resolve(CHANNEL_ABORTED);
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  const result = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  return result;
}

export async function runParallelHybridRetrieval(channels = {}, options = {}) {
  const startedAt = performance.now();
  const configuredDefault = Number(options.defaultDeadlineMs);
  const defaultDeadlineMs = Number.isFinite(configuredDefault) && configuredDefault > 0
    ? configuredDefault : null;
  const entries = Object.entries(channels).map(([name, value]) => (
    [name, channelConfiguration(value, defaultDeadlineMs)]
  )).filter(([, configuration]) => configuration);
  // Every channel is created before awaiting any result. Slow optional
  // channels can have an independent deadline without delaying local indexed
  // evidence that has already completed.
  const settled = await Promise.allSettled(entries.map(([, configuration]) => (
    retrieveChannel(configuration, options.signal)
  )));
  const candidates = [];
  const failures = [];
  settled.forEach((result, index) => {
    const channel = entries[index][0];
    if (result.status === 'rejected') {
      failures.push({ channel, code: result.reason?.code ?? 'RETRIEVAL_CHANNEL_FAILED' });
      return;
    }
    if (result.value === CHANNEL_TIMEOUT) {
      failures.push({
        channel,
        code: 'RETRIEVAL_CHANNEL_DEADLINE',
        deadlineMs: entries[index][1].deadlineMs,
      });
      return;
    }
    if (result.value === CHANNEL_ABORTED) {
      failures.push({ channel, code: 'RETRIEVAL_CHANNEL_ABORTED' });
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
    channelsStarted: Object.freeze(entries.map(([name]) => name)),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
}
