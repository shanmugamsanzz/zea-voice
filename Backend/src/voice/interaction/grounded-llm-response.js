const maximumIntentCharacters = 160;
const maximumAnswerCharacters = 4_000;
const maximumSources = 10;
const maximumEntities = 20;

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
      flowAction: 'continue, answer_pending, side_question or clarify',
      selectedEntityKeys: ['only keys listed in allowedEntityKeys'],
      evidenceSourceIds: ['source IDs supporting the spoken answer'],
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

function numbers(value) {
  return new Set((text(value, maximumAnswerCharacters).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? [])
    .map((entry) => entry.replace(/[^\d]/gu, '')).filter(Boolean));
}

function meaningfulTokens(value) {
  return identity(value).split(' ').filter((token) => token.length >= 4 || /\d/u.test(token));
}

function supportRatio(answer, evidence) {
  const answerTokens = meaningfulTokens(answer);
  if (!answerTokens.length) return 1;
  const evidenceTokens = new Set(meaningfulTokens(evidence));
  return answerTokens.filter((token) => evidenceTokens.has(token)).length / answerTokens.length;
}

export function validateGroundedLlmResponse(raw, envelope) {
  const parsed = parseObject(raw);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  const intent = text(parsed.intent, maximumIntentCharacters);
  const flowAction = text(parsed.flowAction ?? parsed.flow_action, 40).toLocaleLowerCase() || 'continue';
  const spokenAnswer = text(parsed.spokenAnswer ?? parsed.spoken_answer, maximumAnswerCharacters);
  if (!intent || !spokenAnswer) return Object.freeze({ valid: false, reason: 'required_field_missing' });
  if (!['continue', 'answer_pending', 'side_question', 'clarify'].includes(flowAction)) {
    return Object.freeze({ valid: false, reason: 'invalid_flow_action' });
  }
  const requestedEntityKeys = list(parsed.selectedEntityKeys ?? parsed.selected_entity_keys, maximumEntities);
  const requestedSourceIds = list(parsed.evidenceSourceIds ?? parsed.evidence_source_ids, maximumSources);
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
  if (envelope.found && supportRatio(spokenAnswer, evidenceText) < 0.2) {
    return Object.freeze({ valid: false, reason: 'insufficient_evidence_overlap' });
  }
  return Object.freeze({
    valid: true,
    intent,
    flowAction,
    spokenAnswer,
    selectedEntityKeys: selectedEntities.map((item) => item.key),
    selectedEntities: selectedEntities.map((item) => ({ ...item })),
    evidenceSourceIds: citedSources.map((source) => source.id),
  });
}
