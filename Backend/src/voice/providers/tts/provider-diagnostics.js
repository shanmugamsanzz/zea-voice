// Backend-only diagnostics. Never log raw provider bodies, credentials or speech.
export function sanitizeTtsProviderMessage(value, sensitiveValues = []) {
  let message = String(value ?? '');
  for (const value of sensitiveValues) {
    if (value === undefined || value === null || value === '') continue;
    for (const literal of [String(value), JSON.stringify(String(value)).slice(1, -1)]) {
      message = message.split(literal).join('[REDACTED]');
    }
  }
  return message
    .replace(/(?:Bearer|Basic)\s+[^\s"',}]+/gi, '[REDACTED]')
    .replace(/\b(?:sk_|sk-|sk_car_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|password|secret|transcript|text)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|[^,\n}]+)/gi, '$1"[REDACTED]"')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL REDACTED]')
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[NUMBER REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 500);
}

export function cartesiaFailureDiagnostics(error, configuration, transcript) {
  const status = Number(error?.details?.status);
  return {
    stage: 'tts.cartesia_request_failed',
    errorCode: error?.code ?? 'TTS_PROVIDER_UNAVAILABLE',
    providerStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    providerMessage: sanitizeTtsProviderMessage(error?.details?.providerMessage ?? error?.message,
      [configuration.apiKey, configuration.accessToken, transcript]),
    modelKey: configuration.model,
    apiVersion: configuration.version,
    speed: Math.min(1.5, Math.max(0.6, configuration.speed)),
    language: configuration.language.split('-')[0],
  };
}
