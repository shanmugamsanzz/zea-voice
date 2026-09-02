import {
  buildPublicationPhraseForms,
  normalizePublicationPhrase,
} from './publication-index-builder.js';
import {
  canonicalRecordIdentity,
  canonicalRecordIdentityKey,
  typedRecordIdentityKey,
} from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';

export const KNOWLEDGE_RESOLUTION_VERSION = 2;

// These shape a candidate score only. The selected agent configuration below
// determines whether the resulting score is high, confirmable, or weak.
const fuzzyCoverageCeiling = 0.84;
const fuzzyCoverageScale = 0.28;
const fuzzyCoverageBase = fuzzyCoverageCeiling - 0.16;

export const knowledgeResolutionConfidence = Object.freeze({
  HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW',
});

export const knowledgeResolutionActions = Object.freeze({
  CONTINUE: 'CONTINUE', CONFIRM: 'CONFIRM', RETRIEVE: 'RETRIEVE', CLARIFY: 'CLARIFY',
});

export const knowledgeCandidateNamespaces = Object.freeze({
  CATALOG: 'CATALOG',
  FAQ: 'FAQ',
  CONVERSATION: 'CONVERSATION',
  WORKFLOW: 'WORKFLOW',
  CALL_CONTROL: 'CALL_CONTROL',
  GENERAL: 'GENERAL',
});

const methodPriority = Object.freeze({
  exact: 7, normalized: 6, tenant_alias: 5, stt: 4,
  phonetic: 3, fuzzy: 2, semantic: 1, context: 0,
});

function boundedScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringList(value) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [value])
    .map((entry) => String(entry ?? '').normalize('NFKC').trim())
    .filter(Boolean))].slice(0, 20));
}

function normalizeId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function tokens(value) {
  return normalizePublicationPhrase(value).split(' ').filter(Boolean);
}

function normalizedIntentClass(value) {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/gu, '_');
}

function candidateNamespace(candidate) {
  if (candidate?.entityType === 'ITEM' || candidate?.entityType === 'CATEGORY'
    || ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate?.recordType)) {
    return knowledgeCandidateNamespaces.CATALOG;
  }
  if (candidate?.recordType === 'FAQ') return knowledgeCandidateNamespaces.FAQ;
  if (candidate?.recordType === 'CONVERSATION_NODE') return knowledgeCandidateNamespaces.CONVERSATION;
  if (candidate?.recordType === 'KNOWLEDGE_CHUNK') return knowledgeCandidateNamespaces.GENERAL;
  if (candidate?.recordType === 'WORKFLOW_RULE') {
    return normalizedIntentClass(candidate.intentClass) === 'CALL_CONTROL'
      ? knowledgeCandidateNamespaces.CALL_CONTROL : knowledgeCandidateNamespaces.WORKFLOW;
  }
  return null;
}

function candidateIdentity(candidate) {
  return canonicalRecordIdentityKey(candidate) ?? typedRecordIdentityKey(candidate);
}

function tokenStatistics(indexes) {
  const identities = new Set();
  const tokenIdentities = new Map();
  for (const index of indexes) {
    for (const [phrase, candidates] of Object.entries(index?.exact ?? {})) {
      const phraseTokens = new Set(tokens(phrase));
      for (const candidate of candidates) {
        const identity = candidateIdentity(candidate);
        identities.add(identity);
        for (const token of phraseTokens) {
          const owners = tokenIdentities.get(token) ?? new Set();
          owners.add(identity);
          tokenIdentities.set(token, owners);
        }
      }
    }
  }
  return Object.freeze({ identities, tokenIdentities });
}

function distinctiveCoverage(query, phrase, statistics) {
  const phraseTokens = new Set(tokens(phrase));
  const recognized = [...new Set(tokens(query))].filter(
    (token) => statistics.tokenIdentities.has(token),
  );
  if (!recognized.length) return 1;
  const total = Math.max(1, statistics.identities.size);
  const weight = (token) => 1 + Math.log((total + 1)
    / ((statistics.tokenIdentities.get(token)?.size ?? total) + 1));
  const denominator = recognized.reduce((sum, token) => sum + weight(token), 0);
  const numerator = recognized.filter((token) => phraseTokens.has(token))
    .reduce((sum, token) => sum + weight(token), 0);
  return denominator ? boundedScore(numerator / denominator) : 1;
}

function phraseIsCanonicalDistinctive(phrase, statistics) {
  const phraseTokens = [...new Set(tokens(phrase))];
  return phraseTokens.length > 0 && phraseTokens.every(
    (token) => statistics.tokenIdentities.get(token)?.size === 1,
  );
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function stringSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  return longest < 4 ? 0 : Math.max(0, 1 - editDistance(left, right) / longest);
}

function phraseContained(query, phrase) {
  return ` ${query} `.includes(` ${phrase} `);
}

function fuzzyPhraseScore(query, phrase) {
  const queryTokens = tokens(query);
  const phraseTokens = tokens(phrase);
  if (!queryTokens.length || !phraseTokens.length) return 0;
  const bestForPhrase = phraseTokens.map((phraseToken) => Math.max(
    ...queryTokens.map((queryToken) => stringSimilarity(queryToken, phraseToken)),
  ));
  const matched = bestForPhrase.filter((score) => score >= 0.72);
  const queryPhonetic = buildPublicationPhraseForms([query]).phonetic[0] ?? '';
  const phrasePhonetic = buildPublicationPhraseForms([phrase]).phonetic[0] ?? '';
  const phoneticSimilarity = stringSimilarity(
    queryPhonetic.replace(/\s+/gu, ''), phrasePhonetic.replace(/\s+/gu, ''),
  );
  if (!matched.length) return phoneticSimilarity >= 0.72 ? phoneticSimilarity * 0.94 : 0;
  const coverage = matched.length / phraseTokens.length;
  const average = matched.reduce((total, score) => total + score, 0) / matched.length;
  const lengthCompatibility = Math.min(queryTokens.length, phraseTokens.length)
    / Math.max(queryTokens.length, phraseTokens.length);
  return boundedScore(Math.max(
    average * (0.62 + coverage * 0.28 + lengthCompatibility * 0.1),
    phoneticSimilarity * 0.94,
  ));
}

function minimumPhraseTokenSimilarity(query, phrase) {
  const queryTokens = tokens(query);
  const phraseTokens = tokens(phrase);
  if (phraseTokens.length < 2 || !queryTokens.length) return 0;
  return Math.min(...phraseTokens.map((phraseToken) => Math.max(
    ...queryTokens.map((queryToken) => stringSimilarity(queryToken, phraseToken)),
  )));
}

function leadingEntitySimilarity(query, phrase) {
  const queryTokens = tokens(query);
  const phraseTokens = tokens(phrase);
  if (!queryTokens.length || !phraseTokens.length) return 0;
  const queryLead = queryTokens.slice(0, Math.min(2, queryTokens.length)).join(' ');
  const phraseLead = phraseTokens[0];
  const queryPhonetic = buildPublicationPhraseForms([queryLead]).phonetic[0]
    ?.replace(/\s+/gu, '') ?? '';
  const phrasePhonetic = buildPublicationPhraseForms([phraseLead]).phonetic[0]
    ?.replace(/\s+/gu, '') ?? '';
  return Math.max(
    stringSimilarity(queryTokens[0], phraseLead),
    stringSimilarity(queryPhonetic, phrasePhonetic),
  );
}

function recordLabel(record) {
  return String(record?.entity_name ?? record?.question ?? record?.label
    ?? record?.answerCard?.text ?? record?.recordId ?? record?.id ?? '').trim();
}

function canonicalRecord(record) {
  const metadata = plainObject(record?.entity_metadata ?? record?.metadata);
  const conditions = plainObject(metadata.conditions);
  const recordId = String(record?.record_id ?? record?.recordId ?? record?.id ?? '').trim();
  if (!recordId) return null;
  const identity = canonicalRecordIdentity(record, record?.canonicalIdentity);
  return Object.freeze({
    tenantId: identity.tenantId || null,
    knowledgeBaseId: identity.knowledgeBaseId || null,
    publicationRevision: identity.publicationRevision || null,
    namespace: identity.namespace || null,
    recordId,
    recordType: String(record?.record_type ?? record?.recordType ?? record?.type ?? '').toUpperCase(),
    entityType: String(record?.entityType ?? (String(record?.record_type ?? '').toLowerCase() === 'catalog_item'
      ? 'ITEM' : 'ROUTE')).toUpperCase(),
    label: recordLabel(record),
    itemKey: String(metadata.itemKey ?? record?.itemKey ?? '').trim() || null,
    categoryKey: String(metadata.categoryKey ?? record?.categoryKey ?? '').trim() || null,
    categoryDescription: String(metadata.categoryDescription ?? record?.categoryDescription ?? '').trim() || null,
    children: Object.freeze([...(record?.children ?? [])]),
    category: String(record?.entity_category ?? record?.category ?? '').trim() || null,
    answerCard: record?.approvedAnswerCard ?? record?.answerCard ?? null,
    intentClass: String(conditions.intentClass ?? metadata.intentClass ?? record?.intentClass ?? '').trim() || null,
    requestedFacts: stringList([
      ...(Array.isArray(conditions.requestedFacts) ? conditions.requestedFacts : []),
      conditions.requestedFact,
      ...(Array.isArray(metadata.requestedFacts) ? metadata.requestedFacts : []),
      metadata.requestedFact,
    ]),
    actionType: String(metadata.actionType ?? record?.actionType ?? '').trim().toLowerCase() || null,
    requiresCatalogItem: plainObject(metadata.actionConfig).requiresCatalogItem === true,
    evidenceRecordIds: Object.freeze([String(recordId)]),
  });
}

function indexedCandidate(candidate, records) {
  const record = records.get(normalizeId(candidate?.recordId));
  if (!record) return candidate;
  if (candidate?.entityType !== 'CATEGORY') return record;
  return {
    ...record,
    recordType: 'CATALOG_CATEGORY',
    entityType: 'CATEGORY',
    label: candidate.label ?? record.category ?? record.label,
    itemKey: null,
    categoryKey: candidate.categoryKey ?? record.categoryKey,
    categoryDescription: candidate.categoryDescription ?? record.categoryDescription,
    children: Object.freeze([...(candidate.children ?? [])]),
    evidenceRecordIds: candidate.evidenceRecordIds ?? [record.recordId],
    answerCard: null,
  };
}

function validateBundle(input, bundle) {
  const expectedTenant = normalizeId(input?.tenantId);
  const indexedTenant = normalizeId(bundle?.tenantId);
  if (!expectedTenant || !indexedTenant || expectedTenant !== indexedTenant) {
    throw new TypeError('Entity resolution requires publication indexes from the same tenant');
  }
  const expectedAgent = normalizeId(input?.agentId);
  const assignedAgents = (bundle?.assignedAgentIds ?? []).map(normalizeId).filter(Boolean);
  if (assignedAgents.length && !assignedAgents.includes(expectedAgent)) {
    throw new TypeError('Entity resolution requires publication indexes assigned to the active agent');
  }
}

function addSignal(accumulator, entry, signal) {
  if (!entry?.recordId || signal.score <= 0) return;
  const key = candidateIdentity(entry);
  if (!key) return;
  const current = accumulator.get(key) ?? {
    ...entry, score: 0, method: 'context', explicit: false, signals: [],
  };
  const preferred = signal.score > current.score
    || (signal.score === current.score
      && (methodPriority[signal.method] ?? -1) > (methodPriority[current.method] ?? -1));
  current.signals.push(Object.freeze({ ...signal, score: boundedScore(signal.score) }));
  if (preferred) {
    current.score = boundedScore(signal.score);
    current.method = signal.method;
  }
  current.explicit ||= signal.explicit === true;
  accumulator.set(key, current);
}

function directIndexedSignals(accumulator, index, query, queryForms, records) {
  const lookups = [
    ['exact', index?.exact, [query], 1],
    ['stt', index?.stt, queryForms.stt, 0.96],
    // Generated phonetic forms are discovery signals, not proof that the
    // caller named the entity exactly. Keep them below the automatic-accept
    // threshold so the tenant-published candidate is confirmed first.
    ['phonetic', index?.phonetic, queryForms.phonetic, 0.84],
  ];
  for (const [method, entries, phrases, score] of lookups) {
    for (const phrase of new Set(phrases)) {
      for (const candidate of entries?.[phrase] ?? []) {
        addSignal(accumulator, indexedCandidate(candidate, records), {
          method, score, phrase, explicit: true,
        });
      }
    }
  }
}

function suppressCategoryChildCollisions(accumulator) {
  const values = [...accumulator.entries()];
  const categories = values.filter(([, candidate]) => candidate.entityType === 'CATEGORY'
    && candidate.explicit);
  for (const [key, candidate] of values) {
    if (candidate.entityType !== 'ITEM') continue;
    const collision = categories.find(([, category]) => (
      normalizeId(category.categoryKey) === normalizeId(candidate.categoryKey)
      && category.score >= candidate.score
    ));
    if (collision) accumulator.delete(key);
  }
}

function indexedSignals(accumulator, index, query, queryForms, records, statistics) {
  const sections = [
    ['exact', index?.exact, 1], ['stt', index?.stt, 0.96], ['phonetic', index?.phonetic, 0.84],
  ];
  for (const [section, entries, sectionScore] of sections) {
    for (const [phrase, indexedCandidates] of Object.entries(entries ?? {})) {
      let score = 0;
      let method = section;
      if (section === 'exact') {
        if (query === phrase) score = 1;
        else if (phraseContained(query, phrase)) {
          // A contained alias is strong only when it covers the distinctive
          // tenant-published terms in the utterance. This prevents a generic
          // phrase shared by many entities from beating a more specific fuzzy
          // or phonetic match.
          const coverage = distinctiveCoverage(query, phrase, statistics);
          score = phraseIsCanonicalDistinctive(phrase, statistics) ? 0.98
            : (coverage >= 0.98 ? 0.96 : Math.min(0.84, 0.72 + coverage * 0.26));
          method = 'tenant_alias';
        }
      } else if (section === 'stt') {
        const compactPhrase = phrase.replace(/\s+/gu, '');
        if (queryForms.stt.includes(phrase) || queryForms.stt.includes(compactPhrase)) {
          score = sectionScore;
        } else if (query.replace(/\s+/gu, '').startsWith(compactPhrase)) {
          score = sectionScore;
        } else if (queryForms.stt.some((form) => form.length >= 3 && form.includes(compactPhrase))) {
          const coverage = distinctiveCoverage(query, phrase, statistics);
          score = phraseIsCanonicalDistinctive(phrase, statistics) ? sectionScore
            : (coverage >= 0.98 ? 0.94 : Math.min(
              fuzzyCoverageCeiling, fuzzyCoverageBase + coverage * fuzzyCoverageScale,
            ));
        }
      } else {
        const phraseSize = tokens(phrase).length;
        const queryTokens = tokens(query);
        const phoneticWindows = phraseSize > 0 && queryTokens.length >= phraseSize
          ? Array.from({ length: queryTokens.length - phraseSize + 1 }, (_value, offset) => (
            buildPublicationPhraseForms([queryTokens.slice(offset, offset + phraseSize).join(' ')])
              .phonetic
          )).flat()
          : [];
        const compactPhrase = phrase.replace(/\s+/gu, '');
        const compactWindows = phoneticWindows.map((form) => form.replace(/\s+/gu, ''));
        if (queryForms.phonetic.includes(phrase)) score = sectionScore;
        else if (phoneticWindows.includes(phrase) || compactWindows.includes(compactPhrase)
          || queryForms.phonetic.some(
          (form) => form.replace(/\s+/gu, '').includes(compactPhrase),
        )) score = 0.66 + distinctiveCoverage(query, phrase, statistics) * 0.23;
      }
      if (!score) continue;
      for (const candidate of indexedCandidates) {
        addSignal(accumulator, indexedCandidate(candidate, records), {
          method, score, phrase, explicit: true,
        });
      }
    }
  }
}

function fuzzySignals(accumulator, index, query, records, statistics, confidenceConfiguration) {
  for (const [phrase, indexedCandidates] of Object.entries(index?.exact ?? {})) {
    const similarity = fuzzyPhraseScore(query, phrase);
    if (similarity < confidenceConfiguration.clarificationConfidence) continue;
    const coverage = distinctiveCoverage(query, phrase, statistics);
    const leadingSimilarity = leadingEntitySimilarity(query, phrase);
    const leadingBonus = leadingSimilarity >= 0.58 ? 0.1 : 0;
    const completeLexicalMatch = tokens(phrase).length >= 3
      && minimumPhraseTokenSimilarity(query, phrase) >= 0.84
      && coverage >= 0.6;
    const calculatedScore = similarity * (0.7 + coverage * 0.3) + leadingBonus;
    const distinctiveLead = leadingSimilarity >= 0.9 && coverage >= 0.5;
    const rawScore = distinctiveLead
      ? Math.max(0.86, calculatedScore) : calculatedScore;
    const score = query === phrase ? similarity
      : (completeLexicalMatch ? Math.min(0.93, rawScore)
        : Math.min(distinctiveLead ? 0.879 : 0.87, rawScore));
    for (const candidate of indexedCandidates) {
      addSignal(accumulator, indexedCandidate(candidate, records), {
        method: 'fuzzy', score: boundedScore(score), phrase, explicit: true,
      });
    }
  }
}

function semanticSignals(accumulator, semanticMatches, records) {
  for (const match of Array.isArray(semanticMatches) ? semanticMatches : []) {
    const score = boundedScore(match?.score ?? match?.semanticScore);
    if (score <= 0) continue;
    const record = records.get(normalizeId(match?.recordId ?? match?.id));
    if (record) addSignal(accumulator, record, { method: 'semantic', score, explicit: false });
  }
}

function confidenceFor(candidates, confidenceConfiguration) {
  const top = candidates[0];
  const second = candidates[1];
  if (!top) return { level: knowledgeResolutionConfidence.LOW, margin: 0 };
  const margin = top.score - (second?.score ?? 0);
  if (top.score >= confidenceConfiguration.highConfidence
    && (margin >= confidenceConfiguration.ambiguityMargin || !second)) {
    return { level: knowledgeResolutionConfidence.HIGH, margin };
  }
  if (top.score >= confidenceConfiguration.clarificationConfidence) {
    return { level: knowledgeResolutionConfidence.MEDIUM, margin };
  }
  return { level: knowledgeResolutionConfidence.LOW, margin };
}

function hasStrongCanonicalSignal(candidate, confidenceConfiguration) {
  return candidate?.explicit === true
    && Number(candidate?.score ?? 0) >= confidenceConfiguration.highConfidence
    && (candidate.signals ?? []).some((signal) => (
      signal.explicit === true
      && ['exact', 'normalized', 'tenant_alias', 'stt'].includes(signal.method)
      && Number(signal.score ?? 0) >= confidenceConfiguration.highConfidence
    ));
}

function discardDominatedCandidates(candidates, confidenceConfiguration) {
  const ranked = [...candidates];
  const top = ranked[0];
  if (!hasStrongCanonicalSignal(top, confidenceConfiguration)) return ranked;
  // Strong published canonical/alias matches outrank discovery-only signals.
  // Keep an equally authoritative near-tie so shared tenant aliases still
  // produce a genuine clarification instead of an arbitrary selection.
  return ranked.filter((candidate, index) => index === 0 || (
    hasStrongCanonicalSignal(candidate, confidenceConfiguration)
    && Number(top.score ?? 0) - Number(candidate.score ?? 0)
      <= confidenceConfiguration.ambiguityMargin
  ));
}

function actionFor(level, candidates) {
  if (level === knowledgeResolutionConfidence.HIGH) return knowledgeResolutionActions.CONTINUE;
  if (level === knowledgeResolutionConfidence.MEDIUM) return knowledgeResolutionActions.CONFIRM;
  return candidates.length ? knowledgeResolutionActions.RETRIEVE : knowledgeResolutionActions.CLARIFY;
}

function freezeCandidate(candidate) {
  return Object.freeze({
    tenantId: candidate.tenantId ?? null,
    knowledgeBaseId: candidate.knowledgeBaseId ?? null,
    publicationRevision: Number(candidate.publicationRevision) || null,
    namespace: candidate.namespace ?? candidateNamespace(candidate),
    recordId: candidate.recordId,
    recordType: candidate.recordType,
    entityType: candidate.entityType,
    label: candidate.label,
    itemKey: candidate.itemKey,
    categoryKey: candidate.categoryKey,
    categoryDescription: candidate.categoryDescription,
    children: Object.freeze([...(candidate.children ?? [])]),
    category: candidate.category,
    answerCard: candidate.answerCard,
    intentClass: candidate.intentClass,
    requestedFacts: Object.freeze([...(candidate.requestedFacts ?? [])]),
    actionType: candidate.actionType,
    requiresCatalogItem: candidate.requiresCatalogItem === true,
    evidenceRecordIds: Object.freeze([...(candidate.evidenceRecordIds ?? [candidate.recordId])]),
    score: boundedScore(candidate.score),
    method: candidate.method,
    explicit: candidate.explicit === true,
    signals: Object.freeze([...candidate.signals]),
  });
}

function normalizedBundles(input, publicationBundles) {
  const utterance = String(input?.utterance ?? '').normalize('NFKC').trim();
  if (!utterance) throw new TypeError('Entity resolution requires a finalized utterance');
  const bundles = Array.isArray(publicationBundles) ? publicationBundles : [publicationBundles];
  if (!bundles.length || bundles.some((bundle) => !bundle)) {
    throw new TypeError('Entity resolution requires published indexes');
  }
  bundles.forEach((bundle) => validateBundle(input, bundle));
  const records = new Map();
  const usageDirection = String(input?.usageDirection ?? 'inbound').trim().toLocaleLowerCase();
  for (const bundle of bundles) {
    for (const rawRecord of bundle.records ?? []) {
      const recordUsage = String(rawRecord?.usage_direction ?? rawRecord?.usageDirection ?? 'both')
        .trim().toLocaleLowerCase();
      if (![usageDirection, 'both'].includes(recordUsage)) continue;
      const record = canonicalRecord(rawRecord);
      if (record) records.set(normalizeId(record.recordId), record);
    }
  }
  return { utterance, bundles, records };
}

function rankCandidates(candidates) {
  return [...candidates.values()].sort((left, right) => (
    right.score - left.score
    || (methodPriority[right.method] ?? -1) - (methodPriority[left.method] ?? -1)
    || left.recordId.localeCompare(right.recordId)
  )).map(freezeCandidate);
}

function groupByNamespace(candidates) {
  const grouped = new Map(Object.values(knowledgeCandidateNamespaces).map(
    (namespace) => [namespace, new Map()],
  ));
  for (const [key, candidate] of candidates) {
    const namespace = candidateNamespace(candidate);
    if (namespace) grouped.get(namespace).set(key, candidate);
  }
  return grouped;
}

function frozenNamespaceCandidates(grouped) {
  return Object.freeze(Object.fromEntries([...grouped].map(([namespace, candidates]) => [
    namespace,
    Object.freeze(rankCandidates(candidates)),
  ])));
}

function matchRouteCandidates(bundles, records, query, queryForms, confidenceConfiguration) {
  const candidates = new Map();
  const indexes = bundles.flatMap((bundle) => {
    const namespaces = Object.values(bundle.routeIndex?.namespaces ?? {}).filter(Boolean);
    return namespaces.length > 0 ? namespaces : [bundle.routeIndex].filter(Boolean);
  });
  const statistics = tokenStatistics(indexes);
  for (const index of indexes) {
    directIndexedSignals(candidates, index, query, queryForms, records);
    indexedSignals(candidates, index, query, queryForms, records, statistics);
    fuzzySignals(candidates, index, query, records, statistics, confidenceConfiguration);
  }
  for (const [key, candidate] of candidates) {
    if (candidateNamespace(candidate) === knowledgeCandidateNamespaces.CATALOG) {
      candidates.delete(key);
    }
  }
  return candidates;
}

function matchCatalogCandidates(bundles, records, query, queryForms, confidenceConfiguration) {
  const candidates = new Map();
  const indexes = bundles.flatMap((bundle) => [
    bundle.entityIndex, bundle.entityIndex?.categories,
  ]).filter(Boolean);
  const statistics = tokenStatistics(indexes);
  for (const index of indexes) {
    directIndexedSignals(candidates, index, query, queryForms, records);
    indexedSignals(candidates, index, query, queryForms, records, statistics);
    fuzzySignals(candidates, index, query, records, statistics, confidenceConfiguration);
  }
  suppressCategoryChildCollisions(candidates);
  return candidates;
}

function resolutionResult(
  input, ranked, namespace, namespaceCandidates, confidenceConfiguration, reasonPrefix = null,
) {
  const authoritativeRanked = discardDominatedCandidates(ranked, confidenceConfiguration);
  const { level, margin } = confidenceFor(authoritativeRanked, confidenceConfiguration);
  const contextDependent = authoritativeRanked[0]?.method === 'context';
  const closeCandidates = authoritativeRanked.filter((candidate) => (
    Number(authoritativeRanked[0]?.score ?? 0) - Number(candidate.score ?? 0)
      <= confidenceConfiguration.ambiguityMargin
  ));
  const ambiguityDetected = level === knowledgeResolutionConfidence.MEDIUM
    && closeCandidates.length > 1;
  return Object.freeze({
    version: KNOWLEDGE_RESOLUTION_VERSION,
    tenantId: String(input.tenantId),
    confidenceConfiguration,
    confidence: level,
    score: ranked[0]?.score ?? 0,
    margin: boundedScore(margin),
    action: actionFor(level, authoritativeRanked),
    candidate: authoritativeRanked[0] ?? null,
    candidateNamespace: namespace,
    namespaceCandidates,
    routingCandidates: Object.freeze(authoritativeRanked),
    alternatives: Object.freeze(authoritativeRanked.slice(1, 4)),
    ambiguity: Object.freeze({
      detected: ambiguityDetected,
      reason: ambiguityDetected ? 'close_published_entity_candidates' : null,
      candidates: Object.freeze((ambiguityDetected ? closeCandidates : []).slice(0, 5)),
    }),
    requiresCandidateConfirmation: level === knowledgeResolutionConfidence.MEDIUM,
    explicitEntity: namespace === knowledgeCandidateNamespaces.CATALOG
      && authoritativeRanked[0]?.explicit === true,
    contextDependent,
    reason: authoritativeRanked[0]
      ? `${reasonPrefix ?? authoritativeRanked[0].method}_candidate_${level.toLocaleLowerCase()}`
      : 'no_candidate',
  });
}

const absoluteRouteIntents = new Set(['SAFETY_EMERGENCY', 'CALL_CONTROL', 'ACTION_TOOL_REQUEST']);

const explicitPriorityMethods = new Set(['exact', 'normalized', 'tenant_alias', 'stt', 'phonetic']);

function explicitPriorityRoute(candidate, confidenceConfiguration) {
  return candidate?.explicit === true
    && Number(candidate?.score ?? 0) >= confidenceConfiguration.highConfidence
    && (candidate.signals ?? []).some((signal) => signal.explicit === true
      && explicitPriorityMethods.has(signal.method)
      && Number(signal.score ?? 0) >= confidenceConfiguration.highConfidence);
}
const routeIntentPriority = Object.freeze({
  SAFETY_EMERGENCY: 100,
  CALL_CONTROL: 90,
  ACTION_TOOL_REQUEST: 80,
  CLARIFICATION_ANSWER: 70,
  ACKNOWLEDGEMENT: 60,
});

function bestRouteCandidate(routes, confidenceConfiguration) {
  const eligiblePriority = (candidate) => {
    const intent = normalizedIntentClass(candidate?.intentClass);
    const method = String(candidate?.method ?? '');
    const explicitlyPublished = candidate?.explicit === true
      && Number(candidate?.score ?? 0) >= confidenceConfiguration.highConfidence
      && ['exact', 'normalized', 'tenant_alias', 'stt', 'phonetic'].includes(method);
    return explicitlyPublished ? (routeIntentPriority[intent] ?? 0) : 0;
  };
  return rankCandidates(routes).sort((left, right) => (
    eligiblePriority(right) - eligiblePriority(left)
    || right.score - left.score
  ))[0] ?? null;
}

export function resolvePublishedEntityRoute(input, publicationBundles, options = {}) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    options.confidenceConfiguration ?? options.confidenceSettings ?? {},
  );
  const { utterance, bundles, records } = normalizedBundles(input, publicationBundles);
  const query = normalizePublicationPhrase(utterance);
  const queryForms = buildPublicationPhraseForms([utterance]);
  const catalog = matchCatalogCandidates(
    bundles, records, query, queryForms, confidenceConfiguration,
  );
  const routes = matchRouteCandidates(
    bundles, records, query, queryForms, confidenceConfiguration,
  );
  const semantic = new Map();
  semanticSignals(semantic, options.semanticMatches, records);
  // Merge semantic support into an existing tenant-published Catalog identity
  // before choosing a winner. Otherwise the same record can appear once as an
  // explicit lexical match and again as a semantic-only match, causing the
  // higher semantic score to erase the fact that the caller named it.
  for (const candidate of semantic.values()) {
    if (candidateNamespace(candidate) !== knowledgeCandidateNamespaces.CATALOG) continue;
    addSignal(catalog, candidate, {
      method: 'semantic', score: candidate.score, explicit: false,
    });
  }
  // Call memory is supplied to retrieval and the grounded LLM. It is not an
  // entity match for the current question; only current published signals may
  // produce an explicit resolution here.
  const routeGroups = groupByNamespace(routes);
  const semanticGroups = groupByNamespace(semantic);
  const fallbackRouteCandidate = bestRouteCandidate(routes, confidenceConfiguration);
  const preliminaryCandidate = fallbackRouteCandidate;
  const preliminaryNamespace = candidateNamespace(preliminaryCandidate);
  const preliminaryIntent = normalizedIntentClass(preliminaryCandidate?.intentClass);
  // Protocol-level routes are deterministic. Normal published namespaces
  // remain independently eligible so explicit Catalog entities can outrank
  // generic FAQ or Conversation guidance.
  const lockPublishedRoute = explicitPriorityRoute(preliminaryCandidate, confidenceConfiguration)
    && absoluteRouteIntents.has(preliminaryIntent);

  const catalogRanked = rankCandidates(catalog);
  const semanticRanked = rankCandidates(semantic);
  const explicitCatalog = catalogRanked[0]?.explicit === true
    && catalogRanked[0].score >= confidenceConfiguration.highConfidence;
  const canonicalCatalog = hasStrongCanonicalSignal(
    catalogRanked[0], confidenceConfiguration,
  );
  const confirmableCatalog = catalogRanked[0]?.explicit === true
    && catalogRanked[0].score >= confidenceConfiguration.clarificationConfidence;
  const explicitPublishedRoute = explicitPriorityRoute(
    preliminaryCandidate, confidenceConfiguration,
  );
  let selectedNamespace = null;
  let selected = new Map();
  if (lockPublishedRoute && preliminaryNamespace) {
    selectedNamespace = preliminaryNamespace;
    selected = routeGroups.get(preliminaryNamespace) ?? new Map();
  } else if (explicitPublishedRoute && preliminaryNamespace && !canonicalCatalog) {
    // An exact published FAQ/Conversation route outranks a Catalog candidate
    // that crossed the configured high threshold through fuzzy/phonetic
    // discovery alone. Exact Catalog names and aliases still retain entity
    // priority through the canonical branch below.
    selectedNamespace = preliminaryNamespace;
    selected = routeGroups.get(preliminaryNamespace) ?? new Map();
  } else if (explicitCatalog) {
    selectedNamespace = knowledgeCandidateNamespaces.CATALOG;
    selected = catalog;
  } else if (explicitPublishedRoute && preliminaryNamespace) {
    // Current-turn exact/normalized published routes outrank merely fuzzy
    // Catalog discovery. A strong explicit Catalog entity still wins above,
    // preserving specific-entity priority over generic guidance.
    selectedNamespace = preliminaryNamespace;
    selected = routeGroups.get(preliminaryNamespace) ?? new Map();
  } else if (confirmableCatalog) {
    selectedNamespace = knowledgeCandidateNamespaces.CATALOG;
    selected = catalog;
  } else if (preliminaryCandidate && preliminaryNamespace) {
    selectedNamespace = preliminaryNamespace;
    selected = routeGroups.get(preliminaryNamespace) ?? new Map();
  } else if (catalog.size) {
    selectedNamespace = knowledgeCandidateNamespaces.CATALOG;
    selected = catalog;
  }

  const semanticTop = semanticRanked[0] ?? null;
  const selectedTop = rankCandidates(selected)[0] ?? null;
  if (semanticTop && !lockPublishedRoute && !explicitCatalog && !explicitPublishedRoute
    && (!selectedTop || semanticTop.score > selectedTop.score)) {
    selectedNamespace = candidateNamespace(semanticTop);
    selected = selectedNamespace ? semanticGroups.get(selectedNamespace) : new Map();
  } else if (!selected.size) {
    const top = semanticTop;
    selectedNamespace = candidateNamespace(top);
    selected = selectedNamespace ? semanticGroups.get(selectedNamespace) : new Map();
  }
  const allCandidates = new Map([...routes, ...catalog]);
  for (const candidate of semantic.values()) {
    addSignal(allCandidates, candidate, {
      method: 'semantic', score: candidate.score, explicit: false,
    });
  }
  const allGroups = groupByNamespace(allCandidates);
  return resolutionResult(input, rankCandidates(selected), selectedNamespace,
    frozenNamespaceCandidates(allGroups), confidenceConfiguration);
}
