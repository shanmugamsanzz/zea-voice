import { typedRecordIdentityKey } from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';
import { compactNeedContext } from './published-use-case-signals.js';

export const CONTEXTUAL_QUERY_UNDERSTANDING_VERSION = 5;

const catalogRecordTypes = new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']);
const catalogEntityTypes = new Set(['ITEM', 'CATEGORY']);
const protocolIntentClasses = new Set(['SAFETY_EMERGENCY', 'CALL_CONTROL']);
const authoritativeMentionMethods = new Set(['exact', 'normalized', 'tenant_alias', 'stt']);
const approximateMentionMethods = new Set(['phonetic', 'fuzzy']);

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

function candidateSummary(candidate, suppliedConfidenceConfiguration = {}) {
  if (!candidate || !candidateIdentity(candidate)) return null;
  const entityType = String(candidate.entityType
    ?? (String(candidate.recordType).toLocaleUpperCase() === 'CATALOG_CATEGORY'
      ? 'CATEGORY' : (isCatalogCandidate(candidate) ? 'ITEM' : 'ROUTE')))
    .toLocaleUpperCase();
  const score = boundedScore(candidate.score);
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    suppliedConfidenceConfiguration,
  );
  const matchedSignal = [...(candidate.signals ?? [])]
    .filter((signal) => signal?.explicit === true && clean(signal.phrase))
    .sort((left, right) => boundedScore(right.score) - boundedScore(left.score))[0] ?? null;
  const matchMethod = clean(matchedSignal?.method ?? candidate.method, 80).toLocaleLowerCase()
    || null;
  return Object.freeze({
    recordId: clean(candidate.recordId ?? candidate.id, 160) || null,
    recordType: clean(candidate.recordType, 80).toLocaleUpperCase() || null,
    entityType,
    key: clean(entityType === 'CATEGORY'
      ? candidate.categoryKey ?? candidate.key
      : candidate.itemKey ?? candidate.key, 160) || null,
    name: candidateLabel(candidate) || null,
    canonicalName: candidateLabel(candidate) || null,
    categoryKey: clean(candidate.categoryKey, 160) || null,
    score,
    confidenceBand: score >= confidenceConfiguration.highConfidence ? 'HIGH'
      : (score >= confidenceConfiguration.clarificationConfidence ? 'MEDIUM' : 'LOW'),
    matchMethod,
    matchedPhrase: clean(matchedSignal?.phrase, 240) || null,
    mentionKind: authoritativeMentionMethods.has(matchMethod) ? 'AUTHORITATIVE_MENTION'
      : (approximateMentionMethods.has(matchMethod) ? 'PHONETIC_CANDIDATE'
        : 'RETRIEVAL_CANDIDATE'),
    explicit: candidate.explicit === true,
    intentClass: clean(candidate.intentClass, 80).toLocaleUpperCase() || null,
    actionType: clean(candidate.actionType, 80).toLocaleLowerCase() || null,
    requiresCatalogItem: candidate.requiresCatalogItem === true,
  });
}

function explicitSignalPhrases(candidate, confidenceConfiguration) {
  const score = boundedScore(candidate?.score);
  return unique((candidate?.signals ?? []).filter((signal) => (
    signal?.explicit === true
      && clean(signal.phrase)
      && boundedScore(signal.score) >= Math.max(
        confidenceConfiguration.clarificationConfidence, score - 0.01,
      )
  )).map((signal) => normalized(signal.phrase)), 8);
}

function phraseSignature(candidate, confidenceConfiguration) {
  return [...explicitSignalPhrases(candidate, confidenceConfiguration)].sort().join('|');
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

function hasStrongPublishedCatalogSignal(candidate, confidenceConfiguration) {
  return candidate?.explicit === true
    && (candidate?.signals ?? []).some((signal) => (
      signal?.explicit === true
        && authoritativeMentionMethods.has(String(signal.method ?? '').toLocaleLowerCase())
        && boundedScore(signal.score) >= confidenceConfiguration.highConfidence
    ));
}

function distinctMentionCandidates(candidates, confidenceConfiguration) {
  const selected = new Map();
  for (const candidate of candidates) {
    const signature = phraseSignature(candidate, confidenceConfiguration);
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

function rankedCurrentRoutes(resolution) {
  const resolved = !isCatalogCandidate(resolution?.candidate)
    ? resolution?.candidate : null;
  const routes = [resolved, ...routeCandidates(resolution)].filter(Boolean);
  return [...new Map(routes.map((candidate) => [candidateIdentity(candidate), candidate])).values()]
    .sort((left, right) => boundedScore(right.score) - boundedScore(left.score));
}

function explicitCurrentRoute(resolution, confidenceConfiguration) {
  return rankedCurrentRoutes(resolution).find((candidate) => (
    candidate?.explicit === true
      && boundedScore(candidate.score) >= confidenceConfiguration.highConfidence
  )) ?? null;
}

function currentNonCatalogSignal(resolution, confidenceConfiguration) {
  return rankedCurrentRoutes(resolution).find((candidate) => (
    candidate?.explicit === true
      && boundedScore(candidate.score) >= confidenceConfiguration.clarificationConfidence
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

function sameCanonicalEntity(left, right) {
  if (!left || !right) return false;
  const leftRecordId = normalized(left.recordId ?? left.id);
  const rightRecordId = normalized(right.recordId ?? right.id);
  if (leftRecordId && rightRecordId) return leftRecordId === rightRecordId;
  const leftKey = normalized(left.key ?? left.itemKey ?? left.categoryKey);
  const rightKey = normalized(right.key ?? right.itemKey ?? right.categoryKey);
  return Boolean(leftKey && rightKey && leftKey === rightKey
    && String(left.entityType ?? '').toLocaleUpperCase()
      === String(right.entityType ?? '').toLocaleUpperCase());
}

function ambiguityFor(resolution, explicitCandidates, confidenceConfiguration) {
  const relevant = explicitCandidates.length
    ? explicitCandidates
    : (resolution?.routingCandidates ?? []).filter((candidate) => candidate?.explicit === true);
  const top = relevant[0] ?? resolution?.candidate ?? null;
  const second = relevant[1] ?? resolution?.alternatives?.[0] ?? null;
  const namespace = candidateNamespace(top);
  const sameNamespace = Boolean(namespace) && namespace === candidateNamespace(second);
  const closeScores = top && second
    && Math.abs(boundedScore(top.score) - boundedScore(second.score))
      <= confidenceConfiguration.ambiguityMargin;
  const detected = resolution?.action === 'CONFIRM'
    && Boolean(top) && Boolean(second) && sameNamespace && closeScores;
  return Object.freeze({
    detected,
    reason: detected ? 'close_authoritative_candidates' : null,
    candidates: Object.freeze((detected ? [top, second] : [])
      .map((candidate) => candidateSummary(candidate, confidenceConfiguration)).filter(Boolean)),
  });
}

function actionUnderstanding(input, resolution, confidenceConfiguration) {
  const memoryTool = input?.memory?.activeTool;
  const workflow = [
    resolution?.candidate,
    ...(resolution?.namespaceCandidates?.WORKFLOW ?? []),
  ].find((candidate) => (
    String(candidate?.intentClass ?? '').toLocaleUpperCase() === 'ACTION_TOOL_REQUEST'
      && candidate?.explicit === true
      && boundedScore(candidate.score) >= confidenceConfiguration.highConfidence
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
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    resolution.confidenceConfiguration ?? {},
  );
  const route = explicitCurrentRoute(resolution, confidenceConfiguration);
  const currentRouteSignal = route
    ?? currentNonCatalogSignal(resolution, confidenceConfiguration);
  const currentRouteIntent = String(currentRouteSignal?.intentClass ?? '').toLocaleUpperCase();
  const actionRouteWithoutCatalogReference = currentRouteIntent === 'ACTION_TOOL_REQUEST'
    && currentRouteSignal?.requiresCatalogItem !== true;
  const relevantCatalogCandidates = catalogCandidates(resolution).filter((candidate) => (
    !actionRouteWithoutCatalogReference
      || hasStrongPublishedCatalogSignal(candidate, confidenceConfiguration)
  ));
  const explicitCandidates = relevantCatalogCandidates.filter((candidate) => (
    candidate.explicit === true
      && boundedScore(candidate.score) >= confidenceConfiguration.highConfidence
      && explicitSignalPhrases(candidate, confidenceConfiguration).length > 0
  ));
  const mentionedCandidates = distinctMentionCandidates(relevantCatalogCandidates.filter((candidate) => (
    candidate.explicit === true
      && boundedScore(candidate.score) >= confidenceConfiguration.clarificationConfidence
      && explicitSignalPhrases(candidate, confidenceConfiguration).length > 0
  )), confidenceConfiguration);
  const interpretationCandidates = mentionedCandidates
    .map((candidate) => candidateSummary(candidate, confidenceConfiguration))
    .filter(Boolean).slice(0, 5);
  const phoneticCandidates = interpretationCandidates.filter((candidate) => (
    candidate.mentionKind === 'PHONETIC_CANDIDATE'
  ));
  const explicitEntities = explicitCandidates.filter((candidate) => (
    String(candidate.entityType ?? '').toLocaleUpperCase() !== 'CATEGORY'
      && String(candidate.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_CATEGORY'
  )).map((candidate) => candidateSummary(candidate, confidenceConfiguration))
    .filter(Boolean).slice(0, 5);
  const explicitCategories = explicitCandidates.filter((candidate) => (
    String(candidate.entityType ?? '').toLocaleUpperCase() === 'CATEGORY'
      || String(candidate.recordType ?? '').toLocaleUpperCase() === 'CATALOG_CATEGORY'
  )).map((candidate) => candidateSummary(candidate, confidenceConfiguration))
    .filter(Boolean).slice(0, 5);
  const requestedFacts = unique([
    ...(input.requestedFacts ?? []),
    input.memory?.pendingClarification?.missingFactType,
  ]);
  const protocolRoute = protocolIntentClasses.has(
    String(currentRouteSignal?.intentClass ?? '').toLocaleUpperCase(),
  );
  const memoryEntity = activeMemoryEntity(input.memory);
  // A confirmable current mention is still a new topic signal. It must block
  // stale memory even though it cannot become canonical memory until the
  // caller confirms it and validation succeeds.
  const hasCurrentEntitySignal = mentionedCandidates.length > 0;
  // Medium-confidence fuzzy routes are retrieval candidates, not proof that
  // the caller changed topic. Only a high-confidence published route may
  // displace canonical memory before the grounded LLM interprets the turn.
  const hasAuthoritativeCurrentRoute = Boolean(route);
  const suppliedContextSignal = requestedFacts.length > 0
    || (input.contextualReferences?.length ?? 0) > 0;
  // Published workflows can describe the fact/action requested for the active
  // entity. They are retrieval hints, not replacement business topics. A
  // standalone FAQ/conversation/general record still prevents stale memory.
  const workflowContextSignal = String(currentRouteSignal?.recordType ?? '').toLocaleUpperCase()
      === 'WORKFLOW_RULE'
    && !protocolRoute
    && currentRouteSignal?.requiresCatalogItem === true;
  const hasRememberedContext = Boolean(
    memoryEntity || input.memory?.pendingClarification || input.memory?.activeTool,
  );
  const contextDependent = !hasCurrentEntitySignal
    && !protocolRoute
    && hasRememberedContext
    && (suppliedContextSignal
      || workflowContextSignal
      || !hasAuthoritativeCurrentRoute
      || Boolean(input.memory?.pendingClarification)
      || Boolean(input.memory?.activeTool));
  const contextualReferences = unique([
    ...(input.contextualReferences ?? []),
    ...(contextDependent && memoryEntity
      ? [memoryEntity.entityType === 'CATEGORY' ? 'active_category' : 'active_entity'] : []),
    ...(contextDependent && input.memory?.pendingClarification ? ['pending_clarification'] : []),
    ...(contextDependent && input.memory?.activeTool ? ['active_tool'] : []),
  ]);
  const comparisonRequested = requestedFacts.map(normalized).includes('comparison')
    || mentionedCandidates.length > 1 || explicitCandidates.length > 1;
  const comparisonTopScore = Math.max(0, ...mentionedCandidates.map((candidate) => (
    boundedScore(candidate.score)
  )));
  const comparisonMentions = mentionedCandidates.filter((candidate) => (
    boundedScore(candidate.score) >= comparisonTopScore - confidenceConfiguration.ambiguityMargin
      || explicitSignalPhrases(candidate, confidenceConfiguration).length > 0
  ));
  const comparisonPool = [...new Map(comparisonMentions.map((candidate) => (
    [normalized(candidateIdentity(candidate)), candidate]
  ))).values()];
  const comparisonCandidates = comparisonRequested
    ? (comparisonPool.length > 1 ? comparisonPool : explicitCandidates)
    : [];
  const ambiguity = ambiguityFor(resolution, explicitCandidates, confidenceConfiguration);
  const actionIntent = actionUnderstanding(input, resolution, confidenceConfiguration);
  const need = compactNeedContext({
    input,
    hasCurrentEntitySignal,
    hasCurrentRouteSignal: hasAuthoritativeCurrentRoute,
  });
  const canonicalContext = explicitCandidates.length > 0 && !ambiguity.detected
    ? candidateSummary(explicitCandidates[0], confidenceConfiguration)
    : (contextDependent ? memoryEntity : null);
  const confirmationCandidate = !ambiguity.detected && explicitCandidates.length === 0
    ? candidateSummary(mentionedCandidates[0], confidenceConfiguration) : null;
  const intentHint = protocolRoute ? currentRouteIntent
    : (actionIntent.detected ? 'ACTION'
      : (comparisonRequested ? 'COMPARISON'
        : (hasCurrentEntitySignal ? 'ENTITY_REQUEST'
          : (contextDependent ? 'CONTEXTUAL_FOLLOW_UP'
            : (need.detected ? 'NEED_BASED_REQUEST' : 'UNRESOLVED')))));
  const currentCanonicalCandidates = interpretationCandidates;
  const explicitCanonicalCandidate = explicitEntities[0] ?? explicitCategories[0] ?? null;
  const correctionCandidate = explicitCanonicalCandidate ?? confirmationCandidate;
  const possibleCorrection = Boolean(
    memoryEntity && correctionCandidate
      && !sameCanonicalEntity(memoryEntity, correctionCandidate),
  );
  const meaning = Object.freeze({
    interpretationAuthority: 'GROUNDED_LLM',
    latestQuestion: clean(input.latestQuestion ?? input.utterance, 2_000),
    intentHint,
    explicitEntity: explicitEntities[0] ?? null,
    explicitCategory: explicitCategories[0] ?? null,
    entityCandidates: Object.freeze(interpretationCandidates),
    phoneticCandidates: Object.freeze(phoneticCandidates),
    contextualEntity: contextDependent ? memoryEntity : null,
    requestedFact: requestedFacts[0] ?? null,
    requestedFactInterpretationRequired: requestedFacts.length === 0,
    comparisonRequested,
    comparisonEntities: Object.freeze(comparisonCandidates
      .map((candidate) => candidateSummary(candidate, confidenceConfiguration))
      .filter(Boolean).slice(0, 5)),
    actionIntent,
    correction: Object.freeze({
      possible: possibleCorrection,
      interpretationRequired: possibleCorrection,
      confidence: possibleCorrection
        ? (explicitCanonicalCandidate ? 'AUTHORITATIVE' : 'CANDIDATE') : null,
      previousEntity: possibleCorrection ? memoryEntity : null,
      currentCandidates: possibleCorrection
        ? Object.freeze(currentCanonicalCandidates) : Object.freeze([]),
    }),
  });
  return Object.freeze({
    version: CONTEXTUAL_QUERY_UNDERSTANDING_VERSION,
    role: 'RETRIEVAL_MEANING_HINTS',
    decisionAuthority: false,
    meaningAuthority: 'GROUNDED_LLM',
    intentHint,
    tenantId: String(input.tenantId),
    agentId: String(input.agentId),
    callId: String(input.callId),
    latestQuestion: clean(input.latestQuestion ?? input.utterance, 2_000),
    confidenceConfiguration,
    explicitEntities: Object.freeze(explicitEntities),
    explicitCategories: Object.freeze(explicitCategories),
    comparisonEntities: Object.freeze(comparisonCandidates
      .map((candidate) => candidateSummary(candidate, confidenceConfiguration))
      .filter(Boolean).slice(0, 5)),
    contextualReferences,
    requestedFact: requestedFacts[0] ?? null,
    requestedFacts,
    requestedFactSource: requestedFacts.length
      ? (input.requestedFacts?.length ? 'caller_signal' : 'pending_clarification')
      : 'grounded_llm',
    requiresGroundedFactInterpretation: requestedFacts.length === 0,
    actionIntent,
    need,
    ambiguity,
    contextDependent,
    canonicalContext,
    currentEntityCandidates: Object.freeze(interpretationCandidates),
    phoneticCandidates: Object.freeze(phoneticCandidates),
    confirmationCandidate,
    requiresCandidateConfirmation: Boolean(confirmationCandidate),
    explicitCurrentRoute: route ? candidateSummary(route, confidenceConfiguration) : null,
    currentRouteSignal: currentRouteSignal
      ? candidateSummary(currentRouteSignal, confidenceConfiguration) : null,
    protocolPriority: protocolRoute,
    meaning,
  });
}

