const maximumIntentCharacters = 160;
const maximumAnswerCharacters = 4_000;
const maximumSources = 10;
const maximumEntities = 20;
const maximumAssertedFacts = 12;
// These describe the caller's question, not a tenant-specific intent.  They
// let every tenant use the same safe live-call mechanics without encoding a
// company's products, services, or wording in application code.
const questionTypes = new Set([
  'identity', 'overview', 'category_request', 'item_request', 'details', 'inclusions', 'coverage',
  'preparation', 'price', 'comparison', 'scenario', 'action_request', 'action_field_answer',
  'side_question', 'confirmation', 'unclear',
]);

// LLMs may describe the same generic caller question with different labels.
// Keep this vocabulary domain-neutral: it classifies conversation mechanics,
// never tenant products, industries, or customer wording.
const questionTypeAliases = new Map([
  ['identity', 'identity'], ['caller_identity', 'identity'], ['business_identity', 'identity'],
  ['overview', 'overview'], ['package_overview', 'overview'], ['catalog_overview', 'overview'],
  ['product_overview', 'overview'], ['service_overview', 'overview'], ['options_list', 'overview'],
  ['available_options', 'overview'], ['list_options', 'overview'],
  ['category_request', 'category_request'], ['category', 'category_request'],
  ['category_details', 'category_request'], ['category_options', 'category_request'],
  ['category_selection', 'category_request'], ['group_request', 'category_request'],
  ['item_request', 'item_request'], ['item', 'item_request'], ['package_request', 'item_request'],
  ['product_request', 'item_request'], ['service_request', 'item_request'], ['plan_request', 'item_request'],
  ['details', 'details'], ['detail', 'details'], ['package_details', 'details'],
  ['item_details', 'details'], ['product_details', 'details'], ['service_details', 'details'],
  ['description', 'details'], ['explanation', 'details'], ['package_explanation', 'details'],
  ['inclusions', 'inclusions'], ['inclusion', 'inclusions'], ['benefits', 'inclusions'],
  ['features', 'inclusions'], ['coverage', 'inclusions'], ['whats_included', 'inclusions'],
  ['preparation', 'preparation'], ['preparation_instructions', 'preparation'],
  ['requirements', 'preparation'], ['fasting', 'preparation'],
  ['price', 'price'], ['price_question', 'price'], ['pricing', 'price'], ['cost', 'price'],
  ['fee', 'price'], ['amount', 'price'],
  ['comparison', 'comparison'], ['compare', 'comparison'], ['difference', 'comparison'],
  ['versus', 'comparison'], ['vs', 'comparison'],
  ['scenario', 'scenario'], ['symptom_query', 'scenario'], ['symptom', 'scenario'],
  ['use_case', 'scenario'], ['suitability', 'scenario'], ['recommendation', 'scenario'],
  ['problem', 'scenario'], ['concern', 'scenario'], ['requirement', 'scenario'],
  ['action_request', 'action_request'], ['tool_request', 'action_request'], ['operation_request', 'action_request'],
  ['field_answer', 'action_field_answer'], ['field_value', 'action_field_answer'],
  ['action_field_answer', 'action_field_answer'], ['action_input', 'action_field_answer'],
  ['side_question', 'side_question'], ['general_question', 'side_question'], ['other_question', 'side_question'],
  ['confirmation', 'confirmation'], ['confirm', 'confirmation'], ['approval', 'confirmation'], ['yes_confirmation', 'confirmation'],
  ['unclear', 'unclear'], ['unknown', 'unclear'], ['other', 'unclear'], ['none', 'unclear'],
]);

function text(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value, 240).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

export function normalizeQuestionType(value) {
  const raw = text(value, 80).toLocaleLowerCase();
  const key = raw.replace(/[\s\-./]+/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '');
  if (questionTypes.has(key)) return key;
  return questionTypeAliases.get(key) ?? 'unclear';
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
    if (evidence.callerFacing === false) continue;
    addSource(sources, sourceContents, evidence.content, {
      recordId: text(evidence.recordId, 100) || null,
      recordType: text(evidence.recordType, 40) || 'tenant_evidence',
    });
  }
  for (const record of knowledge.compactKnowledgeMap?.records ?? []) {
    if (String(record.type ?? '').toUpperCase() === 'WORKFLOW_RULE') continue;
    addSource(sources, sourceContents, record.summary, {
      recordId: text(record.id, 100) || null,
      recordType: text(record.type, 40) || 'knowledge_map',
    });
  }
  for (const evidence of knowledge.rankedEvidence ?? []) {
    addSource(sources, sourceContents, evidence.content, {
      recordId: text(evidence.source?.recordId, 100) || null,
      recordType: text(evidence.route, 40) || 'ranked_evidence',
      evidenceScore: Number(evidence.score ?? 0),
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
    ...(knowledge.compactKnowledgeMap?.records ?? []).filter((record) => (
      record.type === 'CATALOG_ITEM' && record.metadata?.key && record.label
    )).map((record) => ({
      id: record.id,
      key: record.metadata.key,
      name: record.label,
      category: record.metadata.category,
      categoryKey: record.metadata.categoryKey,
    })),
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
    fieldOrder: [
      'evidenceSourceIds', 'selectedEntityKeys', 'spokenAnswer',
      'intent', 'questionType', 'currentTopic', 'topicChanged', 'pendingQuestionRelevant',
      'flowAction', 'assertedFacts',
    ],
    streamingRule: 'Emit evidenceSourceIds and selectedEntityKeys first, then spokenAnswer immediately. Emit the remaining metadata only after spokenAnswer. Keep the first spoken sentence short, direct and punctuated.',
    schema: {
      intent: 'short generic intent name',
      questionType: 'identity, overview, category_request, item_request, details, inclusions, coverage, preparation, price, comparison, scenario, action_request, action_field_answer, side_question, confirmation or unclear',
      currentTopic: 'short generic description of the caller current topic',
      topicChanged: 'boolean: whether this turn changes the prior current topic',
      pendingQuestionRelevant: 'boolean: whether the saved pending question should still be resumed after answering',
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

function jsonArrayField(raw, names) {
  for (const name of names) {
    const match = new RegExp(`"${name}"\\s*:\\s*(\\[[^\\]]*\\])`, 'iu').exec(raw);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* incomplete streaming field */ }
  }
  return null;
}

function jsonStringField(raw, names) {
  for (const name of names) {
    const marker = new RegExp(`"${name}"\\s*:\\s*"`, 'iu').exec(raw);
    if (!marker) continue;
    const start = marker.index + marker[0].length;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character !== '"') continue;
      try { return JSON.parse(`"${raw.slice(start, index)}"`); } catch { return null; }
    }
  }
  return null;
}

function booleanField(value) {
  return typeof value === 'boolean' ? value : null;
}

function booleanFieldFromRaw(raw, names) {
  for (const name of names) {
    const match = new RegExp(`"${name}"\\s*:\\s*(true|false)`, 'iu').exec(raw);
    if (match) return match[1].toLowerCase() === 'true';
  }
  return null;
}

function partialJsonStringField(raw, names) {
  for (const name of names) {
    const marker = new RegExp(`"${name}"\\s*:\\s*"`, 'iu').exec(raw);
    if (!marker) continue;
    const start = marker.index + marker[0].length;
    let escaped = false;
    let end = raw.length;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') { end = index; break; }
    }
    let encoded = raw.slice(start, end);
    while (encoded.endsWith('\\') && !encoded.endsWith('\\\\')) encoded = encoded.slice(0, -1);
    try { return JSON.parse(`"${encoded}"`); } catch { return null; }
  }
  return null;
}

// Decodes only the caller-facing string from a streaming grounded JSON object.
// Source and entity citations must arrive first so every complete sentence can
// pass the local evidence gate. Conversation-memory metadata may follow the
// answer and is still validated before it is committed to live state.
export function createGroundedJsonStreamDecoder(envelope, runtime = {}) {
  let raw = '';
  let releasedCharacters = 0;
  let decision = null;
  const allowedSources = new Set((envelope.sources ?? []).map((source) => source.id));
  const allowedEntities = new Set((envelope.entities ?? []).map((entity) => entity.key));
  const refreshDecision = () => {
    const sourceIds = jsonArrayField(raw, ['evidenceSourceIds', 'evidence_source_ids']);
    const entityKeys = jsonArrayField(raw, ['selectedEntityKeys', 'selected_entity_keys']);
    if (!sourceIds || !entityKeys || (envelope.found && sourceIds.length === 0)) return;
    const normalizedSources = list(sourceIds, maximumSources);
    const normalizedEntities = list(entityKeys, maximumEntities);
    if (normalizedSources.some((id) => !allowedSources.has(id))) return;
    if (normalizedEntities.some((key) => !allowedEntities.has(key))) return;
    decision = Object.freeze({
      intent: 'streaming_answer', questionType: 'unclear',
      currentTopic: text(runtime.currentTopic, 240) || 'current caller request',
      topicChanged: false, pendingQuestionRelevant: false, flowAction: 'continue',
      evidenceSourceIds: Object.freeze(normalizedSources),
      selectedEntityKeys: Object.freeze(normalizedEntities),
    });
  };
  return Object.freeze({
    push(delta) {
      raw += String(delta ?? '');
      refreshDecision();
      if (!decision) return Object.freeze({ delta: '', decision: null });
      const answer = partialJsonStringField(raw, ['spokenAnswer', 'spoken_answer']);
      if (answer === null || answer.length <= releasedCharacters) {
        return Object.freeze({ delta: '', decision });
      }
      const next = answer.slice(releasedCharacters);
      releasedCharacters = answer.length;
      return Object.freeze({ delta: next, decision });
    },
    decision: () => decision,
    releasedText: () => partialJsonStringField(raw, ['spokenAnswer', 'spoken_answer'])?.slice(0, releasedCharacters) ?? '',
  });
}

function list(value, maximum = 20) {
  return Array.isArray(value) ? [...new Set(value.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, maximum) : [];
}

function canonicalLookup(values, aliases) {
  const lookup = new Map();
  for (const value of values) {
    for (const alias of aliases(value)) {
      const key = identity(alias);
      if (key && !lookup.has(key)) lookup.set(key, value);
    }
  }
  return lookup;
}

function canonicalizeList(requested, lookup) {
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const value of requested) {
    const match = lookup.get(identity(value));
    if (!match) {
      unresolved.push(value);
      continue;
    }
    if (seen.has(match)) continue;
    seen.add(match);
    resolved.push(match);
  }
  return { resolved, unresolved };
}

function normalizeFlowAction(value, runtime = {}) {
  const raw = text(value, 40).toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  const aliases = new Map([
    ['', 'continue'], ['continue', 'continue'], ['answer', 'continue'],
    ['direct_answer', 'continue'], ['answer_directly', 'continue'], ['respond', 'continue'],
    ['answer_pending', 'answer_pending'], ['pending_answer', 'answer_pending'],
    ['side_question', 'side_question'], ['answer_side_question', 'side_question'],
    ['clarify', 'clarify'], ['clarification', 'clarify'], ['ask_clarification', 'clarify'],
  ]);
  const normalized = aliases.get(raw);
  if (!normalized) return null;
  if (normalized === 'answer_pending' && !String(runtime.pendingQuestion ?? '').trim()) return 'continue';
  return normalized;
}

function canonicalSources(envelope, requestedIds) {
  const lookup = canonicalLookup(envelope.sources ?? [], (source) => [source.id, source.recordId]);
  return canonicalizeList(requestedIds, lookup);
}

function canonicalEntities(envelope, requestedKeys) {
  const lookup = canonicalLookup(envelope.entities ?? [], (item) => [item.key, item.name, item.id]);
  return canonicalizeList(requestedKeys, lookup);
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

function spokenSentences(value) {
  const normalized = text(value, maximumAnswerCharacters);
  if (!normalized) return [];
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...segmenter.segment(normalized)].map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return normalized.split(/(?<=[.!?])\s+/u).map((entry) => entry.trim()).filter(Boolean);
}

function internalSpeech(value) {
  const normalized = identity(value);
  return /(?:runtime context|grounded response contract|response mode|action config|selectedentitykeys|evidencesourceids|flowaction|catalog item required)/iu.test(normalized)
    || /^\s*(?:instruction|action|workflow|response)\s*:/iu.test(String(value ?? ''));
}

// This is the final evidence gate for generated speech. Validation is done per
// sentence so one grounded sentence cannot hide an unsupported price, entity,
// policy or action in a later sentence. Configured flow questions may be
// supplied explicitly because they originate in tenant call-state, not the LLM.
export function validateGroundedSpokenSentences(value, envelope, decision, options = {}) {
  const sourceIds = new Set(decision?.evidenceSourceIds ?? []);
  const citedSources = (envelope?.sources ?? []).filter((source) => sourceIds.has(source.id));
  const evidenceText = citedSources.map((source) => source.content).join(' ');
  const evidenceNumbers = numbers(evidenceText);
  const evidenceAbbreviations = abbreviations(evidenceText);
  const selectedKeys = new Set((decision?.selectedEntityKeys ?? []).map(identity));
  const configuredSpeech = (options.configuredSpeech ?? []).map(identity).filter(Boolean);
  const approved = [];
  const rejected = [];

  for (const sentence of spokenSentences(value)) {
    const normalized = identity(sentence);
    let reason = null;
    const configured = configuredSpeech.some((candidate) => candidate === normalized);
    if (internalSpeech(sentence)) reason = 'internal_text';
    else if (!configured && [...numbers(sentence)].some((number) => !evidenceNumbers.has(number))) {
      reason = 'unsupported_numeric_fact';
    } else if (!configured && [...abbreviations(sentence)].some((term) => !evidenceAbbreviations.has(term))) {
      reason = 'unsupported_technical_term';
    } else if (!configured && (envelope?.entities ?? []).some((item) => (
      !selectedKeys.has(identity(item.key)) && normalized.includes(identity(item.name))
    ))) {
      reason = 'unsupported_entity';
    } else if (!configured && supportRatio(sentence, evidenceText) < 0.2) {
      reason = 'insufficient_sentence_evidence';
    }
    if (reason) rejected.push(Object.freeze({ sentence, reason }));
    else approved.push(sentence);
  }
  return Object.freeze({
    valid: rejected.length === 0 && approved.length > 0,
    text: approved.join(' ').trim(),
    approved: Object.freeze(approved),
    rejected: Object.freeze(rejected),
  });
}

export function validateGroundedLlmResponse(raw, envelope, runtime = {}) {
  const parsed = parseObject(raw);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  const intent = text(parsed.intent, maximumIntentCharacters);
  const questionType = normalizeQuestionType(parsed.questionType ?? parsed.question_type);
  const currentTopic = text(parsed.currentTopic ?? parsed.current_topic, 240);
  const topicChanged = booleanField(parsed.topicChanged ?? parsed.topic_changed);
  const pendingQuestionRelevant = booleanField(
    parsed.pendingQuestionRelevant ?? parsed.pending_question_relevant,
  );
  const flowAction = normalizeFlowAction(parsed.flowAction ?? parsed.flow_action, runtime);
  const spokenAnswer = text(parsed.spokenAnswer ?? parsed.spoken_answer, maximumAnswerCharacters);
  if (!intent || !spokenAnswer || !currentTopic || topicChanged === null || pendingQuestionRelevant === null) {
    return Object.freeze({ valid: false, reason: 'required_field_missing' });
  }
  if (!flowAction) {
    return Object.freeze({ valid: false, reason: 'invalid_flow_action' });
  }
  const requestedEntityKeys = list(parsed.selectedEntityKeys ?? parsed.selected_entity_keys, maximumEntities);
  const requestedSourceIds = list(parsed.evidenceSourceIds ?? parsed.evidence_source_ids, maximumSources);
  const facts = assertedFacts(parsed.assertedFacts ?? parsed.asserted_facts);
  const canonicalEntityResult = canonicalEntities(envelope, requestedEntityKeys);
  const selectedEntities = canonicalEntityResult.resolved;
  if (canonicalEntityResult.unresolved.length) {
    return Object.freeze({ valid: false, reason: 'unpublished_entity_selected' });
  }
  const canonicalSourceResult = canonicalSources(envelope, requestedSourceIds);
  const citedSources = canonicalSourceResult.resolved;
  if (canonicalSourceResult.unresolved.length) {
    return Object.freeze({ valid: false, reason: 'unpublished_evidence_selected' });
  }
  if (envelope.found && citedSources.length === 0) {
    return Object.freeze({ valid: false, reason: 'evidence_required' });
  }
  if (!envelope.found) return Object.freeze({ valid: false, reason: 'verified_evidence_missing' });
  if (facts === null || facts.length === 0) return Object.freeze({ valid: false, reason: 'asserted_facts_required' });
  const canonicalFactSources = facts.map((fact) => canonicalSources(envelope, [fact.sourceId]));
  if (canonicalFactSources.some((result) => result.unresolved.length)) {
    return Object.freeze({ valid: false, reason: 'asserted_fact_source_not_cited' });
  }
  const citedSourceIds = new Set(citedSources.map((source) => source.id));
  if (canonicalFactSources.some((result) => !citedSourceIds.has(result.resolved[0]?.id))) {
    return Object.freeze({ valid: false, reason: 'asserted_fact_source_not_cited' });
  }
  if (facts.some((fact, index) => !identity(canonicalFactSources[index].resolved[0].content).includes(identity(fact.value)))) {
    return Object.freeze({ valid: false, reason: 'unsupported_asserted_fact' });
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
    currentTopic,
    topicChanged,
    pendingQuestionRelevant,
    flowAction,
    spokenAnswer,
    selectedEntityKeys: selectedEntities.map((item) => item.key),
    selectedEntities: selectedEntities.map((item) => ({ ...item })),
    evidenceSourceIds: citedSources.map((source) => source.id),
    assertedFacts: facts.map((fact, index) => ({
      ...fact, sourceId: canonicalFactSources[index].resolved[0].id,
    })),
  });
}

export function validateGroundedLlmUnderstanding(raw, envelope, runtime = {}) {
  const parsed = parseObject(raw);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  const intent = text(parsed.intent, maximumIntentCharacters);
  const questionType = normalizeQuestionType(parsed.questionType ?? parsed.question_type);
  const currentTopic = text(parsed.currentTopic ?? parsed.current_topic, 240);
  const topicChanged = booleanField(parsed.topicChanged ?? parsed.topic_changed);
  const pendingQuestionRelevant = booleanField(
    parsed.pendingQuestionRelevant ?? parsed.pending_question_relevant,
  );
  const flowAction = normalizeFlowAction(parsed.flowAction ?? parsed.flow_action, runtime);
  if (!intent || !currentTopic || topicChanged === null || pendingQuestionRelevant === null) {
    return Object.freeze({ valid: false, reason: 'required_field_missing' });
  }
  if (!flowAction) {
    return Object.freeze({ valid: false, reason: 'invalid_flow_action' });
  }
  const requestedEntityKeys = list(parsed.selectedEntityKeys ?? parsed.selected_entity_keys, maximumEntities);
  const canonicalEntityResult = canonicalEntities(envelope, requestedEntityKeys);
  const selectedEntities = canonicalEntityResult.resolved;
  if (canonicalEntityResult.unresolved.length) {
    return Object.freeze({ valid: false, reason: 'unpublished_entity_selected' });
  }
  return Object.freeze({
    valid: true,
    intent,
    questionType,
    currentTopic,
    topicChanged,
    pendingQuestionRelevant,
    flowAction,
    selectedEntityKeys: selectedEntities.map((item) => item.key),
    selectedEntities: selectedEntities.map((item) => ({ ...item })),
    evidenceSourceIds: [],
    assertedFacts: [],
  });
}

export { questionTypes };
