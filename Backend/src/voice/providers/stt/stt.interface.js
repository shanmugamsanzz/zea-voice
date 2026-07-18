export function assertSttAdapter(adapter) {
  if (!adapter || typeof adapter.connect !== 'function'
    || typeof adapter.sendAudio !== 'function' || typeof adapter.close !== 'function') {
    throw new TypeError('STT adapter must implement connect, sendAudio, and close');
  }
  return adapter;
}
