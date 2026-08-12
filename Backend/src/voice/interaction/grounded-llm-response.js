const maximumIntentCharacters = 160;
const maximumAnswerCharacters = 4_000;
const maximumSources = 10;
const maximumEntities = 20;
const maximumAssertedFacts = 12;
// These describe the caller's question, not a tenant-specific intent.  They
// let every tenant use the same safe live-call mechanics without encoding a
// company's products, services, or wording in application code.
const questionTypes = new Set([
  'overview', 'category_request', 'item_request', 'details', 'inclusions',
  'price', 'comparison', 'scenario', 'booking_request', 'booking_field_answer',
  'side_question', 'confirmation', 'unclear',
]);

function text(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value, 240).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function addSource(sources, seen, content, metadata = {}) {
  const normalized = text(content, 6_000);
  if (!normalized || seen.has(normalized) || sources.length >= maximumSources) return;
  seen.add(normalized);
  sources.push(Object.freeze({ id: `source_${sources.length + 1}`, content: normalized, ...metadata }));
}

function entity(value = {}, sourceId = null) {
  const key = text(value.key ?? value.itemKey, 160);
  const name = text(value.name, 240);
  if (!key || !name) return null;
  return Object.freeze({
    key, name,
    id: text(value.id ?? value.itemId, 100) || null,
    category: text(value.category, 240) || null,
    categoryKey: text(value.categoryKey, 160) || null,
    sourceId,
  });
}

export function buildGroundingEnvelope(knowledge = {}) {
  const sources = [];
  const sourceContents = new Set();
  for (const match of knowledge.matches ?? []) {
    addSource(sources, sourceContents, match.answer ?? match.content, {
      recordId: text(match.id, 100) || null,
      recordType: text(match.recordType, 40) || null,
    });
  }
  for (const hint of knowledge.workflowHints ?? []) {
    addSource(sources, sourceContents, hint.content, {
      recordId: text(hint.source?.recordId, 100) || null,
      recordType: 'workflow_hint',
    });
  }
  for (const evidence of knowledge.tenantEvidence?.sources ?? []) {
    addSource(sources, sourceContents, evidence.content, {
      recordId: text(evidence.recordId, 100) || null,
      recordType: text(evidence.recordType, 40) || 'tenant_evidence',
    });
  }
  addSource(sources, sourceContents, knowledge.content, {
    recordId: text(knowledge.source?.recordId, 100) || null,
    recordType: text(knowledge.route, 40) || null,
  });
  const primarySourceId = sources[0]?.id ?? null;
  const values = [
    knowledge.item,
    ...(knowledge.category?.items ?? []),
    knowledge.catalogSelection?.item,
    ...(knowledge.catalogSelections ?? []).map((selection) => selection.item),
    ...(knowledge.workflowHints ?? []).flatMap((hint) => [
      hint.item,
      ...(hint.category?.items ?? []),
      hint.catalogSelection?.item,
      ...(hint.catalogSelections ?? []).map((selection) => selection.item),
    ]),
    ...(knowledge.tenantEvidence?.entities ?? []),
    ...(knowledge.clarification?.candidates ?? []),
  ].filter(Boolean);
  const entities = [];
  const entityKeys = new Set();
  for (const value of values) {
    const next = entity(value, primarySourceId);
    const key = identity(next?.key);
    if (!next || !key || entityKeys.has(key)) continue;
    entityKeys.add(key);
    entities.push(next);
    if (entities.length >= maximumEntities) break;
  }
  return Object.freeze({
    found: knowledge.found === true && sources.length > 0,
    route: text(knowledge.route, 40) || 'none',
    sources: Object.freeze(sources),
    entities: Object.freeze(entities),
  });
}

export function groundedResponseContract(envelope) {
  return Object.freeze({
    format: 'json_object',
    schema: {
      intent: 'short generic intent name',
      questionType: 'overview, category_request, item_request, details, inclusions, price, comparison, scenario, booking_request, booking_field_answer, side_question, confirmation or unclear',
      flowAction: 'continue, answer_pending, side_question or clarify',
      selectedEntityKeys: ['only keys listed in allowedEntityKeys'],
      evidenceSourceIds: ['source IDs supporting the spoken answer'],
      assertedFacts: [{
        type: 'entity, price, inclusion, policy, availability, preparation or action',
        value: 'short verbatim fact supported by the referenced source',
        sourceId: 'one cited evidence source ID',
      }],
      spokenAnswer: 'short natural answer in the required language',
    },
    allowedEntityKeys: envelope.entities.map((item) => item.key),
    allowedEvidenceSourceIds: envelope.sources.map((source) => source.id),
  });
}

function parseObject(value) {
  const raw = String(value ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function list(value, maximum = 20) {
  return Array.isArray(value) ? [...new Set(value.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, maximum) : [];
}

function assertedFacts(value) {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set(['entity', 'price', 'inclusion', 'policy', 'availability', 'preparation', 'action']);
  const results = [];
  for (const candidate of value.slice(0, maximumAssertedFacts)) {
    const type = text(candidate?.type, 40).toLocaleLowerCase();
    const factValue = text(candidate?.value, 400);
    const sourceId = text(candidate?.sourceId ?? candidate?.source_id, 80);
    if (!allowedTypes.has(type) || !factValue || !sourceId) return null;
    results.push({ type, value: factValue, sourceId });
  }
  return results;
}

function numbers(value) {
  return new Set((text(value, maximumAnswerCharacters).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? [])
    .map((entry) => entry.replace(/[^\d]/gu, '')).filter(Boolean));
}

function meaningfulTokens(value) {
  return identity(value).split(' ').filter((token) => token.length >= 4 || /\d/u.test(token));
}

function abbreviations(value) {
  return new Set((text(value, maximumAnswerCharacters).match(/\b[A-Z]{2,10}\b/gu) ?? [])
    .map((entry) => entry.toUpperCase()));
}

function supportRatio(answer, evidence) {
  const answerTokens = meaningfulTokens(answer);
  if (!answerTokens.length) return 1;
  const evidenceTokens = new Set(meaningfulTokens(evidence));
  return answerTokens.filter((token) => evidenceTokens.has(token)).length / answerTokens.length;
}

export function validateGroundedLlmResponse(raw, envelope, runtime = {}) {
  const parsed = parseObject(raw);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  const intent = text(parsed.intent, maximumIntentCharacters);
  const questionType = text(parsed.questionType ?? parsed.question_type, 80).toLocaleLowerCase();
  const flowAction = text(parsed.flowAction ?? parsed.flow_action, 40).toLocaleLowerCase() || 'continue';
  const spokenAnswer = text(parsed.spokenAnswer ?? parsed.spoken_answer, maximumAnswerCharacters);
  if (!intent || !questionType || !spokenAnswer) return Object.freeze({ valid: false, reason: 'required_field_missing' });
  if (!questionTypes.has(questionType)) return Object.freeze({ valid: false, reason: 'invalid_question_type' });
  if (!['continue', 'answer_pending', 'side_question', 'clarify'].includes(flowAction)) {
    return Object.freeze({ valid: false, reason: 'invalid_flow_action' });
  }
  const requestedEntityKeys = list(parsed.selectedEntityKeys ?? parsed.selected_entity_keys, maximumEntities);
  const requestedSourceIds = list(parsed.evidenceSourceIds ?? parsed.evidence_source_ids, maximumSources);
  const facts = assertedFacts(parsed.assertedFacts ?? parsed.asserted_facts);
  const entitiesByKey = new Map(envelope.entities.map((item) => [identity(item.key), item]));
  const sourcesById = new Map(envelope.sources.map((source) => [source.id, source]));
  const selectedEntities = requestedEntityKeys.map((key) => entitiesByKey.get(identity(key)));
  if (selectedEntities.some((item) => !item)) {
    return Object.freeze({ valid: false, reason: 'unpublished_entity_selected' });
  }
  const citedSources = requestedSourceIds.map((id) => sourcesById.get(id));
  if (citedSources.some((item) => !item)) {
    return Object.freeze({ valid: false, reason: 'unpublished_evidence_selected' });
  }
  if (envelope.found && citedSources.length === 0) {
    return Object.freeze({ valid: false, reason: 'evidence_required' });
  }
  if (!envelope.found) return Object.freeze({ valid: false, reason: 'verified_evidence_missing' });
  if (facts === null || facts.length === 0) return Object.freeze({ valid: false, reason: 'asserted_facts_required' });
  if (facts.some((fact) => !sourcesById.has(fact.sourceId) || !requestedSourceIds.includes(fact.sourceId))) {
    return Object.freeze({ valid: false, reason: 'asserted_fact_source_not_cited' });
  }
  if (facts.some((fact) => !identity(sourcesById.get(fact.sourceId).content).includes(identity(fact.value)))) {
    return Object.freeze({ valid: false, reason: 'unsupported_asserted_fact' });
  }
  if (flowAction === 'answer_pending' && !String(runtime.pendingQuestion ?? '').trim()) {
    return Object.freeze({ valid: false, reason: 'pending_answer_without_pending_question' });
  }
  const normalizedAnswer = identity(spokenAnswer);
  const selectedKeySet = new Set(selectedEntities.map((item) => identity(item.key)));
  const unselectedMention = envelope.entities.find((item) => (
    !selectedKeySet.has(identity(item.key))
    && normalizedAnswer.includes(identity(item.name))
  ));
  if (unselectedMention) return Object.freeze({ valid: false, reason: 'mentioned_entity_not_selected' });
  for (const selectedEntity of selectedEntities) {
    const nameTokens = meaningfulTokens(selectedEntity.name);
    const supported = nameTokens.filter((token) => normalizedAnswer.split(' ').includes(token)).length;
    if (nameTokens.length && supported / nameTokens.length <= 0.5) {
      return Object.freeze({ valid: false, reason: 'selected_entity_not_supported_by_answer' });
    }
  }
  const evidenceText = citedSources.map((source) => source.content).join(' ');
  const evidenceNumbers = numbers(evidenceText);
  if ([...numbers(spokenAnswer)].some((value) => !evidenceNumbers.has(value))) {
    return Object.freeze({ valid: false, reason: 'unsupported_numeric_fact' });
  }
  const evidenceAbbreviations = abbreviations(evidenceText);
  if ([...abbreviations(spokenAnswer)].some((value) => !evidenceAbbreviations.has(value))) {
    return Object.freeze({ valid: false, reason: 'unsupported_technical_term' });
  }
  if (envelope.found && supportRatio(spokenAnswer, evidenceText) < 0.2) {
    return Object.freeze({ valid: false, reason: 'insufficient_evidence_overlap' });
  }
  return Object.freeze({
    valid: true,
    intent,
    questionType,
    flowAction,
    spokenAnswer,
    selectedEntityKeys: selectedEntities.map((item) => item.key),
    selectedEntities: selectedEntities.map((item) => ({ ...item })),
    evidenceSourceIds: citedSources.map((source) => source.id),
    assertedFacts: facts.map((fact) => ({ ...fact })),
  });
}

export { questionTypes };
