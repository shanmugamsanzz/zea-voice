function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function configuredPhrases(conditions = {}) {
  const values = conditions.examples ?? conditions.triggerPhrases ?? [];
  return Array.isArray(values) ? values.map(normalize).filter(Boolean) : [];
}

export function latestTurnWorkflowActivation({ latestUtterance, conditions } = {}) {
  const utterance = normalize(latestUtterance);
  if (!utterance) return Object.freeze({ allowed: false, method: 'none', matchedPhrase: null });
  for (const phrase of configuredPhrases(conditions)) {
    if (utterance === phrase) {
      return Object.freeze({ allowed: true, method: 'exact', matchedPhrase: phrase });
    }
    if (phrase.split(' ').length >= 2 && ` ${utterance} `.includes(` ${phrase} `)) {
      return Object.freeze({ allowed: true, method: 'contains', matchedPhrase: phrase });
    }
  }
  return Object.freeze({ allowed: false, method: 'semantic_only', matchedPhrase: null });
}

