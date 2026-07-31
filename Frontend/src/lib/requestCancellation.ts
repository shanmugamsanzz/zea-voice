export function isAbortError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    constructor?: { name?: unknown };
  };
  return candidate.name === 'AbortError'
    || candidate.name === 'CancelledError'
    || candidate.constructor?.name === 'CancelledError'
    || candidate.code === 'ERR_CANCELED'
    || candidate.code === 'ABORT_ERR';
}
