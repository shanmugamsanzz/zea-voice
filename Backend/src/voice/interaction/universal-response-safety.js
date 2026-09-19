import { AppError } from '../../middleware/errors.js';

export function shortenCompleteSpeech(value, maximum) {
  const speech = String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  const limit = Math.max(1, Number(maximum) || 1);
  if (Array.from(speech).length <= limit) return speech;
  let shortened = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(speech)) {
    const next = `${shortened} ${segment}`.trim();
    if (Array.from(next).length > limit) break;
    shortened = next;
  }
  if (shortened) return shortened;

  // A valid generated answer must not be replaced merely because its first
  // sentence is longer than the configured TTS budget. Keep the model's own
  // speech and trim it directly to the limit, preferring a word boundary.
  const clipped = Array.from(speech).slice(0, limit).join('').trimEnd();
  const boundary = clipped.search(/\s+\S*$/u);
  return (boundary > Math.floor(limit * 0.6) ? clipped.slice(0, boundary) : clipped).trim();
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
