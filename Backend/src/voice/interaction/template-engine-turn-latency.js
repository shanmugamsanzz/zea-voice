export const TEMPLATE_ENGINE_TURN_LATENCY_VERSION = 2;

function cleanText(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

const acknowledgementVariants = Object.freeze({
  en: Object.freeze({
    comparison: Object.freeze(['Let me compare those for you.', 'I am checking the differences now.']),
    price: Object.freeze(['Let me check the price for you.', 'I am checking the price now.']),
    options: Object.freeze(['Let me check the available options.', 'I am looking through the options now.']),
    details: Object.freeze(['Let me check those details for you.', 'I am checking the relevant details now.']),
    general: Object.freeze(['One moment while I check that.', 'Let me verify that for you.']),
  }),
  ta: Object.freeze({
    comparison: Object.freeze(['இரண்டையும் ஒப்பிட்டு சொல்றேங்க.', 'வித்தியாசங்களைப் பார்த்து சொல்றேங்க.']),
    price: Object.freeze(['சரியான விலை விவரத்தைப் பார்த்து சொல்றேங்க.', 'விலையைச் சரிபார்த்து சொல்றேங்க.']),
    options: Object.freeze(['கிடைக்கும் விருப்பங்களைப் பார்த்து சொல்றேங்க.', 'விருப்பங்களைச் சரிபார்த்து சொல்றேங்க.']),
    details: Object.freeze(['அதற்கான விவரங்களைப் பார்த்து சொல்றேங்க.', 'சம்பந்தப்பட்ட விவரங்களைச் சரிபார்த்து சொல்றேங்க.']),
    general: Object.freeze(['ஒரு நிமிஷம், சரிபார்த்து சொல்றேங்க.', 'பார்த்து சரியாக சொல்றேங்க.']),
  }),
});

function normalizedLanguage(value) {
  const code = cleanText(value, 50).toLocaleLowerCase().split(/[-_]/u)[0];
  return acknowledgementVariants[code] ? code : null;
}

function requestKind(value) {
  const text = cleanText(value, 2_000).toLocaleLowerCase();
  if (!text) return 'general';
  if (/(?:\b(?:compare|comparison|difference|different|versus|vs)\b|வித்தியாச|ஒப்பிட)/iu.test(text)) {
    return 'comparison';
  }
  if (/(?:\b(?:price|cost|rate|fee|charge|amount|how much)\b|விலை|எவ்வள|கட்டணம்)/iu.test(text)) {
    return 'price';
  }
  if (/(?:\b(?:which|what|available|options|list)\b|என்னென்ன|எந்தெந்த|கிடைக்க|விருப்ப)/iu.test(text)) {
    return 'options';
  }
  if (/(?:\b(?:detail|details|explain|tell|about|include|includes)\b|பற்றி|விவர|சொல்லு|என்ன வரும்)/iu.test(text)) {
    return 'details';
  }
  return 'general';
}

function stableVariantIndex(value, size, seed = 0) {
  let hash = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 0;
  for (const character of cleanText(value, 2_000)) {
    hash = ((hash * 31) + character.codePointAt(0)) | 0;
  }
  return Math.abs(hash) % Math.max(1, size);
}

export function resolveDynamicLatencyAcknowledgement({
  configuredText = '',
  latestUtterance = '',
  language = 'en',
  variantSeed = 0,
} = {}) {
  const configured = cleanText(configuredText);
  if (!configured) return Object.freeze({ text: '', requestKind: 'general', language: null });
  const resolvedLanguage = normalizedLanguage(language);
  const resolvedRequestKind = requestKind(latestUtterance);
  if (!resolvedLanguage) {
    return Object.freeze({ text: configured, requestKind: resolvedRequestKind, language: null });
  }
  const variants = acknowledgementVariants[resolvedLanguage][resolvedRequestKind]
    ?? acknowledgementVariants[resolvedLanguage].general;
  const index = stableVariantIndex(latestUtterance, variants.length, variantSeed);
  return Object.freeze({
    text: variants[index] ?? configured,
    requestKind: resolvedRequestKind,
    language: resolvedLanguage,
  });
}

export function latencyAcknowledgementEligibleForRoute({
  decision = '',
} = {}) {
  // Knowledge searches are the only route whose answer-generation work may
  // need progress speech. Workflow collection/confirmation/execution uses the
  // TOOL route; a separate factual question during a paused workflow remains
  // a SEARCH. Direct responses include closing and other conversational turns
  // that must not receive a processing preamble.
  return cleanText(decision, 40).toLocaleUpperCase() === 'SEARCH';
}

export function armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs,
  acknowledgementText,
  suppressed = false,
  isActive = () => true,
  onAcknowledgement,
  onTriggered,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const text = cleanText(acknowledgementText);
  const delayMs = Number(thresholdMs);
  let timer = null;
  let cancelled = false;
  let triggered = false;
  let queued = false;
  let thresholdReached = false;
  const deliver = () => {
    if (cancelled || suppressed || triggered || isActive() !== true) return;
    triggered = true;
    queued = onAcknowledgement(text) === true;
    onTriggered?.(Object.freeze({ thresholdMs: delayMs, queued }));
  };

  if (text && Number.isFinite(delayMs) && delayMs > 0
    && typeof onAcknowledgement === 'function') {
    timer = setTimer(() => {
      timer = null;
      thresholdReached = true;
      deliver();
    }, delayMs);
    timer?.unref?.();
  }

  return Object.freeze({
    setSuppressed(value) {
      suppressed = value === true;
      if (!suppressed && thresholdReached) deliver();
    },
    cancel() {
      if (cancelled) return false;
      cancelled = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      return true;
    },
    snapshot() {
      return Object.freeze({
        enabled: Boolean(text && Number.isFinite(delayMs) && delayMs > 0),
        thresholdMs: Number.isFinite(delayMs) ? delayMs : null,
        cancelled,
        triggered,
        queued,
        suppressed,
      });
    },
  });
}
