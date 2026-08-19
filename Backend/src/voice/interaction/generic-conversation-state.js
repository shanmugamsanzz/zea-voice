import { resolveLiveMemoryConfiguration } from './live-memory-config.js';

const activeCalls = new Map();
const maximumMessages = 2_000;
const maximumMessageCharacters = 2_000;
const maximumEntities = 20;
export const genericConversationStateFields = Object.freeze([
  'currentTopic', 'knownEntities', 'pendingQuestion', 'collectedInformation',
  'recentTurns', 'lastAnswer', 'activeToolRequest', 'language', 'requestType',
  'requestedFacts', 'constraints', 'contextualReferences', 'contextDependent',
]);

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${name} is required for generic conversation state`);
  return result;
}

function stateKey(identity) {
  return JSON.stringify([
    required(identity.tenantId, 'tenantId'), required(identity.workspaceId, 'workspaceId'),
    required(identity.agentId, 'agentId'), required(identity.callId, 'callId'),
  ]);
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
  const id = cleanText(value.id ?? value.itemId, 100);
  const key = cleanText(value.key ?? value.itemKey, 160);
  const name = cleanText(value.name, 240);
  if (!id && !key && !name) return null;
  return Object.freeze({
    id: id || null, key: key || null, name: name || key || id,
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
  return key || text ? Object.freeze({ key: key || null, text: text || key, kind: kind || null }) : null;
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
  return Object.freeze({
    currentTopic: state.currentTopic,
    knownEntities: Object.freeze(state.knownEntities.map((entity) => ({ ...entity }))),
    pendingQuestion: state.pendingQuestion ? Object.freeze({ ...state.pendingQuestion }) : null,
    collectedInformation: Object.freeze({ ...state.collectedInformation }),
    recentTurns: Object.freeze(state.recentTurns.map((turn) => ({ ...turn }))),
    lastAnswer: state.lastAnswer,
    activeToolRequest: state.activeToolRequest ? Object.freeze({ ...state.activeToolRequest }) : null,
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
    currentTopic: cleanText(initial.currentTopic, 240) || null,
    knownEntities: uniqueEntities(initial.knownEntities),
    pendingQuestion: cleanPending(initial.pendingQuestion),
    collectedInformation: cleanInformation(
      initial.collectedInformation ?? initial.collectedData ?? {}, fieldKeys,
    ),
    recentTurns: recent((initial.recentTurns ?? initial.messages ?? []).map(cleanMessage).filter(Boolean),
      configuration.recentTurns),
    lastAnswer: cleanText(initial.lastAnswer, maximumMessageCharacters) || null,
    activeToolRequest: cleanToolRequest(initial.activeToolRequest),
    language: cleanLanguage(initial.language
      ?? settings.conversationLanguage ?? settings.defaultLanguage ?? settings.language),
    requestType: cleanRequestType(initial.requestType ?? initial.questionType),
    requestedFacts: cleanList(initial.requestedFacts),
    constraints: cleanList(initial.constraints),
    contextualReferences: cleanList(initial.contextualReferences),
    contextDependent: initial.contextDependent === true,
  };
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
        state.knownEntities = update.contextDependent === true
          ? uniqueEntities([...selected, ...state.knownEntities])
          : selected;
      }
      const updates = cleanInformation(
        update.collectedInformation ?? decision.fieldUpdates ?? {}, fieldKeys,
      );
      for (const [field, value] of Object.entries(updates)) state.collectedInformation[field] = value;
      if (state.pendingQuestion?.key && Object.hasOwn(updates, state.pendingQuestion.key)) {
        state.pendingQuestion = null;
      } else if ((update.pendingQuestionRelevant ?? decision.pendingQuestionRelevant) === false) state.pendingQuestion = null;
      else if (decision.flowAction === 'side_question' && state.pendingQuestion) resumePending = true;
      // decision.pendingQuestion is only a proposal. The unified turn policy
      // validates it against published guidance before setPendingQuestion is
      // called, and clarification questions are intentionally turn-local.
      if (update.language ?? decision.language) {
        state.language = cleanLanguage(update.language ?? decision.language, state.language);
      }
      if (update.requestType !== undefined || update.questionType !== undefined) {
        state.requestType = cleanRequestType(update.requestType ?? update.questionType);
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
    applyKnowledge() { return publicState(state); },
    completeQuestion() { return publicState(state); },
    setPosition({ currentTopic, pendingQuestion } = {}) {
      if (currentTopic !== undefined) state.currentTopic = cleanText(currentTopic, 240) || null;
      if (pendingQuestion !== undefined) state.pendingQuestion = cleanPending(pendingQuestion);
      return publicState(state);
    },
    setPendingQuestion(value) {
      state.pendingQuestion = cleanPending(value);
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
    currentTopic: snapshot.currentTopic ?? null,
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
  return Object.freeze(context);
}
