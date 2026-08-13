function text(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function same(left, right) {
  const a = text(left);
  const b = text(right);
  return Boolean(a && b && a === b);
}

const semanticRecordPriority = Object.freeze({
  CATALOG_ITEM: 500,
  WORKFLOW_RULE: 450,
  CONVERSATION_NODE: 400,
  FAQ: 300,
  KNOWLEDGE_CHUNK: 200,
});

function canonicalQuestionType(value) {
  const type = text(value).replace(/[\s./-]+/gu, '_');
  if (['category_request', 'package_overview', 'catalog_overview'].includes(type)) return 'overview';
  if (['item_request', 'inclusions', 'inclusion', 'features', 'benefits'].includes(type)) {
    return type === 'item_request' ? 'details' : 'coverage';
  }
  if (['booking_request', 'booking_field_answer', 'appointment', 'reservation'].includes(type)) return 'booking';
  if (['identity', 'overview', 'details', 'price', 'coverage', 'comparison', 'preparation', 'booking', 'side_question'].includes(type)) return type;
  return type || 'unclear';
}

function primaryRecordType(candidate) {
  return String(candidate?.matches?.[0]?.recordType ?? candidate?.source?.recordType ?? '').toUpperCase();
}

function catalogIdentity(candidate) {
  const item = candidate?.resolvedEntity ?? candidate?.item ?? candidate?.catalogSelection?.item;
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

function candidateQuestionTypes(candidate) {
  const configured = candidate?.directAnswer?.questionTypes ?? candidate?.questionTypes;
  if (Array.isArray(configured) && configured.length) return new Set(configured.map(canonicalQuestionType));
  if (candidate.route === 'catalog') {
    if (candidate.category && !candidate.item) return new Set(['overview', 'price']);
    if (Array.isArray(candidate.catalogSelections) && candidate.catalogSelections.length > 1) return new Set(['comparison']);
    return new Set(['details', 'price', 'coverage', 'preparation']);
  }
  if (candidate.route === 'workflow' || candidate.route === 'workflow_hint') {
    const type = canonicalQuestionType(candidate.workflow?.intent ?? candidate.workflow?.name);
    return new Set(type === 'unclear' ? [] : [type]);
  }
  const recordType = primaryRecordType(candidate);
  if (recordType === 'CONVERSATION_NODE' || candidate.route === 'conversation') return new Set(['stage_continuation']);
  if (recordType === 'FAQ' || recordType === 'KNOWLEDGE_CHUNK') {
    return new Set(['identity', 'overview', 'details', 'price', 'coverage', 'comparison', 'preparation', 'side_question']);
  }
  return new Set();
}

function questionCompatibility(candidate, requestedType) {
  const requested = canonicalQuestionType(requestedType);
  if (!requested || requested === 'unclear') return 0;
  const supported = candidateQuestionTypes(candidate);
  if (!supported.size) return 0;
  return supported.has(requested) ? 1 : -1;
}

function sourcePriority(candidate, knowledgeBasePriorities) {
  const id = text(candidate?.source?.knowledgeBaseId ?? candidate?.matches?.[0]?.knowledgeBaseId);
  if (!id || !knowledgeBasePriorities.has(id)) return 0;
  const priority = Number(knowledgeBasePriorities.get(id));
  return Number.isFinite(priority) ? Math.max(0, 100 - Math.min(100, priority)) : 0;
}

function evidenceIdentity(candidate) {
  return [
    primaryRecordType(candidate),
    candidate?.source?.recordId ?? candidate?.matches?.[0]?.id,
    String(candidate?.content ?? '').trim(),
  ].map(text).join('|');
}

function sourceAuthority(candidate, questionType) {
  const recordType = primaryRecordType(candidate);
  if (canonicalQuestionType(questionType) === 'booking' && candidate.route === 'workflow') return 600;
  if (candidate.route === 'catalog' || recordType === 'CATALOG_ITEM') return 500;
  if (candidate.route === 'workflow' || recordType === 'WORKFLOW_RULE') return 450;
  return semanticRecordPriority[recordType] ?? (candidate.route === 'faq' ? 300 : 100);
}

export function rankHybridEvidence(candidates, context = {}) {
  const knowledgeBasePriorities = new Map((context.knowledgeBases ?? [])
    .map((item) => [text(item.id), item.priority]));
  return (candidates ?? []).filter((candidate) => candidate?.found === true).map((candidate, index) => {
    const factors = {};
    const identity = catalogIdentity(candidate);
    const compatibility = questionCompatibility(candidate, context.questionType);
    const pendingCompatibility = questionCompatibility(candidate, context.pendingQuestionType);
    const method = text(candidate?.entityResolution?.method ?? candidate?.workflow?.matchMethod);
    const directApproved = candidate?.directAnswer?.approved === true
      && candidate.route !== 'workflow_hint'
      && Boolean(String(candidate.content ?? '').trim());

    // These weights intentionally encode the documented ordering. A lower
    // concern cannot overcome a mismatch in a higher concern.
    factors.latestQuestionType = compatibility * 1_000_000_000_000;
    factors.selectedItem = (same(identity.id, context.selectedItemId)
      || same(identity.key, context.selectedItemKey)) ? 10_000_000_000 : 0;
    factors.resolvedEntity = (same(identity.id, context.resolvedEntityId)
      || same(identity.key, context.resolvedEntityKey)) ? 100_000_000 : 0;
    factors.directAnswerCoverage = directApproved && compatibility >= 0 ? 1_000_000 : 0;
    factors.activeCategory = same(identity.categoryKey, context.activeCategoryKey) ? 100_000 : 0;
    factors.pendingQuestion = pendingCompatibility > 0 ? 10_000 : 0;
    factors.stage = candidate.route === 'workflow'
      ? (candidate.workflow?.gate?.allowed === false ? -100_000_000_000 : 1_000)
      : (candidate.route === 'conversation' && same(candidate.source?.nodeKey, context.currentStage) ? 1_000 : 0);
    factors.sourceAuthority = sourceAuthority(candidate, context.questionType);
    factors.knowledgeBase = sourcePriority(candidate, knowledgeBasePriorities);
    factors.exactAlias = ['exact', 'contains', 'normalized', 'intent'].includes(method)
      && semanticConfidence(candidate) >= 0.98 ? 220 : 0;
    const workflowPriority = Number(candidate?.workflow?.priority ?? candidate?.source?.workflowPriority);
    factors.workflowPriority = Number.isFinite(workflowPriority)
      ? Math.max(0, 150 - Math.min(150, workflowPriority)) : 0;
    factors.semantic = Math.round(semanticConfidence(candidate) * 100);
    factors.retrievalModality = candidate.route === 'semantic' ? 10 : (candidate.route === 'lexical' ? 5 : 0);
    factors.deterministicAction = candidate.route === 'workflow'
      && candidate.workflow?.evidenceOnly !== true
      && ['exact', 'contains', 'intent'].includes(method) ? 1_000 : 0;
    // Task-1 safety/exact actions precede ordinary evidence ranking. This is
    // deliberately unavailable to fuzzy/phonetic Workflow hints.
    factors.safetyExactAction = factors.deterministicAction > 0 ? 100_000_000_000 : 0;
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
  const firstIdentity = evidenceIdentity(first.candidate);
  const second = ranked?.slice(1).find((entry) => evidenceIdentity(entry.candidate) !== firstIdentity);
  const confidence = semanticConfidence(first.candidate);
  const secondConfidence = second ? semanticConfidence(second.candidate) : 0;
  const confidenceMargin = Math.max(0, confidence - secondConfidence);
  const deterministic = first.factors.deterministicAction > 0
    || first.factors.directAnswerCoverage > 0
    || first.factors.exactAlias > 0;
  if (deterministic || (confidence >= high && (!second || confidenceMargin >= margin))) {
    return Object.freeze({ outcome: 'high', confidence, margin: confidenceMargin });
  }
  if (confidence >= clarification || first.score > 0) {
    return Object.freeze({ outcome: 'ambiguous', confidence, margin: confidenceMargin });
  }
  return Object.freeze({ outcome: 'none', confidence, margin: confidenceMargin });
}

export function validateDirectAnswer(candidate, { questionType, confidenceOutcome } = {}) {
  const approved = candidate?.directAnswer?.approved === true;
  const content = String(candidate?.content ?? '').trim();
  const compatibility = questionCompatibility(candidate, questionType);
  const valid = approved
    && candidate?.route !== 'workflow_hint'
    && candidate?.workflow?.evidenceOnly !== true
    && confidenceOutcome === 'high'
    && compatibility >= 0
    && Boolean(content);
  return Object.freeze({
    valid,
    reason: valid ? null
      : (!approved ? 'not_approved_caller_facing'
        : (candidate?.route === 'workflow_hint' || candidate?.workflow?.evidenceOnly === true
          ? 'evidence_hint_only'
          : (confidenceOutcome !== 'high' ? 'confidence_not_high'
            : (compatibility < 0 ? 'question_type_mismatch' : 'empty_content')))),
  });
}

export { canonicalQuestionType };
