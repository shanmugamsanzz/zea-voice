import { AppError } from '../../middleware/errors.js';

export function normalizedNumericTokens(value) {
  const ascii = String(value ?? '').normalize('NFKC').replace(/\p{Nd}/gu, (digit) => {
    let start = digit.codePointAt(0);
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((digit.codePointAt(0) - start) % 10);
  });
  const tokens = ascii.match(/[+-]?\d+(?:[,\.]\d+)*/gu) ?? [];
  return new Set(tokens.map((token) => {
    // Normalize unambiguous grouped thousands; do not guess decimal-comma values.
    const grouped = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(token)
      || /^[+-]?\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d+)?$/u.test(token);
    const normalized = grouped ? token.replaceAll(',', '') : token;
    if (normalized.includes(',')) return normalized;
    const [integer, fraction = ''] = normalized.replace(/^\+/u, '').split('.');
    const whole = BigInt(integer).toString();
    const decimal = fraction.replace(/0+$/u, '');
    return decimal ? `${integer.startsWith('-') && whole === '0' ? '-0' : whole}.${decimal}` : whole;
  }));
}

export function shortenCompleteSpeech(value, maximum) {
  const speech = String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  if (speech.length <= maximum) return speech;
  let shortened = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(speech)) {
    const next = `${shortened} ${segment}`.trim();
    if (next.length > maximum) break;
    shortened = next;
  }
  if (!shortened) throw new AppError(502, 'No complete sentence fits the speech budget',
    'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED');
  return shortened;
}

export function assertExplicitAction(authorization, expectedIntent, context) {
  const current = String(context?.currentQuestion ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const quote = typeof authorization?.quote === 'string'
    ? authorization.quote.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
  if (authorization?.intent !== expectedIntent || authorization?.utteranceComplete !== true
    || authorization?.unambiguous !== true || !quote || !current.includes(quote)
    || context?.currentSpeech?.transcriptFinal !== true
    || context?.currentSpeech?.semanticCompletion === 'incomplete') {
    throw new AppError(502, 'The current turn does not authorize this action',
      'QDRANT_UNIVERSAL_LLM_ACTION_NOT_AUTHORIZED');
  }
}
