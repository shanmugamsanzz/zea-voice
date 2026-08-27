import { resolveLiveMemoryConfiguration } from './live-memory-config.js';

const activeCalls = new Map();
const maximumMessages = 2_000;
const maximumMessageCharacters = 2_000;
const maximumEntities = 20;
export const genericConversationStateFields = Object.freeze([
  'scope', 'activeEntity', 'activeCategory', 'latestIntent', 'pendingClarification',
  'activeTool', 'collectedToolFields', 'citedEvidence',
  'currentTopic', 'knownEntities', 'pendingQuestion', 'collectedInformation',
  'recentTurns', 'lastAnswer', 'activeToolRequest', 'language', 'requestType',
  'requestedFacts', 'constraints', 'contextualReferences', 'contextDependent', 'comparisonEntities',
]);

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${name} is required for generic conversation state`);
  return result;
}

function stateKey(identity) {
  return JSON.stringify([
    required(identity.tenantId, 'tenantId'), required(identity.agentId, 'agentId'),
    required(identity.callId, 'callId'),
  ]);
}

export function isolatedCallMemoryKey(identity) {
  return stateKey(identity);
}

function cleanText(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function cleanLanguage(value, fallback = 'en') {
  const match = cleanText(value, 40).toLocaleLowerCase().match(/\b([a-z]{2,3})(?:-[a-z]{2})?\b/u);
  return match?.[1] ?? fallback;
}

function cleanMessage(value) {
  const role = value?.role === 'assistant' ? 'assistant' : (value?.role === 'user' ? 'user' : null);
  const content = cleanText(value?.content, maximumMessageCharacters);
  return role && content ? Object.freeze({ role, content, at: Number(value.at ?? Date.now()) }) : null;
}

function recent(messages, turns) {
  let users = 0;
  let start = messages.length;
  while (start > 0) {
    start -= 1;
    if (messages[start].role === 'user') users += 1;
    if (users >= turns) break;
  }
  return messages.slice(start);
}

function cleanEntity(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = cleanText(value.id ?? value.recordId ?? value.itemId, 100);
  const entityType = cleanText(value.entityType ?? value.type, 40).toLocaleUpperCase();
  const categoryEntity = entityType === 'CATEGORY';
  const key = cleanText(value.key ?? value.itemKey ?? (categoryEntity ? value.categoryKey : null), 160);
  const name = cleanText(value.name ?? (categoryEntity ? value.category : null), 240);
  if (!id && !key && !name) return null;
  return Object.freeze({
    id: id || null, recordId: id || null,
    key: key || null, name: name || key || id,
    category: cleanText(value.category, 240) || null,
    categoryKey: cleanText(value.categoryKey, 160) || null,
  });
}

function uniqueEntities(values = []) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const entity = cleanEntity(value);
    const identity = cleanText(entity?.id ?? entity?.key ?? entity?.name, 240).toLocaleLowerCase();
    if (!entity || !identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(entity);
    if (output.length >= maximumEntities) break;
  }
  return output;
}

function cleanPending(value) {
  if (!value) return null;
  const object = typeof value === 'object' ? value : { key: value, text: value };
  const key = cleanText(object.key, 120);
  const text = cleanText(object.text, 500);
  const kind = cleanText(object.kind, 40);
  const attemptCount = Math.max(0, Math.min(20, Number.parseInt(object.attemptCount ?? 0, 10) || 0));
  const previousQuestions = cleanList(object.previousQuestions, 5);
  const candidateRecordIds = cleanList(object.candidateRecordIds, 5);
  const missingFactType = cleanText(object.missingFactType, 80) || null;
  const reason = cleanText(object.reason, 80) || null;
  return key || text ? Object.freeze({
    key: key || null, text: text || key, kind: kind || null,
    attemptCount,
    previousQuestions: Object.freeze(previousQuestions),
    candidateRecordIds: Object.freeze(candidateRecordIds),
    missingFactType,
    reason,
  }) : null;
}

function clarificationIdentity(value) {
  return cleanText(value, 500).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function cleanCategory(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanText(value.id ?? value.recordId, 100);
  const key = cleanText(value.categoryKey ?? value.key, 160);
  const name = cleanText(value.category ?? value.name, 240);
  if (!id && !key && !name) return null;
  return Object.freeze({
    id: id || null,
    recordId: id || null,
    key: key || null,
    name: name || key || id,
    parentKey: cleanText(value.parentKey, 160) || null,
  });
}

function cleanEvidence(values = []) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const source = typeof value === 'object' && value !== null ? value : { id: value };
    const id = cleanText(source.id ?? source.evidenceId, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(Object.freeze({
      id,
      recordId: cleanText(source.recordId, 160) || null,
      recordType: cleanText(source.recordType, 80) || null,
    }));
    if (output.length >= 20) break;
  }
  return output;
}

export function configuredMessageQuestion(message, key = 'configured_message_question') {
  const content = cleanText(message, maximumMessageCharacters);
  const questionEnd = Math.max(content.lastIndexOf('?'), content.lastIndexOf('？'));
  if (questionEnd < 0) return null;
  const prefix = content.slice(0, questionEnd);
  const questionStart = Math.max(
    prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
    prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'),
  );
  const question = cleanText(content.slice(questionStart + 1, questionEnd + 1), 500);
  return question ? cleanPending({ key, text: question, kind: 'conversation' }) : null;
}

export function seedConfiguredQuestion(memory, message, key = 'configured_message_question') {
  if (!memory?.snapshot || !memory?.setPendingQuestion) return null;
  const snapshot = memory.snapshot();
  if (snapshot.pendingQuestion) return snapshot.pendingQuestion;
  const pending = configuredMessageQuestion(message, key);
  if (!pending) return null;
  memory.setPendingQuestion(pending);
  return memory.snapshot().pendingQuestion;
}

function cleanToolRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanText(value.id, 100);
  const name = cleanText(value.name ?? value.action, 100);
  const status = cleanText(value.status, 40) || 'pending';
  const authorizationRecordId = cleanText(value.authorizationRecordId, 120);
  const selectedEntityKey = cleanText(value.selectedEntityKey, 160);
  const selectedEntityName = cleanText(value.selectedEntityName, 240);
  const catalogRecordId = cleanText(value.catalogRecordId, 120);
  return id || name ? Object.freeze({
    id: id || null, name: name || null, status,
    ...(authorizationRecordId ? { authorizationRecordId } : {}),
    ...(selectedEntityKey ? { selectedEntityKey } : {}),
    ...(selectedEntityName ? { selectedEntityName } : {}),
    ...(catalogRecordId ? { catalogRecordId } : {}),
  }) : null;
}

function cleanInformation(value = {}, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = cleanText(key, 64).toLocaleLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(normalizedKey)
      || (allowedKeys && !allowedKeys.has(normalizedKey))
      || entry === undefined || entry === null || String(entry).trim() === '') return [];
    if (typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) {
      return [[normalizedKey, entry]];
    }
    return [[normalizedKey, cleanText(entry, 500)]];
  }));
}

function cleanList(value, maximum = 20) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => cleanText(entry, 160)).filter(Boolean))].slice(0, maximum)
    : [];
}

function cleanRequestType(value) {
  const normalized = cleanText(value, 64).toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : null;
}

function publicState(state) {
  const activeEntity = state.activeEntity ? Object.freeze({ ...state.activeEntity }) : null;
  const activeCategory = state.activeCategory ? Object.freeze({ ...state.activeCategory }) : null;
  const pendingClarification = state.pendingClarification
    ? Object.freeze({ ...state.pendingClarification }) : null;
  const activeTool = state.activeToolRequest ? Object.freeze({ ...state.activeToolRequest }) : null;
  const collectedToolFields = Object.freeze({ ...state.collectedInformation });
  return Object.freeze({
    scope: state.scope,
    activeEntity,
    activeCategory,
    latestIntent: state.requestType,
    pendingClarification,
    activeTool,
    collectedToolFields,
    citedEvidence: Object.freeze(state.citedEvidence.map((source) => Object.freeze({ ...source }))),
    currentTopic: state.currentTopic,
    knownEntities: Object.freeze(state.knownEntities.map((entity) => ({ ...entity }))),
    comparisonEntities: Object.freeze(state.comparisonEntities
      .map((entity) => ({ ...entity }))),
    pendingQuestion: state.pendingQuestion ? Object.freeze({ ...state.pendingQuestion }) : null,
    collectedInformation: collectedToolFields,
    recentTurns: Object.freeze(state.recentTurns.map((turn) => ({ ...turn }))),
    lastAnswer: state.lastAnswer,
    activeToolRequest: activeTool,
    language: state.language,
    requestType: state.requestType,
    requestedFacts: Object.freeze([...state.requestedFacts]),
    constraints: Object.freeze([...state.constraints]),
    contextualReferences: Object.freeze([...state.contextualReferences]),
    contextDependent: state.contextDependent,
  });
}

export function openGenericConversationState(identity, settings = {}, now = Date.now(), initial = {}) {
  const key = stateKey(identity);
  const configuration = resolveLiveMemoryConfiguration(settings);
  const fieldKeys = new Set(configuration.fields.map((field) => field.key));
  // Cross-call restoration is supplied only by the orchestrator after its UI
  // context policy authorizes it. This store never discovers another call.
  const state = {
    scope: Object.freeze({
      tenantId: required(identity.tenantId, 'tenantId'),
      agentId: required(identity.agentId, 'agentId'),
      callId: required(identity.callId, 'callId'),
    }),
    currentTopic: cleanText(initial.currentTopic, 240) || null,
    knownEntities: uniqueEntities(initial.knownEntities),
    comparisonEntities: uniqueEntities(initial.comparisonEntities),
    activeEntity: cleanEntity(initial.activeEntity)
      ?? uniqueEntities(initial.knownEntities)[0] ?? null,
    activeCategory: cleanCategory(initial.activeCategory),
    pendingQuestion: cleanPending(initial.pendingQuestion ?? initial.pendingClarification),
    pendingClarification: cleanPending(initial.pendingClarification),
    collectedInformation: cleanInformation(
      initial.collectedToolFields ?? initial.collectedInformation ?? initial.collectedData ?? {}, fieldKeys,
    ),
    recentTurns: recent((initial.recentTurns ?? initial.messages ?? []).map(cleanMessage).filter(Boolean),
      configuration.recentTurns),
    lastAnswer: cleanText(initial.lastAnswer, maximumMessageCharacters) || null,
    activeToolRequest: cleanToolRequest(initial.activeTool ?? initial.activeToolRequest),
    language: cleanLanguage(initial.language
      ?? settings.conversationLanguage ?? settings.defaultLanguage ?? settings.language),
    requestType: cleanRequestType(initial.latestIntent ?? initial.requestType ?? initial.questionType),
    citedEvidence: cleanEvidence(initial.citedEvidence),
    requestedFacts: cleanList(initial.requestedFacts),
    constraints: cleanList(initial.constraints),
    contextualReferences: cleanList(initial.contextualReferences),
    contextDependent: initial.contextDependent === true,
  };
  state.activeCategory ??= cleanCategory(state.activeEntity);
  let activeTurnToken = null;
  let resumePending = false;
  activeCalls.set(key, state);
  const current = (token) => token === undefined || token === null || token === activeTurnToken;
  return Object.freeze({
    beginTurn(token) {
      activeTurnToken = token ?? Symbol('conversation-turn');
      resumePending = false;
      return activeTurnToken;
    },
    cancelTurn(token) {
      if (token === undefined || token === activeTurnToken) activeTurnToken = null;
      resumePending = false;
    },
    fieldSchemas: () => configuration.fields.map((field) => ({ ...field })),
    configuration: () => Object.freeze({ mode: configuration.mode, recentTurns: configuration.recentTurns }),
    restoreValidatedState(snapshot = {}, options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const scope = snapshot.scope ?? {};
      if (scope.tenantId !== state.scope.tenantId
        || scope.agentId !== state.scope.agentId
        || scope.callId !== state.scope.callId) {
        throw new Error('Conversation state rollback scope mismatch');
      }
      state.currentTopic = cleanText(snapshot.currentTopic, 240) || null;
      state.knownEntities = uniqueEntities(snapshot.knownEntities);
      state.comparisonEntities = uniqueEntities(snapshot.comparisonEntities);
      state.activeEntity = cleanEntity(snapshot.activeEntity);
      state.activeCategory = cleanCategory(snapshot.activeCategory);
      state.pendingQuestion = cleanPending(snapshot.pendingQuestion);
      state.pendingClarification = cleanPending(snapshot.pendingClarification);
      state.collectedInformation = cleanInformation(
        snapshot.collectedToolFields ?? snapshot.collectedInformation ?? {}, fieldKeys,
      );
      const restoredTurns = (snapshot.recentTurns ?? []).map(cleanMessage).filter(Boolean);
      state.recentTurns = configuration.mode === 'full_current_call'
        ? restoredTurns.slice(-maximumMessages) : recent(restoredTurns, configuration.recentTurns);
      state.lastAnswer = cleanText(snapshot.lastAnswer, maximumMessageCharacters) || null;
      state.activeToolRequest = cleanToolRequest(snapshot.activeTool ?? snapshot.activeToolRequest);
      state.language = cleanLanguage(snapshot.language, state.language);
      state.requestType = cleanRequestType(snapshot.latestIntent ?? snapshot.requestType);
      state.citedEvidence = cleanEvidence(snapshot.citedEvidence);
      state.requestedFacts = cleanList(snapshot.requestedFacts);
      state.constraints = cleanList(snapshot.constraints);
      state.contextualReferences = cleanList(snapshot.contextualReferences);
      state.contextDependent = snapshot.contextDependent === true;
      resumePending = false;
      return Object.freeze({ applied: true, state: publicState(state) });
    },
    append(message, options = {}) {
      if (!current(options.turnToken)) return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      const entry = cleanMessage(message);
      if (!entry) return publicState(state);
      state.recentTurns.push(entry);
      state.recentTurns = configuration.mode === 'full_current_call'
        ? state.recentTurns.slice(-maximumMessages) : recent(state.recentTurns, configuration.recentTurns);
      return publicState(state);
    },
    observeAssistantResponse(response, options = {}) {
      if (!current(options.turnToken)) return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      state.lastAnswer = cleanText(response, maximumMessageCharacters) || state.lastAnswer;
      const normalized = state.lastAnswer?.toLocaleLowerCase() ?? '';
      const pendingField = configuration.fields.find((field) => (
        state.collectedInformation[field.key] === undefined
        && normalized.includes(cleanText(field.question, 500).toLocaleLowerCase())
      ));
      if (pendingField) state.pendingQuestion = cleanPending({
        key: pendingField.key, text: pendingField.question, kind: 'field',
      });
      // Arbitrary spoken questions are not durable workflow state. The
      // unified turn explicitly stores only a validated configured guidance,
      // field or confirmation question. This prevents clarifications and safe
      // fallback text from contaminating later turns.
      return publicState(state);
    },
    reconcileInterruptedAssistantResponse(response, previous = {}, options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const audible = cleanText(response, maximumMessageCharacters);
      state.lastAnswer = audible || cleanText(previous.lastAnswer, maximumMessageCharacters) || null;
      const priorTurns = (previous.recentTurns ?? []).map(cleanMessage).filter(Boolean);
      state.recentTurns = audible
        ? [...priorTurns, { role: 'assistant', content: audible }]
        : priorTurns;
      state.recentTurns = configuration.mode === 'full_current_call'
        ? state.recentTurns.slice(-maximumMessages) : recent(state.recentTurns, configuration.recentTurns);
      return Object.freeze({ applied: true, audible: Boolean(audible), state: publicState(state) });
    },
    applyGroundedDecision(decision = {}, options = {}) {
      if (!current(options.turnToken)) return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      const update = decision.stateUpdate && typeof decision.stateUpdate === 'object'
        ? decision.stateUpdate : decision;
      const topic = cleanText(update.currentTopic ?? decision.currentTopic, 240);
      if (topic) state.currentTopic = topic;
      const selected = uniqueEntities(update.knownEntities ?? decision.selectedEntities ?? []);
      if (selected.length) {
        // An explicit latest-turn selection replaces stale entities. A true
        // contextual follow-up may retain earlier entities for comparisons or
        // references. This remains industry-neutral and decision-controlled.
        const explicitSelection = update.contextDependent !== true;
        const singleExplicitSelection = explicitSelection && selected.length === 1;
        const previousEntityIdentity = cleanText(
          state.activeEntity?.id ?? state.activeEntity?.key ?? state.activeEntity?.name,
          240,
        ).toLocaleLowerCase();
        const nextEntityIdentity = cleanText(
          selected[0]?.id ?? selected[0]?.key ?? selected[0]?.name,
          240,
        ).toLocaleLowerCase();
        state.knownEntities = update.contextDependent === true
          ? uniqueEntities([...selected, ...state.knownEntities])
          : selected;
        if (selected.length === 1) {
          state.activeEntity = selected[0];
          state.activeCategory = cleanCategory(selected[0]) ?? state.activeCategory;
          state.comparisonEntities = [];
        } else {
          // Multi-record evidence (for example a comparison) has no canonical
          // single winner. Never persist the first array element as though the
          // caller selected it.
          state.activeEntity = null;
          const categories = selected.map(cleanCategory).filter(Boolean);
          state.comparisonEntities = selected;
          const categoryKeys = new Set(categories.map((entry) => (
            cleanText(entry.key ?? entry.name, 160).toLocaleLowerCase()
          )).filter(Boolean));
          state.activeCategory = categoryKeys.size === 1 ? categories[0] : null;
        }
        if (singleExplicitSelection) {
          state.pendingQuestion = null;
          state.pendingClarification = null;
          if (previousEntityIdentity && nextEntityIdentity !== previousEntityIdentity
            && state.activeToolRequest) {
            const toolEntity = cleanText(
              state.activeToolRequest.selectedEntityKey ?? state.activeToolRequest.selectedEntityName,
              240,
            ).toLocaleLowerCase();
            if (toolEntity
              && ![nextEntityIdentity, cleanText(selected[0].key, 160).toLocaleLowerCase()].includes(toolEntity)) {
              state.activeToolRequest = null;
              state.collectedInformation = {};
            }
          }
        }
      } else if (update.contextDependent === false
        && cleanRequestType(update.requestType ?? update.questionType) === 'category_overview') {
        // A category is a deterministic browse context, not an arbitrary
        // child selection. Clear the previous item while retaining the
        // category topic supplied by the grounded runtime.
        state.knownEntities = [];
        state.activeEntity = null;
        state.activeCategory = cleanCategory({ key: topic, name: topic });
        state.pendingQuestion = null;
        state.pendingClarification = null;
      }
      const updates = cleanInformation(
        update.collectedInformation ?? decision.fieldUpdates ?? {}, fieldKeys,
      );
      for (const [field, value] of Object.entries(updates)) state.collectedInformation[field] = value;
      if (state.pendingQuestion?.key && Object.hasOwn(updates, state.pendingQuestion.key)) {
        state.pendingQuestion = null;
        state.pendingClarification = null;
      } else if ((update.pendingQuestionRelevant ?? decision.pendingQuestionRelevant) === false) {
        state.pendingQuestion = null;
        state.pendingClarification = null;
      }
      else if (decision.flowAction === 'side_question' && state.pendingQuestion) resumePending = true;
      if (String(decision.decision ?? '').toLocaleLowerCase() !== 'clarify'
        && decision.clarification == null) state.pendingClarification = null;
      // decision.pendingQuestion is only a proposal. The unified turn policy
      // validates it before persisting either configured workflow state or
      // bounded clarification-recovery context.
      if (update.language ?? decision.language) {
        state.language = cleanLanguage(update.language ?? decision.language, state.language);
      }
      if (update.requestType !== undefined || update.questionType !== undefined) {
        state.requestType = cleanRequestType(update.requestType ?? update.questionType);
      }
      if (decision.evidenceIds !== undefined || update.citedEvidence !== undefined) {
        state.citedEvidence = cleanEvidence(update.citedEvidence ?? decision.evidenceIds);
      }
      if (update.requestedFacts !== undefined) state.requestedFacts = cleanList(update.requestedFacts);
      if (update.constraints !== undefined) state.constraints = cleanList(update.constraints);
      if (update.contextualReferences !== undefined) {
        state.contextualReferences = cleanList(update.contextualReferences);
      }
      if (update.contextDependent !== undefined) {
        state.contextDependent = update.contextDependent === true;
      }
      if (update.activeToolRequest !== undefined || decision.activeToolRequest !== undefined) {
        state.activeToolRequest = cleanToolRequest(
          update.activeToolRequest ?? decision.activeToolRequest,
        );
      }
      return Object.freeze({ applied: true, updates: Object.freeze({ ...updates }), state: publicState(state) });
    },
    recordClarification(value = {}, options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const question = cleanText(value.question ?? value.text, 500);
      if (!question) return Object.freeze({ applied: false, reason: 'question_required', state: publicState(state) });
      const previous = cleanPending(state.pendingClarification);
      const history = cleanList([
        ...(previous?.previousQuestions ?? []), previous?.text, question,
      ].filter(Boolean), 5);
      const currentIdentity = clarificationIdentity(question);
      const repeated = [previous?.text, ...(previous?.previousQuestions ?? [])]
        .some((entry) => clarificationIdentity(entry) === currentIdentity);
      state.pendingClarification = cleanPending({
        key: value.key ?? value.reason ?? 'grounded_clarification',
        text: question,
        kind: value.kind ?? 'clarification',
        attemptCount: (previous?.attemptCount ?? 0) + 1,
        previousQuestions: history,
        candidateRecordIds: value.candidateRecordIds,
        missingFactType: value.missingFactType,
        reason: value.reason,
      });
      return Object.freeze({
        applied: true, repeated, attemptCount: state.pendingClarification.attemptCount,
        state: publicState(state),
      });
    },
    clearClarification(options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      state.pendingClarification = null;
      if (['clarification', 'ambiguity', 'conflict', 'no_evidence']
        .includes(state.pendingQuestion?.kind)) state.pendingQuestion = null;
      return Object.freeze({ applied: true, state: publicState(state) });
    },
    // Transitional API guards keep rolling workers safe while the orchestrator
    // is upgraded. They do not perform text/keyword field extraction.
    captureUserUtterance() {
      return Object.freeze({ updates: Object.freeze({}), state: publicState(state) });
    },
    mergeCollectedData(values = {}) {
      const updates = cleanInformation(values, fieldKeys);
      Object.assign(state.collectedInformation, updates);
      return publicState(state);
    },
    canRunAction(actionKey) {
      return cleanText(state.activeToolRequest?.name, 100).toLocaleLowerCase()
        === cleanText(actionKey, 100).toLocaleLowerCase();
    },
    activateAction(actionKey) {
      state.activeToolRequest = cleanToolRequest({ name: actionKey, status: 'collecting_information' });
      return publicState(state);
    },
    applyKnowledge(knowledge = {}) {
      const selection = knowledge.catalogSelection ?? {};
      const selectedItem = cleanEntity(selection.item);
      const selectedCategory = cleanCategory(selection.category);
      if (selectedItem) {
        state.activeEntity = selectedItem;
        state.activeCategory = cleanCategory(selectedItem) ?? selectedCategory ?? state.activeCategory;
        state.knownEntities = [selectedItem];
        state.currentTopic = selectedItem.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
      } else if (selectedCategory) {
        state.activeEntity = null;
        state.activeCategory = selectedCategory;
        state.knownEntities = [];
        state.currentTopic = selectedCategory.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
      }
      return publicState(state);
    },
    applyCanonicalTopicResolution(resolution = {}, options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const scope = resolution.scope ?? {};
      if (scope.tenantId !== state.scope.tenantId
        || scope.agentId !== state.scope.agentId
        || scope.callId !== state.scope.callId) {
        throw new Error('Canonical topic resolution scope mismatch');
      }
      const mode = cleanText(resolution.mode, 40).toLocaleUpperCase();
      const comparisons = uniqueEntities(resolution.comparisonEntities)
        .filter((entity) => Boolean(entity.id));
      if (mode === 'COMPARISON') {
        if (comparisons.length < 2) {
          return Object.freeze({ applied: false, reason: 'canonical_comparison_required', state: publicState(state) });
        }
        state.comparisonEntities = comparisons;
        state.knownEntities = comparisons;
        state.activeEntity = null;
        const categories = comparisons.map((entity) => cleanCategory({
          categoryKey: entity.categoryKey, category: entity.category,
        })).filter(Boolean);
        const categoryKeys = new Set(categories.map((category) => (
          cleanText(category.key, 160).toLocaleLowerCase()
        )));
        state.activeCategory = categoryKeys.size === 1 ? categories[0] : null;
        state.currentTopic = comparisons.map((entity) => entity.name).join(' / ');
      } else if (mode === 'EXPLICIT') {
        const entity = cleanEntity(resolution.activeEntity);
        const category = cleanCategory(resolution.activeCategory);
        if (entity?.id) {
          state.activeEntity = entity;
          state.activeCategory = cleanCategory({
            categoryKey: entity.categoryKey, category: entity.category,
          });
          state.knownEntities = [entity];
          state.comparisonEntities = [];
          state.currentTopic = entity.name;
        } else if (category?.id) {
          state.activeEntity = null;
          state.activeCategory = category;
          state.knownEntities = [];
          state.comparisonEntities = [];
          state.currentTopic = category.name;
        }
      } else if (mode === 'CONTEXTUAL') {
        const entity = cleanEntity(resolution.activeEntity);
        const category = cleanCategory(resolution.activeCategory);
        if (entity?.id) {
          state.activeEntity = entity;
          state.activeCategory = cleanCategory({
            categoryKey: entity.categoryKey, category: entity.category,
          }) ?? state.activeCategory;
          state.currentTopic = entity.name;
        } else if (category?.id) {
          state.activeEntity = null;
          state.activeCategory = category;
          state.currentTopic = category.name;
        }
        if (comparisons.length) state.comparisonEntities = comparisons;
      }
      return Object.freeze({ applied: true, mode, state: publicState(state) });
    },

    applyResolvedContext(context = {}, options = {}) {
      if (!current(options.turnToken)) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const entity = cleanEntity(context.entity);
      const category = cleanCategory(context.category ?? entity);
      if (entity && context.explicitEntity === true) {
        const priorIdentity = cleanText(
          state.activeEntity?.id ?? state.activeEntity?.key ?? state.activeEntity?.name,
          240,
        ).toLocaleLowerCase();
        const nextIdentity = cleanText(entity.id ?? entity.key ?? entity.name, 240).toLocaleLowerCase();
        const toolEntityIdentities = [
          state.activeToolRequest?.selectedEntityKey,
          state.activeToolRequest?.selectedEntityName,
        ].map((value) => cleanText(value, 240).toLocaleLowerCase()).filter(Boolean);
        const nextEntityIdentities = [entity.id, entity.key, entity.name]
          .map((value) => cleanText(value, 240).toLocaleLowerCase()).filter(Boolean);
        state.activeEntity = entity;
        state.activeCategory = category;
        state.knownEntities = [entity];
        state.currentTopic = entity.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
        const toolBelongsToDifferentEntity = toolEntityIdentities.length > 0
          && !toolEntityIdentities.some((identity) => nextEntityIdentities.includes(identity));
        if (state.activeToolRequest
          && ((priorIdentity && priorIdentity !== nextIdentity) || toolBelongsToDifferentEntity)) {
          state.activeToolRequest = null;
          state.collectedInformation = {};
        }
      } else if (category && context.explicitCategory === true) {
        state.activeEntity = null;
        state.activeCategory = category;
        state.knownEntities = [];
        state.currentTopic = category.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
        if (state.activeToolRequest?.selectedEntityKey || state.activeToolRequest?.selectedEntityName) {
          state.activeToolRequest = null;
          state.collectedInformation = {};
        }
      }
      // This early phase intentionally does not mutate lastAnswer,
      // citedEvidence or requestType. Those belong to the validated decision.
      return Object.freeze({ applied: true, state: publicState(state) });
    },
    applyEngineDecision(decision = {}, context = {}) {
      state.citedEvidence = cleanEvidence(context.citedEvidence ?? decision.evidenceIds);
      state.requestType = cleanRequestType(context.intent ?? decision.reason) ?? state.requestType;
      const entity = cleanEntity(context.entity);
      const category = cleanCategory(context.category ?? entity);
      if (entity && context.explicitEntity !== false) {
        const priorIdentity = cleanText(
          state.activeEntity?.id ?? state.activeEntity?.key ?? state.activeEntity?.name,
          240,
        ).toLocaleLowerCase();
        const nextIdentity = cleanText(entity.id ?? entity.key ?? entity.name, 240).toLocaleLowerCase();
        const toolEntityIdentities = [
          state.activeToolRequest?.selectedEntityKey,
          state.activeToolRequest?.selectedEntityName,
        ].map((value) => cleanText(value, 240).toLocaleLowerCase()).filter(Boolean);
        const nextEntityIdentities = [entity.id, entity.key, entity.name]
          .map((value) => cleanText(value, 240).toLocaleLowerCase()).filter(Boolean);
        state.activeEntity = entity;
        state.activeCategory = category;
        state.knownEntities = [entity];
        state.currentTopic = entity.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
        const toolBelongsToDifferentEntity = toolEntityIdentities.length > 0
          && !toolEntityIdentities.some((identity) => nextEntityIdentities.includes(identity));
        if (state.activeToolRequest
          && ((priorIdentity && priorIdentity !== nextIdentity) || toolBelongsToDifferentEntity)) {
          state.activeToolRequest = null;
          state.collectedInformation = {};
        }
      } else if (category && context.explicitCategory === true) {
        state.activeEntity = null;
        state.activeCategory = category;
        state.knownEntities = [];
        state.currentTopic = category.name;
        state.pendingQuestion = null;
        state.pendingClarification = null;
        if (state.activeToolRequest?.selectedEntityKey || state.activeToolRequest?.selectedEntityName) {
          state.activeToolRequest = null;
          state.collectedInformation = {};
        }
      }
      if (decision.type === 'CLARIFY') {
        const clarificationPrompt = cleanText(decision.clarification?.prompt, 500) || null;
        state.pendingClarification = Object.freeze({
          key: cleanText(decision.reason, 120) || null,
          text: clarificationPrompt,
          kind: cleanText(decision.clarification?.kind, 40) || 'ambiguity',
        });
        state.pendingQuestion = clarificationPrompt
          ? cleanPending(state.pendingClarification) : null;
      }
      if (decision.type === 'TOOL' && decision.tool) {
        state.activeToolRequest = cleanToolRequest({
          name: decision.tool.name,
          status: 'collecting_information',
          authorizationRecordId: decision.tool.authorizationEvidenceId,
          selectedEntityKey: entity?.key,
          selectedEntityName: entity?.name,
        });
        Object.assign(state.collectedInformation, cleanInformation(decision.tool.input, fieldKeys));
      }
      return publicState(state);
    },
    completeQuestion() { return publicState(state); },
    setPosition({ currentTopic, pendingQuestion } = {}) {
      if (currentTopic !== undefined) state.currentTopic = cleanText(currentTopic, 240) || null;
      if (pendingQuestion !== undefined) {
        state.pendingQuestion = cleanPending(pendingQuestion);
        state.pendingClarification = state.pendingQuestion?.kind === 'clarification'
          ? state.pendingQuestion : null;
      }
      return publicState(state);
    },
    setPendingQuestion(value) {
      state.pendingQuestion = cleanPending(value);
      state.pendingClarification = ['clarification', 'ambiguity', 'conflict', 'no_evidence', 'technical']
        .includes(state.pendingQuestion?.kind) ? state.pendingQuestion : null;
      return publicState(state);
    },
    prepareAssistantResponse(response, { resumePending: shouldResume = true } = {}) {
      const answer = cleanText(response, maximumMessageCharacters);
      if (!answer) return '';
      const completedQuestions = configuration.fields.filter((field) => (
        state.collectedInformation[field.key] !== undefined
      )).map((field) => cleanText(field.question, 500).toLocaleLowerCase());
      const parts = answer.split(/(?<=[.!?])\s+/u).filter(Boolean).filter((part) => (
        !completedQuestions.includes(cleanText(part, 500).toLocaleLowerCase())
      ));
      if (shouldResume && resumePending && state.pendingQuestion?.text
        && !parts.some((part) => cleanText(part, 500).toLocaleLowerCase()
          === state.pendingQuestion.text.toLocaleLowerCase())) parts.push(state.pendingQuestion.text);
      if (shouldResume) resumePending = false;
      return parts.join(' ').trim();
    },
    setLanguage(value) { state.language = cleanLanguage(value, state.language); return publicState(state); },
    setActiveToolRequest(value, options = {}) {
      if (!current(options.turnToken)) return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      state.activeToolRequest = cleanToolRequest(value);
      return publicState(state);
    },
    refreshRunningSummary: () => publicState(state),
    snapshot: () => publicState(state),
    promptMessages: () => state.recentTurns.map((message) => ({ ...message })),
    close() { activeCalls.delete(key); activeTurnToken = null; },
  });
}

export function activeGenericConversationStateCount() {
  return activeCalls.size;
}

export function compactGenericConversationState(snapshot = {}, maximumCharacters = 1_000) {
  const context = {
    memoryVersion: 1,
    activeEntity: snapshot.activeEntity ?? null,
    activeCategory: snapshot.activeCategory ?? null,
    latestIntent: snapshot.latestIntent ?? snapshot.requestType ?? null,
    pendingClarification: snapshot.pendingClarification ?? null,
    activeTool: snapshot.activeTool ?? snapshot.activeToolRequest ?? null,
    collectedToolFields: snapshot.collectedToolFields ?? snapshot.collectedInformation ?? {},
    citedEvidence: (snapshot.citedEvidence ?? []).slice(0, 20),
    currentTopic: snapshot.currentTopic ?? null,
    comparisonEntities: (snapshot.comparisonEntities ?? []).slice(0, 5),
    knownEntities: (snapshot.knownEntities ?? []).slice(0, 12),
    pendingQuestion: snapshot.pendingQuestion ?? null,
    collectedInformation: snapshot.collectedInformation ?? {},
    recentTurns: (snapshot.recentTurns ?? []).slice(-10),
    lastAnswer: snapshot.lastAnswer ?? null,
    activeToolRequest: snapshot.activeToolRequest ?? null,
    language: snapshot.language ?? 'en',
    requestType: snapshot.requestType ?? null,
    requestedFacts: (snapshot.requestedFacts ?? []).slice(0, 20),
    constraints: (snapshot.constraints ?? []).slice(0, 20),
    contextualReferences: (snapshot.contextualReferences ?? []).slice(0, 20),
    contextDependent: snapshot.contextDependent === true,
  };
  while (JSON.stringify(context).length > maximumCharacters && context.recentTurns.length > 2) {
    context.recentTurns.shift();
  }
  while (JSON.stringify(context).length > maximumCharacters && context.knownEntities.length > 1) {
    context.knownEntities.pop();
  }
  while (JSON.stringify(context).length > maximumCharacters && context.citedEvidence.length > 1) {
    context.citedEvidence.shift();
  }
  return Object.freeze(context);
}
