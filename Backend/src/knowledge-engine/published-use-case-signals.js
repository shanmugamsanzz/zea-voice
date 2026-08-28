export const PUBLISHED_USE_CASE_SIGNALS_VERSION = 1;

function clean(value, maximum = 1_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function collectStrings(value, output, depth = 0) {
  if (output.length >= 160 || depth > 5 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = clean(value);
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const entry of Object.values(value)) collectStrings(entry, output, depth + 1);
}

export function publishedUseCasePhrases(record = {}) {
  if (String(record.record_type ?? record.recordType ?? '').toLocaleLowerCase()
    !== 'catalog_item') return Object.freeze([]);
  const metadata = object(record.entity_metadata ?? record.metadata);
  const phrases = [
    record.entity_name,
    record.entity_category,
    record.description,
    ...(record.entity_aliases ?? record.aliases ?? []),
    ...(record.entity_category_aliases ?? metadata.categoryAliases ?? []),
    metadata.description,
    metadata.categoryDescription,
  ];
  collectStrings(metadata.capabilities, phrases);
  collectStrings(metadata.relationships, phrases);
  collectStrings(metadata.selectionRules, phrases);
  collectStrings(metadata.categorySelectionRules, phrases);
  collectStrings(record.content ?? record.source_text ?? metadata.sourceText, phrases);
  return Object.freeze([...new Set(phrases.map((value) => clean(value)).filter(Boolean))]
    .slice(0, 160));
}

export function publishedUseCaseTokens(record = {}) {
  return Object.freeze([...new Set(publishedUseCasePhrases(record).flatMap((phrase) => (
    phrase.toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
      .trim().split(/\s+/u).filter(Boolean)
  )))].slice(0, 1_000));
}

export function compactNeedContext({ input = {}, hasCurrentEntitySignal = false,
  hasCurrentRouteSignal = false } = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const question = clean(input.latestQuestion ?? input.utterance, 2_000);
  const collected = object(memory.collectedInformation ?? memory.collectedToolFields);
  const contextFields = Object.freeze(Object.fromEntries(Object.entries(collected)
    .slice(0, 20).map(([key, value]) => [clean(key, 120), clean(value, 300)]).filter((entry) => (
      entry[0] && entry[1]
    ))));
  const pending = object(memory.pendingClarification);
  const requestedFacts = [...new Set((input.requestedFacts ?? [])
    .map((value) => clean(value, 120).toLocaleLowerCase()).filter(Boolean))];
  const needBased = !hasCurrentEntitySignal && !hasCurrentRouteSignal && Boolean(question);
  return Object.freeze({
    detected: needBased,
    interpretationMode: needBased ? 'grounded_need_reasoning' : 'resolved_request',
    businessContext: contextFields,
    customerProblem: needBased ? question : null,
    desiredOutcome: clean(pending.desiredOutcome ?? memory.desiredOutcome, 500) || null,
    requestedRecommendation: needBased
      ? ((requestedFacts.includes('recommendation') || requestedFacts.includes('suitability'))
        ? true : null)
      : false,
    missingDetails: Object.freeze((Array.isArray(pending.missingDetails)
      ? pending.missingDetails : []).map((value) => clean(value, 160)).filter(Boolean).slice(0, 10)),
    requiresGroundedInterpretation: needBased,
  });
}
