const genericQueryTokens = new Set([
  'a', 'an', 'and', 'about', 'available', 'cost', 'detail', 'details', 'explain', 'for', 'give',
  'health', 'how', 'i', 'in', 'info', 'information', 'is', 'item', 'me', 'much', 'of', 'option',
  'options', 'package', 'packages', 'plan', 'plans', 'please', 'price', 'product', 'products',
  'service', 'services', 'show', 'tell', 'the', 'to', 'want', 'what', 'with',
]);

export function normalizeCatalogEntityText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
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

export function catalogLabelSimilarity(query, label) {
  const normalizedQuery = normalizeCatalogEntityText(query);
  const normalizedLabel = normalizeCatalogEntityText(label);
  if (!normalizedQuery || !normalizedLabel) return { score: 0, method: 'none' };
  if (normalizedQuery === normalizedLabel) return { score: 1, method: 'normalized' };
  if (` ${normalizedQuery} `.includes(` ${normalizedLabel} `)) return { score: 0.99, method: 'normalized' };
  if (normalizedQuery.length >= 3 && ` ${normalizedLabel} `.includes(` ${normalizedQuery} `)) {
    return { score: 0.94, method: 'normalized' };
  }
  const queryTokens = meaningfulTokens(normalizedQuery);
  const labelTokens = meaningfulTokens(normalizedLabel);
  if (!queryTokens.length || !labelTokens.length) return { score: 0, method: 'none' };
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
  return { score: average * (0.72 + coverage * 0.28), method };
}

function itemLabels(item) {
  const aliases = Array.isArray(item.aliases) ? item.aliases : [];
  return [item.name, item.item_key, ...aliases]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => ({ value: value.trim(), kind: 'name', weight: 1 }));
}

function categoryCandidates(items, query) {
  const categories = new Map();
  for (const item of items) {
    const category = String(item.category ?? item.catalog_name ?? '').normalize('NFKC').trim();
    if (!category) continue;
    const key = normalizeCatalogEntityText(category);
    const existing = categories.get(key) ?? { category, items: [] };
    existing.items.push(item);
    categories.set(key, existing);
  }
  return [...categories.values()].map((candidate) => ({
    ...candidate,
    ...catalogLabelSimilarity(query, candidate.category),
    matchedText: candidate.category,
    matchedKind: 'category',
    entityType: 'category',
  }));
}

export function rankCatalogEntities(items, query) {
  if (!Array.isArray(items) || !String(query ?? '').trim()) return [];
  const itemCandidates = items.map((item) => {
    let best = { score: 0, method: 'none', matchedText: null, matchedKind: null };
    for (const label of itemLabels(item)) {
      const similarity = catalogLabelSimilarity(query, label.value);
      const score = similarity.score * label.weight;
      if (score > best.score) {
        best = { score, method: similarity.method, matchedText: label.value, matchedKind: label.kind };
      }
    }
    return { entityType: 'item', item, items: [item], ...best };
  });
  return [...itemCandidates, ...categoryCandidates(items, query)]
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || String(left.item?.id ?? left.category).localeCompare(String(right.item?.id ?? right.category)));
}

function publicCandidate(candidate) {
  return {
    entityType: candidate.entityType,
    ...(candidate.entityType === 'item'
      ? { itemId: candidate.item.id, name: candidate.item.name }
      : { category: candidate.category, name: candidate.category }),
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
  const bestIdentity = best.entityType === 'item' ? `item:${best.item.id}` : `category:${normalizeCatalogEntityText(best.category)}`;
  const runnerUp = ranked.find((candidate) => (
    candidate.entityType === 'item' ? `item:${candidate.item.id}` : `category:${normalizeCatalogEntityText(candidate.category)}`
  ) !== bestIdentity);
  const ambiguous = Boolean(runnerUp && best.score - runnerUp.score < ambiguityMargin);
  const status = best.score >= highConfidence && !ambiguous ? 'match' : 'uncertain';
  return Object.freeze({
    status,
    entityType: best.entityType,
    ...(best.entityType === 'item' ? { item: best.item } : { category: best.category, items: best.items }),
    confidence: Math.round(best.score * 10000) / 10000,
    method: best.method,
    matchedText: best.matchedText,
    matchedKind: best.matchedKind,
    alternatives: ranked.slice(1, 3).map((candidate) => ({
      entityType: candidate.entityType,
      ...(candidate.entityType === 'item'
        ? { itemId: candidate.item.id, name: candidate.item.name }
        : { category: candidate.category }),
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
