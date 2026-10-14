export class RunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'RunnerError'; this.code = code;
    this.details = Object.freeze(details);
  }
}
export function abortError() { return new RunnerError('CANCELLED', 'Runner operation cancelled.'); }
export function assertActive(signal) { if (signal?.aborted) throw abortError(); }
export async function bounded(operation, { timeoutMs = 10000, signal } = {}) {
  assertActive(signal);
  const controller = new AbortController();
  let timer; let onAbort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RunnerError('TIMEOUT', 'Runner operation timed out.')); }, timeoutMs);
    onAbort = () => { controller.abort(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort(); }
}
