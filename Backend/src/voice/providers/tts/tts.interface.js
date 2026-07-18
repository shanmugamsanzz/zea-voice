export function assertTtsAdapter(adapter) {
  if (!adapter || typeof adapter.synthesize !== 'function'
    || typeof adapter.cancel !== 'function' || typeof adapter.close !== 'function') {
    throw new TypeError('TTS adapter must implement synthesize, cancel, and close');
  }
  return adapter;
}
