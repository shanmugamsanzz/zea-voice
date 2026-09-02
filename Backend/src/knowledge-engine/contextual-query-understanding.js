import { typedRecordIdentityKey } from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';
import { compactNeedContext } from './published-use-case-signals.js';

export const CONTEXTUAL_QUERY_UNDERSTANDING_VERSION = 7;
export const STRUCTURED_MEANING_CONTRACT_VERSION = 1;

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

function scalarConstraints(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.freeze(Object.entries(source).flatMap(([key, constraintValue]) => {
    const normalizedKey = clean(key, 80);
    if (!normalizedKey || constraintValue === null || constraintValue === undefined) return [];
    if (typeof constraintValue === 'boolean' || (typeof constraintValue === 'number'
      && Number.isFinite(constraintValue))) {
      return [Object.freeze({ key: normalizedKey, value: constraintValue, source: 'call_state' })];
    }
    const normalizedValue = clean(constraintValue, 500);
    return normalizedValue
      ? [Object.freeze({ key: normalizedKey, value: normalizedValue, source: 'call_state' })]
      : [];
  }).slice(0, 50));
}

function completeTurnPairs(messages = []) {
  const pairs = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const caller = messages[index];
    const agent = messages[index + 1];
    if (caller?.role !== 'user' || agent?.role !== 'assistant') continue;
    const callerText = clean(caller.content, 600);
    const agentText = clean(agent.content, 600);
    if (!callerText || !agentText) continue;
    pairs.push(Object.freeze({ caller: callerText, agent: agentText }));
    index += 1;
  }
  return Object.freeze(pairs.slice(-5));
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
    tenantId: clean(candidate.tenantId, 160) || null,
    knowledgeBaseId: clean(candidate.knowledgeBaseId, 160) || null,
    publicationRevision: Number(candidate.publicationRevision) || null,
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
    requestedFacts: Object.freeze([...(candidate.requestedFacts ?? [])
      .map((value) => clean(value, 120)).filter(Boolean)].slice(0, 20)),
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
    tenantId: clean(entity.tenantId, 160) || null,
    knowledgeBaseId: clean(entity.knowledgeBaseId, 160) || null,
    publicationRevision: Number(entity.publicationRevision) || null,
    recordType: 'CATALOG_ITEM',
    recordId: clean(entity.recordId ?? entity.id, 160) || null,
    key: clean(entity.itemKey ?? entity.key, 160) || null,
    name: clean(entity.name ?? entity.label, 240) || null,
    entityType: 'ITEM',
  });
  const category = memory.activeCategory;
  if (category && typeof category === 'object') return Object.freeze({
    tenantId: clean(category.tenantId, 160) || null,
    knowledgeBaseId: clean(category.knowledgeBaseId, 160) || null,
    publicationRevision: Number(category.publicationRevision) || null,
    recordType: 'CATALOG_CATEGORY',
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
  if (resolution?.ambiguity?.detected === true) {
    const candidates = (resolution.ambiguity.candidates ?? [])
      .map((candidate) => candidateSummary(candidate, confidenceConfiguration)).filter(Boolean);
    return Object.freeze({
      detected: candidates.length > 1,
      reason: candidates.length > 1
        ? (clean(resolution.ambiguity.reason, 120) || 'close_published_entity_candidates')
        : null,
      confidence: candidates.length > 1
        ? Math.max(...candidates.map((candidate) => boundedScore(candidate.score))) : 0,
      candidates: Object.freeze(candidates.slice(0, 5)),
    });
  }
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
    confidence: detected ? boundedScore(top?.score) : 0,
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
    ...(currentRouteSignal?.requestedFacts ?? []),
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
  // entity. They are retrieval hints, not replacement business topics. The
  // active record remains evidence until another published entity is selected.
  const workflowContextSignal = String(currentRouteSignal?.recordType ?? '').toLocaleUpperCase()
      === 'WORKFLOW_RULE'
    && !protocolRoute
    && currentRouteSignal?.requiresCatalogItem === true;
  const hasRememberedContext = Boolean(
    memoryEntity || input.memory?.pendingClarification || input.memory?.activeTool,
  );
  // The grounded LLM owns reference interpretation. Retaining a validated
  // canonical topic when no new entity was mentioned supports every tenant
  // and language without enumerating follow-up words or requested fact names.
  // A successful explicit selection remains the only topic-replacement path.
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
  const publishedComparisonRoute = currentRouteIntent === 'COMPARISON_COMPLEX'
    && currentRouteSignal?.explicit === true
    && boundedScore(currentRouteSignal.score) >= confidenceConfiguration.highConfidence;
  const distinctAuthoritativeMentions = distinctMentionCandidates(
    explicitCandidates.filter((candidate) => (
      hasStrongPublishedCatalogSignal(candidate, confidenceConfiguration)
    )),
    confidenceConfiguration,
  );
  // Retrieval candidates do not prove that the caller compared them.
  const comparisonRequested = requestedFacts.map(normalized).includes('comparison')
    || publishedComparisonRoute || distinctAuthoritativeMentions.length > 1;
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
    ? (distinctAuthoritativeMentions.length > 1
      ? distinctAuthoritativeMentions
      : (comparisonPool.length > 1 ? comparisonPool : explicitCandidates))
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
  const recentTurnPairs = completeTurnPairs(input.recentRelevantTurns);
  const constraints = scalarConstraints({
    ...(input.constraints ?? {}),
    ...(input.memory?.collectedToolFields ?? {}),
  });
  const intentConfidence = boundedScore(
    currentRouteSignal?.score
      ?? explicitCandidates[0]?.score
      ?? mentionedCandidates[0]?.score
      ?? (contextDependent ? confidenceConfiguration.clarificationConfidence : 0),
  );
  const structuredContextualReferences = Object.freeze(contextualReferences.map((reference) => (
    Object.freeze({
      type: reference,
      entity: ['active_entity', 'active_category'].includes(reference) ? memoryEntity : null,
    })
  )));
  const structuredMeaning = Object.freeze({
    contractVersion: STRUCTURED_MEANING_CONTRACT_VERSION,
    stage: 'LIGHTWEIGHT_STRUCTURED_EXTRACT',
    decisionAuthority: false,
    latestUtterance: clean(input.latestQuestion ?? input.utterance, 2_000),
    relevantTurnPairs: recentTurnPairs,
    intent: Object.freeze({
      class: intentHint,
      confidence: intentConfidence,
      source: protocolRoute || hasAuthoritativeCurrentRoute
        ? 'tenant_published_signal' : (contextDependent ? 'canonical_call_state' : 'unresolved'),
    }),
    explicitEntities: Object.freeze([
      ...explicitEntities, ...explicitCategories,
    ].slice(0, 5)),
    contextualReferences: structuredContextualReferences,
    requestedFacts,
    comparison: Object.freeze({
      detected: comparisonRequested,
      entities: Object.freeze(comparisonCandidates
        .map((candidate) => candidateSummary(candidate, confidenceConfiguration))
        .filter(Boolean).slice(0, 5)),
      source: publishedComparisonRoute ? 'tenant_published_signal'
        : (distinctAuthoritativeMentions.length > 1 ? 'multiple_explicit_entities'
          : (requestedFacts.map(normalized).includes('comparison') ? 'caller_signal' : null)),
    }),
    constraints,
    action: actionIntent,
    ambiguity,
    requiresGroundedInterpretation: requestedFacts.length === 0
      || intentHint === 'UNRESOLVED' || ambiguity.detected,
  });
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
    structured: structuredMeaning,
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
      ? (input.requestedFacts?.length ? 'caller_signal'
        : (currentRouteSignal?.requestedFacts?.length
          ? 'tenant_published_route' : 'pending_clarification'))
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
    structuredMeaning,
  });
}

