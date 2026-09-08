import { normalizedSpeechBudget } from './template-engine-speech-budget.js';

// Input has already passed scope verification. Keep every fact and operand;
// omit repeated storage/scope metadata only from the generation prompt. The
// original records remain available to coverage and grounding validators.
export function createTemplateEngineAnswerContext({
  evidence, latestUtterance, requestedFact, language, requestedEntityRecordIds = [],
  maximumSpeechCharacters,
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
