const maximumGuidanceCandidates = 200;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalized(value) {
  return cleanText(value).toLocaleLowerCase();
}

function textList(value, maximum = 100) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(source.map((entry) => cleanText(entry, 500)).filter(Boolean))]
    .slice(0, maximum);
}

function variableMap(value) {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((entry) => {
    const key = cleanText(entry?.key, 100);
    return key ? [[key, entry?.value]] : [];
  }));
}

function tokens(value) {
  return new Set(normalized(value).split(/[^\p{L}\p{M}\p{N}]+/gu)
    .map((token) => token.trim()).filter((token) => token.length > 1));
}

function overlapScore(source, target) {
  const sourceTokens = tokens(source);
  const targetTokens = tokens(target);
  if (!sourceTokens.size || !targetTokens.size) return 0;
  let shared = 0;
  for (const token of sourceTokens) if (targetTokens.has(token)) shared += 1;
  return shared / Math.sqrt(sourceTokens.size * targetTokens.size);
}

function scoped(record, scope) {
  if (!record || typeof record !== 'object' || record.published !== true) return false;
  if (normalized(record.tenantId) !== normalized(scope?.tenantId)) return false;
  if (record.agentId && normalized(record.agentId) !== normalized(scope?.agentId)) return false;
  return (scope?.publications ?? []).some((publication) => (
    normalized(publication.knowledgeBaseId) === normalized(record.knowledgeBaseId)
      && Number(publication.publicationRevision) === Number(record.publicationRevision)
  ));
}

export function normalizePublishedConversationGuidance(record, publication, agentId) {
  const recordType = cleanText(record?.record_type ?? record?.recordType, 80).toUpperCase();
  if (!['CONVERSATION', 'CONVERSATION_NODE'].includes(recordType)) return null;
  const metadata = record?.entity_metadata && typeof record.entity_metadata === 'object'
    ? record.entity_metadata : record?.authoritativeData ?? {};
  const variables = variableMap(metadata.variables);
  const recordId = cleanText(record?.record_id ?? record?.recordId ?? record?.id, 200);
  const purpose = cleanText(variables.purpose ?? metadata.purpose, 1_500);
  const nextQuestion = cleanText(variables.nextQuestion ?? metadata.nextQuestion, 1_500) || null;
  if (!recordId || (!purpose && !nextQuestion)) return null;
  return Object.freeze({
    recordId,
    recordType: 'CONVERSATION_NODE',
    tenantId: publication?.tenantId,
    agentId,
    knowledgeBaseId: publication?.knowledgeBaseId,
    publicationRevision: Number(publication?.publicationRevision),
    published: true,
    flowKey: cleanText(metadata.flowKey, 160) || null,
    nodeKey: cleanText(metadata.nodeKey, 160) || null,
    nodeType: cleanText(metadata.nodeType, 80) || null,
    language: cleanText(metadata.language ?? record?.language, 30) || 'und',
    intentClass: cleanText(variables.intentClass ?? metadata.intentClass, 160) || null,
    purpose: purpose || null,
    situation: cleanText(variables.situation ?? metadata.situation, 2_000) || null,
    examples: Object.freeze(textList(variables.examples ?? metadata.examples, 40)),
    context: cleanText(variables.context ?? metadata.context, 300) || null,
    catalogReferences: Object.freeze(textList(
      variables.catalogReferences ?? metadata.catalogReferences, 100,
    )),
    nextQuestion,
  });
}

function evidenceSearchText(evidence) {
  return (Array.isArray(evidence) ? evidence : []).flatMap((entry) => [
    entry?.canonicalName,
    entry?.recordType,
    entry?.authoritativeData?.name,
    entry?.authoritativeData?.category,
    entry?.authoritativeData?.categoryKey,
    entry?.authoritativeData?.itemKey,
  ]).filter(Boolean).join(' ');
}

function recentTurnText(turns) {
  return (Array.isArray(turns) ? turns : []).slice(-10)
    .map((turn) => cleanText(turn?.content ?? turn?.text, 1_000)).filter(Boolean).join(' ');
}

function candidateText(candidate) {
  return [
    candidate.nodeKey,
    candidate.intentClass,
    candidate.purpose,
    candidate.situation,
    candidate.context,
    ...candidate.examples,
    ...candidate.catalogReferences,
  ].filter(Boolean).join(' ');
}

export function selectApplicableConversationGuidance({
  publishedConversationGuidance = [], scope = {}, latestUtterance, finalDecision = null,
  searchInterpretation = null, evidence = [], recentCompleteTurns = [],
} = {}) {
  const candidates = publishedConversationGuidance.filter((entry) => scoped(entry, scope))
    .slice(0, maximumGuidanceCandidates);
  if (!candidates.length) return null;
  const requestText = [
    latestUtterance,
    finalDecision,
    searchInterpretation?.query,
    searchInterpretation?.requestedFact,
    searchInterpretation?.contextualReference,
    evidenceSearchText(evidence),
  ].filter(Boolean).join(' ');
  const contextualText = recentTurnText(recentCompleteTurns);
  const normalizedRequest = normalized(requestText);
  const evidenceRecordIds = new Set((Array.isArray(evidence) ? evidence : [])
    .filter((entry) => entry?.recordType === 'CONVERSATION_NODE')
    .map((entry) => cleanText(entry.recordId ?? entry.id, 200)).filter(Boolean));
  const ranked = candidates.map((candidate) => {
    const semanticText = candidateText(candidate);
    const exampleMatch = candidate.examples.some((example) => {
      const normalizedExample = normalized(example);
      return normalizedExample && (normalizedRequest.includes(normalizedExample)
        || normalizedExample.includes(normalizedRequest));
    });
    const score = (evidenceRecordIds.has(candidate.recordId) ? 100 : 0)
      + (exampleMatch ? 8 : 0)
      + overlapScore(requestText, semanticText) * 10
      + overlapScore(contextualText, semanticText) * 2;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score
    || left.candidate.recordId.localeCompare(right.candidate.recordId));
  if (ranked[0].score <= 0) return null;
  return Object.freeze({
    recordId: ranked[0].candidate.recordId,
    purpose: ranked[0].candidate.purpose,
    nextQuestion: ranked[0].candidate.nextQuestion,
  });
}

export function sanitizeConversationGuidance(value) {
  if (!value || typeof value !== 'object') return null;
  const recordId = cleanText(value.recordId, 200);
  const purpose = cleanText(value.purpose, 1_500);
  const nextQuestion = cleanText(value.nextQuestion, 1_500) || null;
  if (!recordId || !purpose) return null;
  return Object.freeze({ recordId, purpose, nextQuestion });
}
