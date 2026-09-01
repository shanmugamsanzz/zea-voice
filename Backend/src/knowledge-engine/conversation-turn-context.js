export const MAXIMUM_CONTEXT_TURN_PAIRS = 10;

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function message(value) {
  const role = value?.role === 'assistant' ? 'assistant'
    : (value?.role === 'user' ? 'user' : null);
  const content = clean(value?.content);
  return role && content ? Object.freeze({ role, content }) : null;
}

function words(value) {
  return new Set(clean(value).toLocaleLowerCase().split(/[^\p{L}\p{M}\p{N}]+/gu)
    .filter((word) => word.length > 1));
}

export function completeConversationTurnPairs(values = []) {
  const pairs = [];
  let caller = null;
  for (const entry of Array.isArray(values) ? values : []) {
    const normalized = message(entry);
    if (!normalized) continue;
    if (normalized.role === 'user') {
      caller = normalized;
    } else if (caller) {
      pairs.push(Object.freeze({ caller, agent: normalized }));
      caller = null;
    }
  }
  return Object.freeze(pairs);
}

export function flattenConversationTurnPairs(pairs = []) {
  return Object.freeze((Array.isArray(pairs) ? pairs : []).flatMap((pair) => (
    pair?.caller && pair?.agent ? [pair.caller, pair.agent] : []
  )));
}

export function selectCompleteConversationTurns(values = [], {
  mode = 'last_n_turns', recentTurns = 5, currentQuestion = '', contextTerms = [],
  maximumPairs = MAXIMUM_CONTEXT_TURN_PAIRS,
} = {}) {
  const pairs = completeConversationTurnPairs(values);
  const boundedMaximum = Math.max(1, Math.min(
    MAXIMUM_CONTEXT_TURN_PAIRS, Number(maximumPairs) || MAXIMUM_CONTEXT_TURN_PAIRS,
  ));
  if (mode !== 'full_current_call') {
    const configured = Math.max(1, Math.min(
      boundedMaximum, Number(recentTurns) || 5,
    ));
    return flattenConversationTurnPairs(pairs.slice(-configured));
  }

  const queryWords = words([currentQuestion, ...(Array.isArray(contextTerms)
    ? contextTerms : [])].join(' '));
  const ranked = pairs.map((pair, index) => {
    const pairWords = words(`${pair.caller.content} ${pair.agent.content}`);
    const overlap = [...queryWords].filter((word) => pairWords.has(word)).length;
    return { pair, index, score: overlap * 100 + index / Math.max(1, pairs.length) };
  }).sort((left, right) => right.score - left.score);
  const selected = [];
  // Contextual follow-ups may share no lexical token with the earlier topic.
  // Reserve the two most recent complete pairs before relevance ranking so a
  // large number of older lexical matches cannot evict the natural reference
  // anchor for "its price", "the last one", or an action follow-up.
  for (let index = pairs.length - 1; index >= 0
    && selected.length < Math.min(2, pairs.length, boundedMaximum); index -= 1) {
    if (!selected.some((entry) => entry.index === index)) {
      selected.push({ pair: pairs[index], index, score: index / Math.max(1, pairs.length) });
    }
  }
  for (const entry of ranked) {
    if (entry.score < 100 || selected.length >= boundedMaximum) break;
    if (!selected.some((candidate) => candidate.index === entry.index)) selected.push(entry);
  }
  return flattenConversationTurnPairs(selected.slice(0, boundedMaximum)
    .sort((left, right) => left.index - right.index).map((entry) => entry.pair));
}
