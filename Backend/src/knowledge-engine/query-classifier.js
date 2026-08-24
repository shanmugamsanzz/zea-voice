export const KNOWLEDGE_QUERY_CLASSIFIER_VERSION = 1;

export const knowledgeQueryClasses = Object.freeze({
  KNOWN_INFORMATION: 'KNOWN_INFORMATION',
  DETAILS_OR_PRICE: 'DETAILS_OR_PRICE',
  CATEGORY_OVERVIEW: 'CATEGORY_OVERVIEW',
  COMPARISON_COMPLEX: 'COMPARISON_COMPLEX',
  ACTION_TOOL_REQUEST: 'ACTION_TOOL_REQUEST',
  CLARIFICATION_ANSWER: 'CLARIFICATION_ANSWER',
  ACKNOWLEDGEMENT: 'ACKNOWLEDGEMENT',
  CALL_CONTROL: 'CALL_CONTROL',
  SAFETY_EMERGENCY: 'SAFETY_EMERGENCY',
  UNKNOWN: 'UNKNOWN',
});

export const knowledgeSearchIndexes = Object.freeze({
  ROUTE: 'ROUTE',
  ENTITY: 'ENTITY',
  ANSWER_CARD: 'ANSWER_CARD',
  CATALOG: 'CATALOG',
  FAQ: 'FAQ',
  CONVERSATION: 'CONVERSATION',
  WORKFLOW: 'WORKFLOW',
  GENERAL: 'GENERAL',
  BM25: 'BM25',
  SEMANTIC: 'SEMANTIC',
});

const supportedIntentClasses = new Set(Object.values(knowledgeQueryClasses));

const priority = Object.freeze({
  [knowledgeQueryClasses.SAFETY_EMERGENCY]: 100,
  [knowledgeQueryClasses.CALL_CONTROL]: 90,
  [knowledgeQueryClasses.ACTION_TOOL_REQUEST]: 80,
  [knowledgeQueryClasses.CLARIFICATION_ANSWER]: 70,
  [knowledgeQueryClasses.ACKNOWLEDGEMENT]: 60,
  [knowledgeQueryClasses.COMPARISON_COMPLEX]: 50,
  [knowledgeQueryClasses.CATEGORY_OVERVIEW]: 40,
  [knowledgeQueryClasses.DETAILS_OR_PRICE]: 30,
  [knowledgeQueryClasses.KNOWN_INFORMATION]: 20,
  [knowledgeQueryClasses.UNKNOWN]: 0,
});

const retrievalPlans = Object.freeze({
  [knowledgeQueryClasses.SAFETY_EMERGENCY]: Object.freeze([
    knowledgeSearchIndexes.WORKFLOW, knowledgeSearchIndexes.CONVERSATION,
  ]),
  [knowledgeQueryClasses.CALL_CONTROL]: Object.freeze([
    knowledgeSearchIndexes.WORKFLOW, knowledgeSearchIndexes.CONVERSATION,
  ]),
  [knowledgeQueryClasses.ACTION_TOOL_REQUEST]: Object.freeze([
    knowledgeSearchIndexes.WORKFLOW, knowledgeSearchIndexes.CATALOG,
  ]),
  [knowledgeQueryClasses.CLARIFICATION_ANSWER]: Object.freeze([
    knowledgeSearchIndexes.ROUTE, knowledgeSearchIndexes.ENTITY,
  ]),
  [knowledgeQueryClasses.ACKNOWLEDGEMENT]: Object.freeze([
    knowledgeSearchIndexes.CONVERSATION,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]),
  [knowledgeQueryClasses.COMPARISON_COMPLEX]: Object.freeze([
    knowledgeSearchIndexes.CATALOG, knowledgeSearchIndexes.FAQ, knowledgeSearchIndexes.GENERAL,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]),
  [knowledgeQueryClasses.CATEGORY_OVERVIEW]: Object.freeze([
    knowledgeSearchIndexes.CATALOG, knowledgeSearchIndexes.CONVERSATION,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]),
  [knowledgeQueryClasses.DETAILS_OR_PRICE]: Object.freeze([
    knowledgeSearchIndexes.CATALOG, knowledgeSearchIndexes.FAQ,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]),
  [knowledgeQueryClasses.KNOWN_INFORMATION]: Object.freeze([
    knowledgeSearchIndexes.ANSWER_CARD,
  ]),
  [knowledgeQueryClasses.UNKNOWN]: Object.freeze([
    knowledgeSearchIndexes.CATALOG, knowledgeSearchIndexes.FAQ, knowledgeSearchIndexes.CONVERSATION,
    knowledgeSearchIndexes.GENERAL, knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]),
});

export function normalizeKnowledgeIntentClass(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim().toUpperCase()
    .replace(/[\s-]+/gu, '_');
  return supportedIntentClasses.has(normalized) ? normalized : null;
}

function unique(values) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function candidateIntent(candidate) {
  const configured = normalizeKnowledgeIntentClass(candidate?.intentClass);
  if (configured) return configured;
  if (candidate?.recordType === 'WORKFLOW_RULE'
    && (candidate?.actionType === 'configured_tool' || candidate?.answerCard?.decision === 'TOOL')) {
    return knowledgeQueryClasses.ACTION_TOOL_REQUEST;
  }
  if (candidate?.entityType === 'CATEGORY' || candidate?.recordType === 'CATALOG_CATEGORY') {
    return knowledgeQueryClasses.CATEGORY_OVERVIEW;
  }
  if (['CATALOG_ITEM', 'FAQ', 'CONVERSATION_NODE', 'KNOWLEDGE_CHUNK'].includes(candidate?.recordType)) {
    return knowledgeQueryClasses.KNOWN_INFORMATION;
  }
  return null;
}

function rankedCandidates(resolution) {
  if (Array.isArray(resolution?.routingCandidates)) return resolution.routingCandidates;
  return [resolution?.candidate, ...(resolution?.alternatives ?? [])].filter(Boolean);
}

const explicitPriorityMethods = new Set(['exact', 'normalized', 'tenant_alias', 'stt', 'phonetic']);

function hasExplicitPublishedPriorityTrigger(candidate) {
  if (candidate?.explicit !== true) return false;
  return (candidate.signals ?? []).some((signal) => signal.explicit === true
    && explicitPriorityMethods.has(signal.method)
    && Number(signal.score ?? 0) >= 0.89
    && String(signal.phrase ?? '').trim());
}

function candidateIsEligible(candidate, intentClass) {
  if ([
    knowledgeQueryClasses.SAFETY_EMERGENCY,
    knowledgeQueryClasses.CALL_CONTROL,
    knowledgeQueryClasses.ACTION_TOOL_REQUEST,
  ].includes(intentClass)) {
    return hasExplicitPublishedPriorityTrigger(candidate);
  }
  if ([
    knowledgeQueryClasses.KNOWN_INFORMATION,
    knowledgeQueryClasses.DETAILS_OR_PRICE,
    knowledgeQueryClasses.CATEGORY_OVERVIEW,
  ].includes(intentClass)) {
    return Number(candidate?.score ?? 0) >= 0.88;
  }
  return true;
}

function explicitEntityCount(candidates) {
  return new Set(candidates.filter((candidate) => candidate.explicit
    && Number(candidate.score ?? 0) >= 0.88
    && ['ITEM', 'CATEGORY'].includes(candidate.entityType))
    .map((candidate) => `${candidate.entityType}:${candidate.itemKey ?? candidate.categoryKey ?? candidate.recordId}`))
    .size;
}

function explicitPhraseSignatureCount(candidates) {
  return new Set(candidates.filter((candidate) => candidate.explicit
    && Number(candidate.score ?? 0) >= 0.88).map((candidate) => (
    // Only phrases tied with the candidate's winning score identify what the
    // caller explicitly named. Lower fuzzy matches to each record's label must
    // not turn one shared alias into a comparison request.
    [...new Set((candidate.signals ?? [])
      .filter((signal) => signal.explicit === true && signal.phrase
        && Number(signal.score ?? 0) >= Number(candidate.score ?? 0) - 0.000001)
      .map((signal) => String(signal.phrase).normalize('NFKC').trim().toLocaleLowerCase()))]
      .sort().join('|')
  )).filter(Boolean))
    .size;
}

function inferredCandidates(input, resolution) {
  const candidates = rankedCandidates(resolution);
  const inferred = candidates.flatMap((candidate) => {
    const intentClass = candidateIntent(candidate);
    return intentClass && candidateIsEligible(candidate, intentClass)
      ? [{ intentClass, candidate, source: candidate.intentClass
      ? 'published_intent_class' : 'resolved_structure' }] : [];
  });
  if ((explicitEntityCount(candidates) > 1 && explicitPhraseSignatureCount(candidates) > 1)
    || (input.requestedFacts?.length ?? 0) > 1) {
    inferred.push({
      intentClass: knowledgeQueryClasses.COMPARISON_COMPLEX,
      candidate: resolution?.candidate ?? null,
      source: 'multi_entity_or_fact_structure',
    });
  }
  const explicitResolvedEntity = candidates.some((candidate) => candidate.explicit === true
    && ['ITEM', 'CATEGORY'].includes(candidate.entityType)
    && Number(candidate.score ?? 0) >= 0.88);
  if (input.memory?.pendingClarification && !explicitResolvedEntity) {
    inferred.push({
      intentClass: knowledgeQueryClasses.CLARIFICATION_ANSWER,
      candidate: resolution?.candidate ?? null,
      source: 'pending_call_clarification',
    });
  }
  if ((input.requestedFacts?.length ?? 0) > 0 && input.memory?.activeEntity) {
    inferred.push({
      intentClass: knowledgeQueryClasses.DETAILS_OR_PRICE,
      candidate: resolution?.candidate ?? null,
      source: 'requested_fact_with_active_entity',
    });
  }
  if (input.memory?.activeTool?.name) {
    inferred.push({
      intentClass: knowledgeQueryClasses.ACTION_TOOL_REQUEST,
      candidate: null,
      source: 'active_tool_workflow',
    });
  }
  if (!inferred.length) inferred.push({
    intentClass: knowledgeQueryClasses.UNKNOWN, candidate: null, source: 'unresolved_utterance',
  });
  const routingTier = (entry) => {
    if (entry.intentClass === knowledgeQueryClasses.SAFETY_EMERGENCY) return 900;
    if (entry.intentClass === knowledgeQueryClasses.CALL_CONTROL) return 800;
    if (entry.source === 'active_tool_workflow') return 700;
    if (entry.intentClass === knowledgeQueryClasses.ACTION_TOOL_REQUEST) return 600;
    if (entry.intentClass === knowledgeQueryClasses.COMPARISON_COMPLEX) return 550;
    if (entry.candidate?.explicit === true
      && ['ITEM', 'CATEGORY'].includes(entry.candidate?.entityType)) return 500;
    if (['FAQ', 'CONVERSATION_NODE'].includes(entry.candidate?.recordType)) return 400;
    if (entry.intentClass === knowledgeQueryClasses.CLARIFICATION_ANSWER) return 350;
    if (entry.candidate?.recordType === 'KNOWLEDGE_CHUNK') return 300;
    if (entry.intentClass === knowledgeQueryClasses.ACKNOWLEDGEMENT) return 200;
    return 100;
  };
  return inferred.sort((left, right) => {
    // Universal runtime priority:
    // emergency -> call control -> active tool -> action -> explicit Catalog
    // -> FAQ/Conversation -> General -> grounded reasoning -> clarification.
    const tierDifference = routingTier(right) - routingTier(left);
    if (tierDifference) return tierDifference;
    const scoreDifference = Number(right.candidate?.score ?? 0) - Number(left.candidate?.score ?? 0);
    return scoreDifference || priority[right.intentClass] - priority[left.intentClass];
  });
}

function indexesFor(intentClass, candidate) {
  const configured = retrievalPlans[intentClass] ?? retrievalPlans.UNKNOWN;
  if (intentClass !== knowledgeQueryClasses.KNOWN_INFORMATION) return configured;
  if (candidate?.recordType === 'CATALOG_ITEM') return Object.freeze([
    knowledgeSearchIndexes.ANSWER_CARD, knowledgeSearchIndexes.CATALOG,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]);
  if (candidate?.recordType === 'FAQ') return Object.freeze([
    knowledgeSearchIndexes.ANSWER_CARD, knowledgeSearchIndexes.FAQ,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]);
  if (candidate?.recordType === 'CONVERSATION_NODE') return Object.freeze([
    knowledgeSearchIndexes.ANSWER_CARD, knowledgeSearchIndexes.CONVERSATION,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]);
  if (candidate?.recordType === 'KNOWLEDGE_CHUNK') return Object.freeze([
    knowledgeSearchIndexes.GENERAL,
    knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
  ]);
  return configured;
}

export function classifyKnowledgeQuery(input, resolution) {
  if (!input?.utterance || !input?.tenantId || !input?.agentId || !input?.callId) {
    throw new TypeError('Query classification requires a versioned finalized-utterance input');
  }
  if (!resolution || resolution.tenantId !== input.tenantId) {
    throw new TypeError('Query classification requires same-tenant entity resolution');
  }
  const selected = inferredCandidates(input, resolution)[0];
  const searchIndexes = indexesFor(selected.intentClass, selected.candidate);
  return Object.freeze({
    version: KNOWLEDGE_QUERY_CLASSIFIER_VERSION,
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: selected.intentClass,
    priority: priority[selected.intentClass],
    confidence: resolution.score ?? 0,
    source: selected.source,
    candidate: selected.candidate,
    requiresConfirmation: Boolean(selected.candidate)
      && !input.memory?.activeTool?.name
      && resolution.action === 'CONFIRM',
    retrievalPlan: Object.freeze({
      indexes: unique(searchIndexes),
      useSemantic: searchIndexes.includes(knowledgeSearchIndexes.SEMANTIC),
      reason: `${selected.intentClass.toLocaleLowerCase()}_${selected.source}`,
    }),
  });
}
