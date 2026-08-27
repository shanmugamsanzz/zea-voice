import { typedRecordIdentityKey } from './canonical-record-identity.js';

export const CONTEXTUAL_QUERY_UNDERSTANDING_VERSION = 1;

const catalogRecordTypes = new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']);
const catalogEntityTypes = new Set(['ITEM', 'CATEGORY']);
const protocolIntentClasses = new Set(['SAFETY_EMERGENCY', 'CALL_CONTROL']);

function clean(value, maximum = 240) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function unique(values, maximum = 20) {
  return Object.freeze([...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value)).filter(Boolean))].slice(0, maximum));
}

function boundedScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function isCatalogCandidate(candidate) {
  return catalogEntityTypes.has(String(candidate?.entityType ?? '').toLocaleUpperCase())
    || catalogRecordTypes.has(String(candidate?.recordType ?? '').toLocaleUpperCase());
}

function candidateIdentity(candidate) {
  return typedRecordIdentityKey(candidate)
    ?? clean(candidate?.itemKey ?? candidate?.categoryKey ?? candidate?.label ?? candidate?.name, 160);
}


function candidateNamespace(candidate) {
  const recordType = String(candidate?.recordType ?? '').toLocaleUpperCase();
  if (catalogRecordTypes.has(recordType) || catalogEntityTypes.has(
    String(candidate?.entityType ?? '').toLocaleUpperCase(),
  )) return 'CATALOG';
  if (recordType === 'FAQ') return 'FAQ';
  if (recordType === 'CONVERSATION_NODE') return 'CONVERSATION';
  if (recordType === 'WORKFLOW_RULE') return 'WORKFLOW';
  if (recordType === 'KNOWLEDGE_CHUNK') return 'GENERAL';
  return clean(candidate?.namespace, 80).toLocaleUpperCase() || null;
}

function candidateLabel(candidate) {
  return clean(candidate?.label ?? candidate?.name ?? candidate?.entityName
    ?? candidate?.category ?? candidate?.itemKey ?? candidate?.categoryKey
    ?? candidate?.recordId, 240);
}

function candidateSummary(candidate) {
  if (!candidate || !candidateIdentity(candidate)) return null;
  const entityType = String(candidate.entityType
    ?? (String(candidate.recordType).toLocaleUpperCase() === 'CATALOG_CATEGORY'
      ? 'CATEGORY' : (isCatalogCandidate(candidate) ? 'ITEM' : 'ROUTE')))
    .toLocaleUpperCase();
  return Object.freeze({
    recordId: clean(candidate.recordId ?? candidate.id, 160) || null,
    recordType: clean(candidate.recordType, 80).toLocaleUpperCase() || null,
    entityType,
    key: clean(entityType === 'CATEGORY'
      ? candidate.categoryKey ?? candidate.key
      : candidate.itemKey ?? candidate.key, 160) || null,
    name: candidateLabel(candidate) || null,
    categoryKey: clean(candidate.categoryKey, 160) || null,
    score: boundedScore(candidate.score),
    explicit: candidate.explicit === true,
    intentClass: clean(candidate.intentClass, 80).toLocaleUpperCase() || null,
  });
}

function explicitSignalPhrases(candidate) {
  const score = boundedScore(candidate?.score);
  return unique((candidate?.signals ?? []).filter((signal) => (
    signal?.explicit === true
      && clean(signal.phrase)
      && boundedScore(signal.score) >= Math.max(0.68, score - 0.01)
  )).map((signal) => normalized(signal.phrase)), 8);
}

function phraseSignature(candidate) {
  return [...explicitSignalPhrases(candidate)].sort().join('|');
}

function catalogCandidates(resolution) {
  const namespaced = resolution?.namespaceCandidates?.CATALOG;
  const values = Array.isArray(namespaced)
    ? namespaced : (resolution?.routingCandidates ?? []);
  const output = [];
  const seen = new Set();
  for (const candidate of values) {
    const identity = normalized(candidateIdentity(candidate));
    if (!identity || seen.has(identity) || !isCatalogCandidate(candidate)) continue;
    seen.add(identity);
    output.push(candidate);
  }
  return output.sort((left, right) => boundedScore(right.score) - boundedScore(left.score));
}

function explicitCatalogCandidates(resolution) {
  return catalogCandidates(resolution).filter((candidate) => (
    candidate.explicit === true
      && boundedScore(candidate.score) >= 0.88
      && explicitSignalPhrases(candidate).length > 0
  ));
}

function distinctMentionCandidates(candidates) {
  const selected = new Map();
  for (const candidate of candidates) {
    const signature = phraseSignature(candidate);
    if (!signature) continue;
    const current = selected.get(signature);
    if (!current || boundedScore(candidate.score) > boundedScore(current.score)) {
      selected.set(signature, candidate);
    }
  }
  return [...selected.values()];
}

function routeCandidates(resolution) {
  return Object.entries(resolution?.namespaceCandidates ?? {}).flatMap(([namespace, candidates]) => (
    namespace === 'CATALOG' || !Array.isArray(candidates) ? [] : candidates
  ));
}

function explicitCurrentRoute(resolution) {
  return routeCandidates(resolution).find((candidate) => (
    candidate?.explicit === true && boundedScore(candidate.score) >= 0.88
  )) ?? null;
}

function currentNonCatalogSignal(resolution) {
  return routeCandidates(resolution).find((candidate) => (
    candidate?.explicit === true && boundedScore(candidate.score) >= 0.68
  )) ?? null;
}

function activeMemoryEntity(memory = {}) {
  const entity = memory.activeEntity;
  if (entity && typeof entity === 'object') return Object.freeze({
    recordId: clean(entity.recordId ?? entity.id, 160) || null,
    key: clean(entity.itemKey ?? entity.key, 160) || null,
    name: clean(entity.name ?? entity.label, 240) || null,
    entityType: 'ITEM',
  });
  const category = memory.activeCategory;
  if (category && typeof category === 'object') return Object.freeze({
    recordId: clean(category.recordId ?? category.id, 160) || null,
    key: clean(category.categoryKey ?? category.key, 160) || null,
    name: clean(category.name ?? category.category, 240) || null,
    entityType: 'CATEGORY',
  });
  return null;
}

function ambiguityFor(resolution, explicitCandidates) {
  const relevant = explicitCandidates.length
    ? explicitCandidates
    : (resolution?.routingCandidates ?? []).filter((candidate) => candidate?.explicit === true);
  const top = relevant[0] ?? resolution?.candidate ?? null;
  const second = relevant[1] ?? resolution?.alternatives?.[0] ?? null;
  const namespace = candidateNamespace(top);
  const sameNamespace = Boolean(namespace) && namespace === candidateNamespace(second);
  const closeScores = top && second
    && Math.abs(boundedScore(top.score) - boundedScore(second.score)) <= 0.08;
  const detected = resolution?.action === 'CONFIRM'
    && Boolean(top) && Boolean(second) && sameNamespace && closeScores;
  return Object.freeze({
    detected,
    reason: detected ? 'close_authoritative_candidates' : null,
    candidates: Object.freeze((detected ? [top, second] : [])
      .map(candidateSummary).filter(Boolean)),
  });
}

function actionUnderstanding(input, resolution) {
  const memoryTool = input?.memory?.activeTool;
  const workflow = [
    resolution?.candidate,
    ...(resolution?.namespaceCandidates?.WORKFLOW ?? []),
  ].find((candidate) => (
    String(candidate?.intentClass ?? '').toLocaleUpperCase() === 'ACTION_TOOL_REQUEST'
      && candidate?.explicit === true && boundedScore(candidate.score) >= 0.88
  ));
  const detected = Boolean(memoryTool?.name || workflow);
  return Object.freeze({
    detected,
    source: memoryTool?.name ? 'active_tool' : (workflow ? 'published_workflow' : null),
    actionKey: clean(memoryTool?.name ?? workflow?.actionKey ?? workflow?.action, 120) || null,
    authorizationRecordId: clean(memoryTool?.authorizationRecordId
      ?? workflow?.recordId, 160) || null,
  });
}

export function understandContextualKnowledgeQuery(input, resolution) {
  if (!input?.tenantId || !input?.agentId || !input?.callId || !input?.utterance) {
    throw new TypeError('Contextual query understanding requires a finalized scoped input');
  }
  if (!resolution || normalized(resolution.tenantId) !== normalized(input.tenantId)) {
    throw new TypeError('Contextual query understanding requires same-tenant resolution');
  }
  const explicitCandidates = explicitCatalogCandidates(resolution);
  const mentionedCandidates = distinctMentionCandidates(catalogCandidates(resolution).filter((candidate) => (
    candidate.explicit === true
      && boundedScore(candidate.score) >= 0.68
      && explicitSignalPhrases(candidate).length > 0
  )));
  const explicitEntities = explicitCandidates.filter((candidate) => (
    String(candidate.entityType ?? '').toLocaleUpperCase() !== 'CATEGORY'
      && String(candidate.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_CATEGORY'
  )).map(candidateSummary).filter(Boolean).slice(0, 5);
  const explicitCategories = explicitCandidates.filter((candidate) => (
    String(candidate.entityType ?? '').toLocaleUpperCase() === 'CATEGORY'
      || String(candidate.recordType ?? '').toLocaleUpperCase() === 'CATALOG_CATEGORY'
  )).map(candidateSummary).filter(Boolean).slice(0, 5);
  const requestedFacts = unique([
    ...(input.requestedFacts ?? []),
    input.memory?.pendingClarification?.missingFactType,
  ]);
  const route = explicitCurrentRoute(resolution);
  const currentRouteSignal = route ?? currentNonCatalogSignal(resolution);
  const protocolRoute = protocolIntentClasses.has(
    String(currentRouteSignal?.intentClass ?? '').toLocaleUpperCase(),
  );
  const memoryEntity = activeMemoryEntity(input.memory);
  const hasCurrentEntitySignal = explicitCandidates.length > 0;
  const hasCurrentNonCatalogSignal = Boolean(currentRouteSignal);
  const contextDependent = !hasCurrentEntitySignal && !hasCurrentNonCatalogSignal && Boolean(
    memoryEntity || input.memory?.pendingClarification || input.memory?.activeTool,
  );
  const contextualReferences = unique([
    ...(input.contextualReferences ?? []),
    ...(contextDependent && memoryEntity
      ? [memoryEntity.entityType === 'CATEGORY' ? 'active_category' : 'active_entity'] : []),
    ...(contextDependent && input.memory?.pendingClarification ? ['pending_clarification'] : []),
    ...(contextDependent && input.memory?.activeTool ? ['active_tool'] : []),
  ]);
  const currentQuestion = normalized(input.latestQuestion ?? input.utterance);
  const canonicalNameMentions = catalogCandidates(resolution).filter((candidate) => {
    const label = normalized(candidateLabel(candidate));
    return candidate.explicit === true && label && currentQuestion.includes(label);
  });
  const comparisonRequested = requestedFacts.map(normalized).includes('comparison')
    || canonicalNameMentions.length > 1 || explicitCandidates.length > 1;
  const comparisonTopScore = Math.max(0, ...mentionedCandidates.map((candidate) => (
    boundedScore(candidate.score)
  )));
  const comparisonMentions = mentionedCandidates.filter((candidate) => (
    boundedScore(candidate.score) >= comparisonTopScore - 0.08
      || currentQuestion.includes(normalized(candidateLabel(candidate)))
      || explicitSignalPhrases(candidate).some((phrase) => currentQuestion.includes(phrase))
  ));
  const comparisonPool = [...new Map([
    ...comparisonMentions, ...canonicalNameMentions,
  ].map((candidate) => [normalized(candidateIdentity(candidate)), candidate])).values()];
  const comparisonCandidates = comparisonRequested
    ? (comparisonPool.length > 1 ? comparisonPool : explicitCandidates)
    : [];
  const ambiguity = ambiguityFor(resolution, explicitCandidates);
  const actionIntent = actionUnderstanding(input, resolution);
  const canonicalContext = hasCurrentEntitySignal && !ambiguity.detected
    ? candidateSummary(mentionedCandidates[0] ?? explicitCandidates[0])
    : (contextDependent ? memoryEntity : null);
  return Object.freeze({
    version: CONTEXTUAL_QUERY_UNDERSTANDING_VERSION,
    tenantId: String(input.tenantId),
    agentId: String(input.agentId),
    callId: String(input.callId),
    latestQuestion: clean(input.latestQuestion ?? input.utterance, 2_000),
    explicitEntities: Object.freeze(explicitEntities),
    explicitCategories: Object.freeze(explicitCategories),
    comparisonEntities: Object.freeze(comparisonCandidates
      .map(candidateSummary).filter(Boolean).slice(0, 5)),
    contextualReferences,
    requestedFact: requestedFacts[0] ?? null,
    requestedFacts,
    requestedFactSource: requestedFacts.length
      ? (input.requestedFacts?.length ? 'caller_signal' : 'pending_clarification')
      : 'grounded_llm',
    requiresGroundedFactInterpretation: requestedFacts.length === 0,
    actionIntent,
    ambiguity,
    contextDependent,
    canonicalContext,
    explicitCurrentRoute: route ? candidateSummary(route) : null,
    currentRouteSignal: currentRouteSignal ? candidateSummary(currentRouteSignal) : null,
    protocolPriority: protocolRoute,
  });
}

