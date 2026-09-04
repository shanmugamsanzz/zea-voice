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

export function normalizeTemplateEngineSearchDecision(decision, state = {}) {
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
  if (requestedPreferences.some((recordId) => !knownRecordIds.has(recordId))) {
    return Object.freeze({ valid: false, reason: 'unknown_preferred_record_id' });
  }

  let preferredRecordIds = requestedPreferences;
  if (!preferredRecordIds.length && value.search.contextualReference) {
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
