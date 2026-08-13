function text(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function same(left, right) {
  const a = text(left);
  const b = text(right);
  return Boolean(a && b && a === b);
}

const routePriority = Object.freeze({
  workflow: 600,
  catalog: 500,
  conversation: 400,
  faq: 300,
  semantic: 200,
  workflow_hint: 150,
  clarification: 0,
});

const semanticRecordPriority = Object.freeze({
  CATALOG_ITEM: 500,
  WORKFLOW_RULE: 450,
  CONVERSATION_NODE: 400,
  FAQ: 300,
  KNOWLEDGE_CHUNK: 200,
});

function primaryRecordType(candidate) {
  return String(candidate?.matches?.[0]?.recordType ?? candidate?.source?.recordType ?? '').toUpperCase();
}

function catalogIdentity(candidate) {
  const item = candidate?.item ?? candidate?.catalogSelection?.item;
  return {
    id: item?.id ?? candidate?.source?.recordId,
    key: item?.key,
    categoryKey: item?.categoryKey ?? candidate?.category?.key,
  };
}

function semanticConfidence(candidate) {
  const values = [
    candidate?.entityResolution?.confidence,
    candidate?.workflow?.confidence,
    candidate?.source?.confidence,
    candidate?.matches?.[0]?.score,
  ].map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function sourcePriority(candidate, knowledgeBasePriorities) {
  const id = text(candidate?.source?.knowledgeBaseId ?? candidate?.matches?.[0]?.knowledgeBaseId);
  if (!id || !knowledgeBasePriorities.has(id)) return 0;
  const priority = Number(knowledgeBasePriorities.get(id));
  return Number.isFinite(priority) ? Math.max(0, 100 - Math.min(100, priority)) : 0;
}

export function rankHybridEvidence(candidates, context = {}) {
  const knowledgeBasePriorities = new Map((context.knowledgeBases ?? [])
    .map((item) => [text(item.id), item.priority]));
  return (candidates ?? []).filter((candidate) => candidate?.found === true).map((candidate, index) => {
    const factors = {};
    const recordType = primaryRecordType(candidate);
    factors.document = candidate.route === 'semantic' && semanticRecordPriority[recordType]
      ? semanticRecordPriority[recordType] : (routePriority[candidate.route] ?? 0);
    const identity = catalogIdentity(candidate);
    factors.selectedItem = same(identity.id, context.selectedItemId) || same(identity.key, context.selectedItemKey) ? 300 : 0;
    factors.activeCategory = same(identity.categoryKey, context.activeCategoryKey) ? 160 : 0;
    const method = text(candidate?.entityResolution?.method ?? candidate?.workflow?.matchMethod);
    factors.exactAlias = ['exact', 'contains', 'normalized', 'intent'].includes(method)
      && semanticConfidence(candidate) >= 0.98 ? 220 : 0;
    factors.stage = candidate.route === 'workflow'
      ? (candidate.workflow?.gate?.allowed === false ? -2_000 : 200)
      : (candidate.route === 'conversation' && same(candidate.source?.nodeKey, context.currentStage) ? 180 : 0);
    const workflowPriority = Number(candidate?.workflow?.priority ?? candidate?.source?.workflowPriority);
    factors.workflowPriority = Number.isFinite(workflowPriority)
      ? Math.max(0, 150 - Math.min(150, workflowPriority)) : 0;
    factors.semantic = Math.round(semanticConfidence(candidate) * 100);
    factors.knowledgeBase = sourcePriority(candidate, knowledgeBasePriorities);
    factors.deterministicAction = candidate.route === 'workflow'
      && candidate.workflow?.evidenceOnly !== true
      && ['exact', 'contains', 'intent'].includes(method) ? 1_000 : 0;
    const score = Object.values(factors).reduce((total, value) => total + value, 0);
    return Object.freeze({ candidate, score, factors: Object.freeze(factors), inputOrder: index });
  }).sort((left, right) => right.score - left.score || left.inputOrder - right.inputOrder);
}

export function rankedEvidenceBundle(ranked, maximum = 8) {
  return Object.freeze((ranked ?? []).slice(0, maximum).map((entry) => Object.freeze({
    route: entry.candidate.route,
    content: String(entry.candidate.content ?? '').trim(),
    source: entry.candidate.source ?? null,
    score: entry.score,
    factors: entry.factors,
  })));
}

export function resolveEvidenceConfidence(ranked, configuration = {}) {
  const high = Number(configuration.highConfidence ?? 0.86);
  const clarification = Number(configuration.clarificationConfidence ?? 0.64);
  const margin = Number(configuration.ambiguityMargin ?? 0.06);
  const first = ranked?.[0];
  if (!first) return Object.freeze({ outcome: 'none', confidence: 0, margin: 0 });
  const second = ranked?.[1];
  const confidence = semanticConfidence(first.candidate);
  const secondConfidence = second ? semanticConfidence(second.candidate) : 0;
  const confidenceMargin = Math.max(0, confidence - secondConfidence);
  const deterministic = first.factors.deterministicAction > 0
    || first.factors.exactAlias > 0
    || first.candidate.route === 'faq'
    || first.factors.stage > 0;
  if (deterministic || (confidence >= high && (!second || confidenceMargin >= margin))) {
    return Object.freeze({ outcome: 'high', confidence, margin: confidenceMargin });
  }
  if (confidence >= clarification || first.score > 0) {
    return Object.freeze({ outcome: 'ambiguous', confidence, margin: confidenceMargin });
  }
  return Object.freeze({ outcome: 'none', confidence, margin: confidenceMargin });
}
