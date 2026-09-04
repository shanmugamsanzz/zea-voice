import { validateTemplateEngineDecision } from './template-engine-decision-contract.js';

function recordIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? '').normalize('NFKC').trim())
    .filter(Boolean))];
}

function contextualAmbiguity(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/[\s-]+/gu, '_') === 'contextual_reference_ambiguous';
}

function tokens(value) {
  return new Set(String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/gu).filter((token) => token.length > 1));
}

function explicitlyNamesReference(latestUtterance, contextualReference) {
  const referenceTokens = tokens(contextualReference);
  if (!referenceTokens.size) return false;
  const utteranceTokens = tokens(latestUtterance);
  let matches = 0;
  for (const token of referenceTokens) if (utteranceTokens.has(token)) matches += 1;
  return matches / referenceTokens.size >= 0.67;
}

export function normalizeTemplateEngineSearchDecision(decision, state = {}, context = {}) {
  const validated = validateTemplateEngineDecision(decision);
  if (!validated.valid) return validated;
  const value = validated.value;

  if (value.decision === 'CLARIFY' && contextualAmbiguity(value.clarification.reason)
    && value.clarification.candidates.length < 2) {
    return Object.freeze({ valid: false, reason: 'contextual_clarification_requires_candidates' });
  }
  if (value.decision !== 'SEARCH') return validated;

  const knownRecordIds = new Set([
    ...recordIds(state.lastReferencedRecordIds),
    ...recordIds(state.comparisonRecordIds),
  ]);
  const requestedPreferences = recordIds(value.search.preferredRecordIds);
  const explicitReference = explicitlyNamesReference(
    context.latestUtterance, value.search.contextualReference,
  );
  // Preferred IDs are optional retrieval hints supplied by the model. The
  // minimal runtime state is the allowlist of records already verified for
  // this tenant, assigned KB and published revision. Drop anything outside
  // that allowlist instead of turning an otherwise valid SEARCH into an
  // operational failure.
  let preferredRecordIds = explicitReference ? [] : requestedPreferences
    .filter((recordId) => knownRecordIds.has(recordId));
  if (!explicitReference && !requestedPreferences.length && !preferredRecordIds.length
    && value.search.contextualReference) {
    const comparisonIds = recordIds(state.comparisonRecordIds);
    preferredRecordIds = comparisonIds.length > 1
      ? comparisonIds
      : (state.lastReferencedRecordIds?.length === 1
        ? recordIds(state.lastReferencedRecordIds) : []);
  }
  return Object.freeze({
    valid: true,
    value: Object.freeze({
      ...value,
      search: Object.freeze({
        ...value.search,
        preferredRecordIds: Object.freeze(preferredRecordIds),
      }),
    }),
  });
}
