const genericQueryTokens = new Set([
  'a', 'an', 'and', 'about', 'available', 'cost', 'detail', 'details', 'explain', 'for', 'give',
  'health', 'how', 'i', 'in', 'info', 'information', 'is', 'item', 'me', 'much', 'of', 'option',
  'options', 'package', 'packages', 'plan', 'plans', 'please', 'price', 'product', 'products',
  'service', 'services', 'show', 'tell', 'the', 'to', 'want', 'what', 'with',
]);

export function normalizeCatalogEntityText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/([\p{Script=Latin}\p{N}])(?=[^\p{Script=Latin}\p{N}\s])/gu, '$1 ')
    .replace(/([^\p{Script=Latin}\p{N}\s])(?=[\p{Script=Latin}\p{N}])/gu, '$1 ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function latinStem(token) {
  if (!/^[a-z]+$/u.test(token) || token.length < 4) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function phoneticCatalogToken(value) {
  const token = normalizeCatalogEntityText(value).replace(/[^a-z]/gu, '');
  if (token.length < 3) return '';
  const groups = {
    b: '1', f: '1', p: '1', v: '1',
    c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3',
    l: '4',
    m: '5', n: '5',
    r: '6',
  };
  let previous = groups[token[0]] ?? '';
  let encoded = token[0].toUpperCase();
  for (const character of token.slice(1)) {
    const code = groups[character] ?? '';
    if (code && code !== previous) encoded += code;
    previous = code;
    if (encoded.length === 4) break;
  }
  return encoded.padEnd(4, '0');
}

// STT often changes a leading vowel (for example, "Argon" / "Organ") while
// retaining the consonant sequence. This is language-agnostic and is used only
// as a lower-priority matching signal alongside the tenant's own aliases.
function consonantSkeleton(value) {
  const token = normalizeCatalogEntityText(value).replace(/[^a-z]/gu, '');
  if (token.length < 4) return '';
  return token.replace(/[aeiouy]/gu, '').replace(/(.)\1+/gu, '$1');
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function tokenSimilarity(left, right) {
  if (left === right) return { score: 1, method: 'normalized' };
  if (latinStem(left) === latinStem(right)) return { score: 0.98, method: 'normalized' };
  const leftPhonetic = phoneticCatalogToken(left);
  const rightPhonetic = phoneticCatalogToken(right);
  if (leftPhonetic && leftPhonetic === rightPhonetic) return { score: 0.9, method: 'phonetic' };
  const leftSkeleton = consonantSkeleton(left);
  const rightSkeleton = consonantSkeleton(right);
  if (leftSkeleton.length >= 3 && leftSkeleton === rightSkeleton) {
    return { score: 0.88, method: 'phonetic' };
  }
  const longest = Math.max(left.length, right.length);
  if (longest < 4) return { score: 0, method: 'none' };
  const score = 1 - editDistance(left, right) / longest;
  return score >= 0.72 ? { score, method: 'fuzzy' } : { score: 0, method: 'none' };
}

function meaningfulTokens(value) {
  const tokens = normalizeCatalogEntityText(value).split(' ').filter(Boolean);
  const meaningful = tokens.filter((token) => !genericQueryTokens.has(token));
  return meaningful.length ? meaningful : tokens;
}

function tokenCoverage(sourceTokens, targetTokens) {
  if (!sourceTokens.length || !targetTokens.length) return { matched: 0, coverage: 0 };
  const matched = sourceTokens.filter((sourceToken) => targetTokens.some(
    (targetToken) => tokenSimilarity(sourceToken, targetToken).score >= 0.72,
  )).length;
  return { matched, coverage: matched / sourceTokens.length };
}

function tokenEvidence(queryTokens, labelTokens) {
  const query = tokenCoverage(queryTokens, labelTokens);
  const label = tokenCoverage(labelTokens, queryTokens);
  return {
    matchedQueryTokens: query.matched,
    queryTokenCount: queryTokens.length,
    queryCoverage: query.coverage,
    matchedLabelTokens: label.matched,
    labelTokenCount: labelTokens.length,
    labelCoverage: label.coverage,
  };
}

export function catalogLabelSimilarity(query, label) {
  const normalizedQuery = normalizeCatalogEntityText(query);
  const normalizedLabel = normalizeCatalogEntityText(label);
  if (!normalizedQuery || !normalizedLabel) return { score: 0, method: 'none' };
  const queryTokens = meaningfulTokens(normalizedQuery);
  const labelTokens = meaningfulTokens(normalizedLabel);
  const evidence = tokenEvidence(queryTokens, labelTokens);
  if (normalizedQuery === normalizedLabel) return { score: 1, method: 'normalized', ...evidence };
  if (` ${normalizedQuery} `.includes(` ${normalizedLabel} `)) {
    return { score: 0.99, method: 'normalized', ...evidence };
  }
  if (normalizedQuery.length >= 3 && ` ${normalizedLabel} `.includes(` ${normalizedQuery} `)) {
    return { score: 0.94, method: 'normalized', ...evidence };
  }
  if (!queryTokens.length || !labelTokens.length) return { score: 0, method: 'none' };
  // Compare contiguous phrase windows as well as individual tokens. Voice STT
  // can split or reshape a multi-word name while preserving its consonant
  // pattern; a phrase-level phonetic match recovers that published identity
  // without maintaining application vocabulary or caller-phrase lists.
  const allQueryTokens = normalizedQuery.split(' ').filter(Boolean);
  const phraseSize = normalizedLabel.split(' ').filter(Boolean).length;
  if (phraseSize > 0 && allQueryTokens.length >= phraseSize) {
    const labelPhonetic = phoneticCatalogToken(normalizedLabel);
    const compactLabel = normalizedLabel.replace(/[^a-z]/gu, '');
    for (let index = 0; index <= allQueryTokens.length - phraseSize; index += 1) {
      const window = allQueryTokens.slice(index, index + phraseSize).join(' ');
      const compactWindow = window.replace(/[^a-z]/gu, '');
      const lengthCompatibility = compactLabel.length && compactWindow.length
        ? Math.min(compactLabel.length, compactWindow.length)
          / Math.max(compactLabel.length, compactWindow.length)
        : 0;
      // A short phonetic code alone is not enough to equate a compact category
      // name with a much longer child-item name. Requiring comparable phrase
      // lengths prevents that collision while retaining noisy multi-word STT.
      if (lengthCompatibility >= 0.7 && labelPhonetic
        && phoneticCatalogToken(window) === labelPhonetic) {
        return { score: 0.9, method: 'phonetic', ...evidence };
      }
    }
  }
  let method = 'none';
  const scores = queryTokens.map((queryToken) => {
    let best = { score: 0, method: 'none' };
    for (const labelToken of labelTokens) {
      const candidate = tokenSimilarity(queryToken, labelToken);
      if (candidate.score > best.score) best = candidate;
    }
    if (best.score > 0 && ['phonetic', 'fuzzy'].includes(best.method)) method = best.method;
    else if (best.score > 0 && method === 'none') method = best.method;
    return best.score;
  });
  const matched = scores.filter((score) => score >= 0.72);
  if (!matched.length) return { score: 0, method: 'none' };
  const coverage = matched.length / queryTokens.length;
  const average = matched.reduce((total, score) => total + score, 0) / matched.length;
  return { score: average * (0.72 + coverage * 0.28), method, ...evidence };
}

function relationshipText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string').join(' ');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).flatMap((entry) => (
    typeof entry === 'string' ? [entry] : (Array.isArray(entry) ? entry.filter((value) => typeof value === 'string') : [])
  )).join(' ');
}

function itemLabels(item) {
  const aliases = Array.isArray(item.aliases) ? item.aliases : [];
  const description = item.description ?? item.itemDescription;
  const relationships = relationshipText(item.relationships);
  return [
    { value: item.name, kind: 'name', weight: 1 },
    { value: item.item_key, kind: 'item_key', weight: 0.98 },
    ...aliases.map((value) => ({ value, kind: 'alias', weight: 0.98 })),
    { value: description, kind: 'description', weight: 0.7 },
    { value: relationships, kind: 'relationship', weight: 0.62 },
  ].filter((label) => typeof label.value === 'string' && label.value.trim())
    .map((label) => ({ ...label, value: label.value.trim() }));
}

function categoryCandidates(items, query) {
  const normalizedQuery = normalizeCatalogEntityText(query);
  const categories = new Map();
  for (const item of items) {
    const category = String(item.category ?? item.catalog_name ?? '').normalize('NFKC').trim();
    if (!category) continue;
    const categoryKey = String(item.categoryKey ?? item.category_key ?? '').normalize('NFKC').trim() || null;
    const identity = categoryKey ? `key:${normalizeCatalogEntityText(categoryKey)}` : `name:${normalizeCatalogEntityText(category)}`;
    const existing = categories.get(identity) ?? {
      category,
      categoryKey,
      parentCategoryKey: item.parentCategoryKey ?? item.parent_category_key ?? null,
      description: item.categoryDescription ?? item.category_description ?? null,
      selectionRules: item.categorySelectionRules ?? item.category_selection_rules ?? {},
      aliases: [],
      parentLabels: [],
      descriptions: [],
      relationshipLabels: [],
      items: [],
    };
    existing.items.push(item);
    existing.aliases.push(...(Array.isArray(item.categoryAliases) ? item.categoryAliases : []));
    existing.aliases.push(...(Array.isArray(item.category_aliases) ? item.category_aliases : []));
    existing.parentLabels.push(item.parentCategoryKey ?? item.parent_category_key ?? '');
    existing.descriptions.push(item.categoryDescription ?? item.category_description ?? '');
    existing.relationshipLabels.push(relationshipText(item.relationships));
    categories.set(identity, existing);
  }
  return [...categories.values()].map((candidate) => {
    let best = {
      ...catalogLabelSimilarity(query, candidate.category), matchedText: candidate.category,
      exactLabel: normalizedQuery === normalizeCatalogEntityText(candidate.category),
    };
    if (candidate.categoryKey) {
      const similarity = catalogLabelSimilarity(query, candidate.categoryKey);
      if (similarity.score > best.score) best = {
        ...similarity, matchedText: candidate.categoryKey,
        exactLabel: normalizedQuery === normalizeCatalogEntityText(candidate.categoryKey),
      };
    }
    for (const parentLabel of [...new Set(candidate.parentLabels.map((value) => String(value).trim()).filter(Boolean))]) {
      const similarity = catalogLabelSimilarity(query, parentLabel);
      const score = similarity.score * 0.75;
      if (score > best.score) best = { ...similarity, score, matchedText: parentLabel, matchedKind: 'parent_category_key' };
    }
    for (const alias of [...new Set(candidate.aliases.map((value) => String(value).trim()).filter(Boolean))]) {
      const similarity = catalogLabelSimilarity(query, alias);
      const exactLabel = normalizedQuery === normalizeCatalogEntityText(alias);
      if (exactLabel || similarity.score > best.score) best = { ...similarity, matchedText: alias, exactLabel };
    }
    for (const description of [...new Set(candidate.descriptions.map((value) => String(value).trim()).filter(Boolean))]) {
      const similarity = catalogLabelSimilarity(query, description);
      const score = similarity.score * 0.7;
      if (score > best.score) best = { ...similarity, score, matchedText: description, matchedKind: 'category_description' };
    }
    for (const relationship of [...new Set(candidate.relationshipLabels.map((value) => String(value).trim()).filter(Boolean))]) {
      const similarity = catalogLabelSimilarity(query, relationship);
      const score = similarity.score * 0.62;
      if (score > best.score) best = { ...similarity, score, matchedText: relationship, matchedKind: 'category_relationship' };
    }
    return {
      ...candidate,
      ...best,
      matchedKind: best.matchedText === candidate.category
        ? 'category'
        : best.matchedKind ?? (best.matchedText === candidate.categoryKey ? 'category_key' : 'category_alias'),
      entityType: 'category',
    };
  });
}

export function rankCatalogEntities(items, query) {
  if (!Array.isArray(items) || !String(query ?? '').trim()) return [];
  const normalizedQuery = normalizeCatalogEntityText(query);
  const itemCandidates = items.map((item) => {
    let best = { score: 0, method: 'none', matchedText: null, matchedKind: null, exactLabel: false };
    for (const label of itemLabels(item)) {
      const similarity = catalogLabelSimilarity(query, label.value);
      const score = similarity.score * label.weight;
      const exactLabel = ['name', 'item_key', 'alias'].includes(label.kind)
        && normalizedQuery === normalizeCatalogEntityText(label.value);
      if (exactLabel || score > best.score) {
        best = {
          ...similarity,
          score,
          matchedText: label.value,
          matchedKind: label.kind,
          exactLabel,
        };
      }
    }
    return { entityType: 'item', item, items: [item], ...best };
  });
  return [...itemCandidates, ...categoryCandidates(items, query)]
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => Number(right.exactLabel) - Number(left.exactLabel)
      || right.score - left.score
      || (left.entityType === right.entityType ? 0 : (left.entityType === 'item' ? -1 : 1))
      || String(left.item?.id ?? left.category).localeCompare(String(right.item?.id ?? right.category)));
}

function publicCandidate(candidate) {
  return {
    entityType: candidate.entityType,
    ...(candidate.entityType === 'item'
      ? { itemId: candidate.item.id, itemKey: candidate.item.item_key, name: candidate.item.name,
        category: candidate.item.category ?? candidate.item.catalog_name,
        categoryKey: candidate.item.category_key ?? null }
      : {
        category: candidate.category,
        categoryKey: candidate.categoryKey,
        parentCategoryKey: candidate.parentCategoryKey,
        name: candidate.category,
      }),
    confidence: Math.round(candidate.score * 10000) / 10000,
    method: candidate.method,
    matchedText: candidate.matchedText,
  };
}

export function classifyCatalogEntityLocally(items, query, {
  highConfidence = 0.86,
  clarificationConfidence = 0.64,
  ambiguityMargin = 0.06,
} = {}) {
  const ranked = rankCatalogEntities(items, query);
  const best = ranked[0];
  if (!best || best.score < clarificationConfidence) {
    return Object.freeze({ status: 'none', best: best ? publicCandidate(best) : null, candidates: [] });
  }
  const bestIdentity = best.entityType === 'item'
    ? `item:${best.item.id}`
    : `category:${normalizeCatalogEntityText(best.categoryKey ?? best.category)}`;
  const runnerUp = ranked.find((candidate) => (
    candidate.entityType === 'item'
      ? `item:${candidate.item.id}`
      : `category:${normalizeCatalogEntityText(candidate.categoryKey ?? candidate.category)}`
  ) !== bestIdentity);
  const runnerIsParentOfBest = Boolean(
    best.entityType === 'item'
    && runnerUp?.entityType === 'category'
    && normalizeCatalogEntityText(best.item.category_key ?? best.item.category)
      === normalizeCatalogEntityText(runnerUp.categoryKey ?? runnerUp.category)
    && best.score >= runnerUp.score,
  );
  const runnerIsChildOfBest = Boolean(
    best.entityType === 'category'
    && runnerUp?.entityType === 'item'
    && normalizeCatalogEntityText(runnerUp.item.category_key ?? runnerUp.item.category)
      === normalizeCatalogEntityText(best.categoryKey ?? best.category)
    && best.score >= runnerUp.score,
  );
  const runnerIsWeakPartial = Number(best.labelCoverage ?? 0) >= 0.8
    && Number(runnerUp?.labelCoverage ?? 0) > 0
    && Number(runnerUp.labelCoverage) <= Number(best.labelCoverage) - 0.4;
  const runnerHasWeakerQueryCoverage = Number(best.matchedQueryTokens ?? 0) >= 2
    && Number(best.matchedQueryTokens ?? 0)
      > Number(runnerUp?.matchedQueryTokens ?? 0)
    && Number(best.queryCoverage ?? 0) > Number(runnerUp?.queryCoverage ?? 0);
  // Category names are often broader than their child item names and voice STT
  // may omit one leading qualifier. Accept a strong multi-token category-label
  // match when it still leads an unrelated runner by a meaningful fraction of
  // the ambiguity margin. This remains tenant vocabulary driven: no category
  // names or caller phrases are encoded here.
  const categoryPhraseSupported = best.entityType === 'category'
    && ['category', 'category_key', 'category_alias'].includes(best.matchedKind)
    && best.score >= Math.max(clarificationConfidence, highConfidence - ambiguityMargin)
    && Number(best.matchedQueryTokens ?? 0) >= 2
    && Number(best.labelCoverage ?? 0) >= 0.5
    && runnerUp?.exactLabel !== true
    && (!runnerUp || best.score - runnerUp.score >= ambiguityMargin * 0.65);
  const ambiguous = Boolean(runnerUp && best.score - runnerUp.score < ambiguityMargin
    && !runnerIsParentOfBest && !runnerIsChildOfBest
    && !runnerIsWeakPartial && !runnerHasWeakerQueryCoverage && !categoryPhraseSupported);
  const hierarchySupportedCategory = best.entityType === 'category'
    && runnerIsChildOfBest
    && best.score >= Math.max(clarificationConfidence, highConfidence - ambiguityMargin);
  const status = (best.exactLabel
    || (!ambiguous && (best.score >= highConfidence
      || hierarchySupportedCategory || categoryPhraseSupported)))
    ? 'match' : 'uncertain';
  return Object.freeze({
    status,
    entityType: best.entityType,
    ...(best.entityType === 'item' ? { item: best.item } : {
      category: best.category,
      categoryKey: best.categoryKey,
      parentCategoryKey: best.parentCategoryKey,
      categoryDescription: best.description,
      categorySelectionRules: best.selectionRules,
      items: best.items,
    }),
    confidence: Math.round(best.score * 10000) / 10000,
    method: best.method,
    matchedText: best.matchedText,
    matchedKind: best.matchedKind,
    alternatives: ranked.slice(1, 3).map((candidate) => ({
      entityType: candidate.entityType,
      ...(candidate.entityType === 'item'
        ? { itemId: candidate.item.id, name: candidate.item.name }
        : { category: candidate.category, categoryKey: candidate.categoryKey }),
      confidence: Math.round(candidate.score * 10000) / 10000,
    })),
    candidates: ranked.slice(0, 3).map(publicCandidate),
    ambiguous,
  });
}

export function resolveCatalogEntityLocally(items, query, {
  minimumConfidence = 0.82,
  ambiguityMargin = 0.06,
} = {}) {
  const result = classifyCatalogEntityLocally(items, query, {
    highConfidence: minimumConfidence,
    clarificationConfidence: minimumConfidence,
    ambiguityMargin,
  });
  return result.status === 'match' ? result : null;
}

export function resolveCatalogEntitiesLocally(items, query, { minimumConfidence = 0.86 } = {}) {
  const seen = new Set();
  return rankCatalogEntities(items, query)
    .filter((candidate) => candidate.entityType === 'item' && candidate.score >= minimumConfidence)
    .filter((candidate) => {
      const id = String(candidate.item.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((candidate) => ({
      entityType: 'item', item: candidate.item,
      confidence: Math.round(candidate.score * 10000) / 10000,
      method: candidate.method, matchedText: candidate.matchedText,
    }));
}
