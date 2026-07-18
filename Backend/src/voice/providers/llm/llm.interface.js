export function assertLlmAdapter(adapter) {
  if (!adapter || typeof adapter.generate !== 'function') {
    throw new TypeError('LLM adapter must implement generate');
  }
  return adapter;
}
