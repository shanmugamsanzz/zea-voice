const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const MAX_RULES_PER_CALL = 500;
const MAX_REPLACEMENTS_PER_TEXT = 1000;

const normalizedText = (value) => String(value ?? '').normalize('NFC');
const isWordCharacter = (value) => Boolean(value && WORD_CHARACTER.test(value));

function characterBefore(text, index) {
  if (index <= 0) return '';
  return Array.from(text.slice(0, index)).at(-1) ?? '';
}

function characterAfter(text, index) {
  if (index >= text.length) return '';
  return Array.from(text.slice(index))[0] ?? '';
}

function wholeWordMatch(text, start, length) {
  return !isWordCharacter(characterBefore(text, start))
    && !isWordCharacter(characterAfter(text, start + length));
}

function normalizedRule(rule, group, groupIndex, ruleIndex) {
  const sourceText = normalizedText(rule.sourceText ?? rule.writtenText ?? rule.source_text).trim();
  const spokenText = normalizedText(
    rule.spokenText ?? rule.spokenReplacement ?? rule.spoken_text,
  ).trim();
  if (!sourceText || !spokenText || rule.enabled === false) return null;
  return Object.freeze({
    id: rule.id ?? `${group.id ?? groupIndex}:${ruleIndex}`,
    groupId: group.id ?? null,
    groupName: group.name ?? null,
    sourceText,
    spokenText,
    matchType: rule.matchType === 'exact' || rule.match_type === 'exact' ? 'exact' : 'whole_word',
    caseSensitive: rule.caseSensitive === true || rule.case_sensitive === true,
    priority: Number.isInteger(Number(rule.priority)) ? Number(rule.priority) : 100,
    groupPriority: Number.isInteger(Number(group.priority)) ? Number(group.priority) : groupIndex * 100,
    order: ruleIndex,
  });
}

export function compilePronunciationRules(groups = []) {
  const list = Array.isArray(groups) ? groups : [];
  return Object.freeze(list.flatMap((group, groupIndex) => {
    if (!group || group.status === 'inactive' || group.status === 'archived') return [];
    const rules = Array.isArray(group.rules) ? group.rules : [];
    return rules.map((rule, ruleIndex) => normalizedRule(rule, group, groupIndex, ruleIndex)).filter(Boolean);
  }).sort((left, right) => left.groupPriority - right.groupPriority
    || left.priority - right.priority
    || right.sourceText.length - left.sourceText.length
    || left.order - right.order).slice(0, MAX_RULES_PER_CALL));
}

function matchesForRule(text, rule, rank) {
  const haystack = rule.caseSensitive ? text : text.toLocaleLowerCase('und');
  const needle = rule.caseSensitive ? rule.sourceText : rule.sourceText.toLocaleLowerCase('und');
  const matches = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length && matches.length < MAX_REPLACEMENTS_PER_TEXT) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) break;
    const accepted = rule.matchType === 'exact' || wholeWordMatch(text, start, needle.length);
    if (accepted) matches.push({ start, end: start + needle.length, rule, rank });
    cursor = start + Math.max(1, needle.length);
  }
  return matches;
}

export class PronunciationTextProcessor {
  constructor(groups = []) {
    this.rules = compilePronunciationRules(groups);
  }

  process(value) {
    const original = normalizedText(value);
    if (!original || !this.rules.length) {
      return { text: original, changed: false, replacementCount: 0, appliedRuleIds: [] };
    }
    const candidates = this.rules.flatMap((rule, rank) => matchesForRule(original, rule, rank))
      .sort((left, right) => left.start - right.start
        || left.rank - right.rank
        || (right.end - right.start) - (left.end - left.start));
    const accepted = [];
    let cursor = 0;
    for (const candidate of candidates) {
      if (accepted.length >= MAX_REPLACEMENTS_PER_TEXT) break;
      if (candidate.start < cursor) continue;
      accepted.push(candidate);
      cursor = candidate.end;
    }
    if (!accepted.length) {
      return { text: original, changed: false, replacementCount: 0, appliedRuleIds: [] };
    }
    let output = '';
    cursor = 0;
    const appliedRuleIds = new Set();
    for (const candidate of accepted) {
      output += original.slice(cursor, candidate.start);
      output += candidate.rule.spokenText;
      cursor = candidate.end;
      appliedRuleIds.add(candidate.rule.id);
    }
    output += original.slice(cursor);
    return {
      text: output,
      changed: output !== original,
      replacementCount: accepted.length,
      appliedRuleIds: [...appliedRuleIds],
    };
  }
}

export const createPronunciationTextProcessor = (configuration) => new PronunciationTextProcessor(
  configuration?.groups ?? configuration ?? [],
);
