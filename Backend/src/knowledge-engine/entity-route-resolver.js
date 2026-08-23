import {
  buildPublicationPhraseForms,
  normalizePublicationPhrase,
} from './publication-index-builder.js';

export const KNOWLEDGE_RESOLUTION_VERSION = 1;

export const knowledgeResolutionConfidence = Object.freeze({
  HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW',
});

export const knowledgeResolutionActions = Object.freeze({
  CONTINUE: 'CONTINUE', CONFIRM: 'CONFIRM', RETRIEVE: 'RETRIEVE', CLARIFY: 'CLARIFY',
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

function normalizeId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function tokens(value) {
  return normalizePublicationPhrase(value).split(' ').filter(Boolean);
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

function recordLabel(record) {
  return String(record?.entity_name ?? record?.question ?? record?.label
    ?? record?.answerCard?.text ?? record?.recordId ?? record?.id ?? '').trim();
}

function canonicalRecord(record) {
  const metadata = plainObject(record?.entity_metadata ?? record?.metadata);
  const conditions = plainObject(metadata.conditions);
  const recordId = String(record?.record_id ?? record?.recordId ?? record?.id ?? '').trim();
  if (!recordId) return null;
  return Object.freeze({
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
}

function addSignal(accumulator, entry, signal) {
  if (!entry?.recordId || signal.score <= 0) return;
  const key = entry.entityType === 'CATEGORY'
    ? `category:${normalizeId(entry.categoryKey ?? entry.label)}`
    : `record:${normalizeId(entry.recordId)}`;
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
    ['phonetic', index?.phonetic, queryForms.phonetic, 0.89],
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
      && category.signals.some((categorySignal) => candidate.signals.some(
        (itemSignal) => categorySignal.phrase && categorySignal.phrase === itemSignal.phrase,
      ))
    ));
    if (collision) accumulator.delete(key);
  }
}

function indexedSignals(accumulator, index, query, queryForms, records) {
  const sections = [
    ['exact', index?.exact, 1], ['stt', index?.stt, 0.96], ['phonetic', index?.phonetic, 0.89],
  ];
  for (const [section, entries, sectionScore] of sections) {
    for (const [phrase, indexedCandidates] of Object.entries(entries ?? {})) {
      let score = 0;
      let method = section;
      if (section === 'exact') {
        if (query === phrase) score = 1;
        else if (phraseContained(query, phrase)) {
          score = 0.98;
          method = 'tenant_alias';
        }
      } else if (section === 'stt') {
        const compactPhrase = phrase.replace(/\s+/gu, '');
        if (queryForms.stt.includes(phrase) || queryForms.stt.includes(compactPhrase)
          || queryForms.stt.some((form) => form.length >= 3 && form.includes(compactPhrase))) score = sectionScore;
      } else {
        const phraseSize = tokens(phrase).length;
        const queryTokens = tokens(query);
        const phoneticWindows = phraseSize > 0 && queryTokens.length >= phraseSize
          ? Array.from({ length: queryTokens.length - phraseSize + 1 }, (_value, offset) => (
            buildPublicationPhraseForms([queryTokens.slice(offset, offset + phraseSize).join(' ')])
              .phonetic
          )).flat()
          : [];
        if (queryForms.phonetic.includes(phrase) || phoneticWindows.includes(phrase)) score = sectionScore;
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

function fuzzySignals(accumulator, index, query, records) {
  for (const [phrase, indexedCandidates] of Object.entries(index?.exact ?? {})) {
    const similarity = fuzzyPhraseScore(query, phrase);
    if (similarity < 0.68) continue;
    for (const candidate of indexedCandidates) {
      addSignal(accumulator, indexedCandidate(candidate, records), {
        method: 'fuzzy', score: similarity, phrase, explicit: true,
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

function contextRecordId(memory, records) {
  const active = memory?.activeEntity ?? memory?.activeCategory;
  if (!active) return null;
  const directId = normalizeId(active.recordId ?? active.id);
  if (directId && records.has(directId)) return directId;
  const itemKey = normalizeId(active.itemKey ?? active.key);
  const categoryKey = normalizeId(active.categoryKey ?? active.key);
  for (const [recordId, record] of records) {
    if ((itemKey && normalizeId(record.itemKey) === itemKey)
      || (categoryKey && normalizeId(record.categoryKey) === categoryKey)) return recordId;
  }
  return null;
}

function contextSignals(accumulator, memory, records, hasExplicitCandidate) {
  const recordId = contextRecordId(memory, records);
  if (!recordId || hasExplicitCandidate) return;
  addSignal(accumulator, records.get(recordId), {
    method: 'context', score: 0.64, explicit: false,
  });
}

function confidenceFor(candidates) {
  const top = candidates[0];
  const second = candidates[1];
  if (!top) return { level: knowledgeResolutionConfidence.LOW, margin: 0 };
  const margin = top.score - (second?.score ?? 0);
  if (top.score >= 0.88 && (margin >= 0.06 || !second)) {
    return { level: knowledgeResolutionConfidence.HIGH, margin };
  }
  if (top.score >= 0.68) return { level: knowledgeResolutionConfidence.MEDIUM, margin };
  return { level: knowledgeResolutionConfidence.LOW, margin };
}

function actionFor(level, candidates) {
  if (level === knowledgeResolutionConfidence.HIGH) return knowledgeResolutionActions.CONTINUE;
  if (level === knowledgeResolutionConfidence.MEDIUM) return knowledgeResolutionActions.CONFIRM;
  return candidates.length ? knowledgeResolutionActions.RETRIEVE : knowledgeResolutionActions.CLARIFY;
}

function freezeCandidate(candidate) {
  return Object.freeze({
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
    actionType: candidate.actionType,
    requiresCatalogItem: candidate.requiresCatalogItem === true,
    evidenceRecordIds: Object.freeze([...(candidate.evidenceRecordIds ?? [candidate.recordId])]),
    score: boundedScore(candidate.score),
    method: candidate.method,
    explicit: candidate.explicit === true,
    signals: Object.freeze([...candidate.signals]),
  });
}

export function resolvePublishedEntityRoute(input, publicationBundles, options = {}) {
  const utterance = String(input?.utterance ?? '').normalize('NFKC').trim();
  if (!utterance) throw new TypeError('Entity resolution requires a finalized utterance');
  const bundles = Array.isArray(publicationBundles) ? publicationBundles : [publicationBundles];
  if (!bundles.length || bundles.some((bundle) => !bundle)) {
    throw new TypeError('Entity resolution requires published indexes');
  }
  bundles.forEach((bundle) => validateBundle(input, bundle));

  const records = new Map();
  for (const bundle of bundles) {
    for (const rawRecord of bundle.records ?? []) {
      const record = canonicalRecord(rawRecord);
      if (record) records.set(normalizeId(record.recordId), record);
    }
  }
  const query = normalizePublicationPhrase(utterance);
  const queryForms = buildPublicationPhraseForms([utterance]);
  const catalogCandidates = new Map();
  const routeCandidates = new Map();
  for (const bundle of bundles) {
    directIndexedSignals(catalogCandidates, bundle.entityIndex, query, queryForms, records);
    directIndexedSignals(catalogCandidates, bundle.entityIndex?.categories, query, queryForms, records);
    directIndexedSignals(routeCandidates, bundle.routeIndex, query, queryForms, records);
  }
  if (!catalogCandidates.size) {
    for (const bundle of bundles) {
      indexedSignals(catalogCandidates, bundle.entityIndex, query, queryForms, records);
      indexedSignals(catalogCandidates, bundle.entityIndex?.categories, query, queryForms, records);
      fuzzySignals(catalogCandidates, bundle.entityIndex, query, records);
      fuzzySignals(catalogCandidates, bundle.entityIndex?.categories, query, records);
    }
  }
  if (!routeCandidates.size) {
    for (const bundle of bundles) {
      indexedSignals(routeCandidates, bundle.routeIndex, query, queryForms, records);
      fuzzySignals(routeCandidates, bundle.routeIndex, query, records);
    }
  }
  suppressCategoryChildCollisions(catalogCandidates);
  const explicitCatalog = [...catalogCandidates.values()].some((candidate) => candidate.explicit);
  const candidates = explicitCatalog
    ? new Map([...routeCandidates].filter(([, candidate]) => candidate.recordType === 'WORKFLOW_RULE'))
    : new Map(routeCandidates);
  for (const [key, candidate] of catalogCandidates) candidates.set(key, candidate);
  if (!candidates.size) semanticSignals(candidates, options.semanticMatches, records);
  contextSignals(candidates, input.memory ?? {}, records,
    [...candidates.values()].some((candidate) => candidate.explicit));

  const ranked = [...candidates.values()].sort((left, right) => (
    right.score - left.score
    || (methodPriority[right.method] ?? -1) - (methodPriority[left.method] ?? -1)
    || left.recordId.localeCompare(right.recordId)
  )).map(freezeCandidate);
  const { level, margin } = confidenceFor(ranked);
  return Object.freeze({
    version: KNOWLEDGE_RESOLUTION_VERSION,
    tenantId: String(input.tenantId),
    confidence: level,
    score: ranked[0]?.score ?? 0,
    margin: boundedScore(margin),
    action: actionFor(level, ranked),
    candidate: ranked[0] ?? null,
    routingCandidates: Object.freeze(ranked),
    alternatives: Object.freeze(ranked.slice(1, 4)),
    explicitEntity: ranked[0]?.explicit === true,
    reason: ranked[0]
      ? `${ranked[0].method}_candidate_${level.toLocaleLowerCase()}`
      : 'no_candidate',
  });
}
