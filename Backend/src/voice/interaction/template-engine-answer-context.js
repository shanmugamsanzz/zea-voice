import { normalizedSpeechBudget } from './template-engine-speech-budget.js';

function cleanText(value, maximum = 1_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function boundedRelevantConversation(turns = [], currentUtterance = '') {
  const current = cleanText(currentUtterance, 1_000).toLocaleLowerCase();
  const normalized = (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const role = turn?.role === 'assistant' ? 'assistant'
      : turn?.role === 'user' ? 'user' : null;
    const content = cleanText(turn?.content ?? turn?.text, 600);
    return role && content ? [{ role, content }] : [];
  });
  if (normalized.at(-1)?.role === 'user'
    && normalized.at(-1).content.toLocaleLowerCase() === current) normalized.pop();
  const selected = [];
  let characters = 0;
  for (let index = normalized.length - 1; index >= 0 && selected.length < 6; index -= 1) {
    const turn = normalized[index];
    if (characters + turn.content.length > 2_400) break;
    selected.unshift(Object.freeze(turn));
    characters += turn.content.length;
  }
  return Object.freeze(selected);
}

function verifiedActiveSubject(recordIds = [], evidence = []) {
  const requested = new Set((Array.isArray(recordIds) ? recordIds : [])
    .map((value) => cleanText(value, 160).toLocaleLowerCase()).filter(Boolean));
  if (!requested.size) return null;
  const entities = evidence.filter((entry) => requested.has(
    cleanText(entry?.recordId, 160).toLocaleLowerCase(),
  )).map((entry) => Object.freeze({
    recordId: entry.recordId,
    recordType: entry.recordType,
    canonicalName: entry.canonicalName ?? null,
    evidenceId: entry.evidenceId,
  }));
  if (!entities.length) return null;
  return Object.freeze({
    recordIds: Object.freeze(entities.map((entry) => entry.recordId)),
    entities: Object.freeze(entities),
  });
}

// Input has already passed scope verification. Keep every fact and operand;
// omit repeated storage/scope metadata only from the generation prompt. The
// original records remain available to coverage and grounding validators.
export function createTemplateEngineAnswerContext({
  evidence, latestUtterance, requestedFact, language, requestedEntityRecordIds = [],
  maximumSpeechCharacters, recentCompleteTurns = [], activeSubjectRecordIds = [],
}) {
  return {
    answerRequirements: {
      originalUtterance: latestUtterance,
      requestedFact,
      language: String(language ?? '').trim() || null,
      requestedEntityRecordIds: [...new Set(requestedEntityRecordIds)],
      maximumSpokenCharacters: normalizedSpeechBudget(maximumSpeechCharacters),
      budgetIncludes: ['response', 'nextQuestion', 'spaces', 'punctuation'],
      allowedEvidenceIds: evidence.map((entry) => entry.evidenceId),
    },
    conversationContext: boundedRelevantConversation(recentCompleteTurns, latestUtterance),
    activeSubject: verifiedActiveSubject(activeSubjectRecordIds, evidence),
    evidence: evidence.map((entry) => ({
      evidenceId: entry.evidenceId,
      recordId: entry.recordId,
      recordType: entry.recordType,
      canonicalName: entry.canonicalName,
      aliases: entry.aliases,
      relationships: entry.relationships,
      content: entry.content,
      authoritativeData: entry.authoritativeData,
      requestedFact: entry.requestedFact,
      publishedAttributePaths: entry.publishedAttributePaths,
    })),
  };
}

export const firstPassAnswerInstruction = [
  'Use answerRequirements as the first-pass checklist: cover every part of the original request, cite its supporting records and fit response plus nextQuestion within maximumSpokenCharacters. Perform this check internally, not as spoken reasoning.',
  'Lead with the requested answer and necessary qualifiers; omit preambles, repeated introductions and restating the question. Keep nextQuestion null unless guidance supports it and it fits without dropping requested facts.',
  'Use natural spoken sentences in the caller language, retaining technical published names where useful. Put citation aliases only in evidenceIds, not spoken text. Before returning JSON, check request coverage, operand identities, citations and total speech length.',
].join(' ');
