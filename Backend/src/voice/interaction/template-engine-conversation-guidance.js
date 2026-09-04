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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([rawKey, entry]) => {
      const key = normalized(rawKey).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
      return key ? [[key, entry]] : [];
    }));
  }
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((entry) => {
    const key = normalized(entry?.key).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
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

function characterNgrams(value, size = 3) {
  const compact = normalized(value).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);
  return new Set(Array.from({ length: compact.length - size + 1 }, (_, index) => (
    compact.slice(index, index + size)
  )));
}

function fuzzyPhraseScore(source, target) {
  // Character similarity is useful for short STT/phonetic variants, but on
  // longer sentences it can reward unrelated phrases that merely share
  // common character sequences. Long requests use semantic token coverage.
  if (tokens(source).size > 4 || tokens(target).size > 4) return 0;
  const left = characterNgrams(source);
  const right = characterNgrams(target);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return (2 * shared) / (left.size + right.size);
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
    ? record.entity_metadata
    : record?.entityMetadata && typeof record.entityMetadata === 'object'
      ? record.entityMetadata
      : record?.metadata && typeof record.metadata === 'object'
        ? record.metadata : record?.authoritativeData ?? {};
  const variables = variableMap(metadata.variables);
  const recordId = cleanText(record?.record_id ?? record?.recordId ?? record?.id, 200);
  const purpose = cleanText(variables.purpose ?? metadata.purpose, 1_500);
  const nextQuestion = cleanText(
    variables.nextquestion ?? metadata.nextQuestion ?? metadata.next_question, 1_500,
  ) || null;
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
    sequenceOrder: Number.isFinite(Number(metadata.sequenceOrder))
      ? Number(metadata.sequenceOrder) : null,
    isEntry: metadata.isEntry === true,
    content: cleanText(record?.content ?? record?.answer ?? metadata.content, 4_000) || null,
    language: cleanText(metadata.language ?? record?.language, 30) || 'und',
    intentClass: cleanText(
      variables.intentclass ?? metadata.intentClass ?? metadata.intent_class, 160,
    ) || null,
    purpose: purpose || null,
    situation: cleanText(variables.situation ?? metadata.situation, 2_000) || null,
    examples: Object.freeze(textList([
      ...textList(variables.examples ?? metadata.examples, 40),
      ...textList(record?.publicationAliases ?? record?.publication_aliases, 100),
      ...textList(record?.publicationSttForms ?? record?.publication_stt_forms, 100),
      ...textList(record?.publicationPhoneticForms ?? record?.publication_phonetic_forms, 100),
      ...textList(record?.publicationUseCasePhrases ?? record?.publication_use_case_phrases, 100),
    ], 200)),
    context: cleanText(variables.context ?? metadata.context, 300) || null,
    catalogReferences: Object.freeze(textList(
      variables.catalogreferences ?? metadata.catalogReferences ?? metadata.catalog_references, 100,
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
    candidate.content,
    ...candidate.examples,
    ...candidate.catalogReferences,
  ].filter(Boolean).join(' ');
}

function identifierText(value) {
  return cleanText(value, 500).replace(/[_:/.-]+/gu, ' ');
}

function signalScore(signal, candidate) {
  const value = identifierText(signal);
  if (!value) return 0;
  return overlapScore(value, [
    identifierText(candidate.nodeKey), identifierText(candidate.intentClass),
    identifierText(candidate.context), candidate.purpose, candidate.situation,
  ].filter(Boolean).join(' '));
}

function tokenCoverage(source, target) {
  const sourceTokens = tokens(source);
  if (!sourceTokens.size) return 0;
  const targetTokens = tokens(target);
  let shared = 0;
  for (const token of sourceTokens) if (targetTokens.has(token)) shared += 1;
  return shared / sourceTokens.size;
}

function overviewGuidance(candidate) {
  const structuralSignals = [
    identifierText(candidate.intentClass), identifierText(candidate.nodeKey),
    identifierText(candidate.nodeType), identifierText(candidate.context),
  ].filter(Boolean).join(' ');
  return tokens(structuralSignals).has('overview');
}

function explicitEntityRequest(latestUtterance, searchInterpretation) {
  const reference = cleanText(searchInterpretation?.contextualReference, 500);
  return Boolean(reference) && tokenCoverage(reference, latestUtterance) >= 0.67;
}

function evidenceIdentityText(evidence) {
  return (Array.isArray(evidence) ? evidence : []).filter((entry) => (
    entry?.recordType !== 'CONVERSATION_NODE'
  )).flatMap((entry) => [
    entry?.recordId, entry?.canonicalName, entry?.authoritativeData?.name,
    entry?.authoritativeData?.category, entry?.authoritativeData?.categoryKey,
    entry?.authoritativeData?.itemKey,
  ]).filter(Boolean).join(' ');
}

export function selectApplicableConversationGuidance({
  publishedConversationGuidance = [], scope = {}, latestUtterance, finalDecision = null,
  searchInterpretation = null, evidence = [], recentCompleteTurns = [],
  currentIntent = null, conversationStage = null, language = null,
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
  const evidenceText = evidenceSearchText(evidence);
  const evidenceIdentities = evidenceIdentityText(evidence);
  const namedEntityRequest = explicitEntityRequest(latestUtterance, searchInterpretation);
  const normalizedRequest = normalized(requestText);
  const evidenceRecordIds = new Set((Array.isArray(evidence) ? evidence : [])
    .filter((entry) => entry?.recordType === 'CONVERSATION_NODE')
    .map((entry) => cleanText(entry.recordId ?? entry.id, 200)).filter(Boolean));
  const compatibleCandidates = candidates.filter((candidate) => {
    if (namedEntityRequest && overviewGuidance(candidate)) return false;
    if (!namedEntityRequest || !candidate.catalogReferences.length || !evidenceIdentities) {
      return true;
    }
    return overlapScore(candidate.catalogReferences.join(' '), evidenceIdentities) > 0;
  });
  if (!compatibleCandidates.length) return null;
  const ranked = compatibleCandidates.map((candidate) => {
    const semanticText = candidateText(candidate);
    const exampleMatch = candidate.examples.some((example) => {
      const normalizedExample = normalized(example);
      return normalizedExample && (normalizedRequest.includes(normalizedExample)
        || normalizedExample.includes(normalizedRequest));
    });
    const exampleCompatibility = candidate.examples.reduce((maximum, example) => Math.max(
      maximum,
      overlapScore(requestText, example),
      fuzzyPhraseScore(latestUtterance, example),
    ), 0);
    const reasons = [];
    const evidenceRecordMatch = evidenceRecordIds.has(candidate.recordId);
    const intentCompatibility = signalScore(
      currentIntent ?? searchInterpretation?.requestedFact, candidate,
    );
    const requestedFactCompatibility = overlapScore(
      searchInterpretation?.requestedFact, semanticText,
    );
    const stageCompatibility = signalScore(conversationStage, candidate);
    const requestCompatibility = overlapScore(requestText, semanticText);
    const evidenceCompatibility = overlapScore(
      evidenceText, [...candidate.catalogReferences, semanticText].join(' '),
    );
    const contextCompatibility = overlapScore(contextualText, semanticText);
    const languageMatch = language && candidate.language !== 'und'
      && normalized(language).split('-')[0] === normalized(candidate.language).split('-')[0];
    if (evidenceRecordMatch) reasons.push('retrieved_guidance_record');
    if (exampleMatch) reasons.push('semantic_example_match');
    else if (exampleCompatibility > 0.2) reasons.push('semantic_example_compatible');
    if (intentCompatibility > 0) reasons.push('intent_compatible');
    if (requestedFactCompatibility > 0) reasons.push('requested_fact_compatible');
    if (stageCompatibility > 0) reasons.push('stage_compatible');
    if (evidenceCompatibility > 0) reasons.push('evidence_compatible');
    if (contextCompatibility > 0) reasons.push('recent_turn_compatible');
    if (languageMatch) reasons.push('language_compatible');
    const score = (evidenceRecordMatch ? 40 : 0)
      + (exampleMatch ? 20 : 0)
      + exampleCompatibility * 18
      + intentCompatibility * 24
      + requestedFactCompatibility * 24
      + stageCompatibility * 20
      + requestCompatibility * 12
      + evidenceCompatibility * 12
      + contextCompatibility * 3
      + (languageMatch ? 2 : 0);
    return { candidate, score, reasons };
  }).sort((left, right) => right.score - left.score
    || left.candidate.recordId.localeCompare(right.candidate.recordId));
  if (ranked[0].score <= 0) return null;
  return Object.freeze({
    recordId: ranked[0].candidate.recordId,
    recordType: ranked[0].candidate.recordType,
    tenantId: ranked[0].candidate.tenantId,
    agentId: ranked[0].candidate.agentId,
    knowledgeBaseId: ranked[0].candidate.knowledgeBaseId,
    publicationRevision: ranked[0].candidate.publicationRevision,
    content: ranked[0].candidate.content,
    purpose: ranked[0].candidate.purpose,
    nextQuestion: ranked[0].candidate.nextQuestion,
    intentClass: ranked[0].candidate.intentClass,
    nodeKey: ranked[0].candidate.nodeKey,
    flowKey: ranked[0].candidate.flowKey,
    catalogReferences: ranked[0].candidate.catalogReferences,
    sequenceOrder: ranked[0].candidate.sequenceOrder,
    conversationStage: cleanText(conversationStage, 160) || null,
    selectionScore: Number(ranked[0].score.toFixed(4)),
    selectionReasons: Object.freeze(ranked[0].reasons),
  });
}

export function sanitizeConversationGuidance(value) {
  if (!value || typeof value !== 'object') return null;
  const recordId = cleanText(value.recordId, 200);
  const purpose = cleanText(value.purpose, 1_500);
  const nextQuestion = cleanText(value.nextQuestion, 1_500) || null;
  if (!recordId || !purpose) return null;
  return Object.freeze({
    recordId, purpose, nextQuestion,
    recordType: cleanText(value.recordType, 80) || null,
    tenantId: cleanText(value.tenantId, 160) || null,
    agentId: cleanText(value.agentId, 160) || null,
    knowledgeBaseId: cleanText(value.knowledgeBaseId, 160) || null,
    publicationRevision: Number.isInteger(Number(value.publicationRevision))
      ? Number(value.publicationRevision) : null,
    content: cleanText(value.content, 4_000) || null,
    catalogReferences: Object.freeze(textList(value.catalogReferences, 100)),
    intentClass: cleanText(value.intentClass, 160) || null,
    nodeKey: cleanText(value.nodeKey, 160) || null,
    flowKey: cleanText(value.flowKey, 160) || null,
    conversationStage: cleanText(value.conversationStage, 160) || null,
  });
}
