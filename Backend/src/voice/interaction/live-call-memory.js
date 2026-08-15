import { conversationContextModes, resolveLiveMemoryConfiguration } from './live-memory-config.js';
import { captureConfiguredMemoryFields, pendingFieldFromAssistantResponse } from './live-memory-extractor.js';

const activeCalls = new Map();
const maximumFullCallMessages = 2_000;
const maximumMessageCharacters = 2_000;
const maximumRunningSummaryCharacters = 3_600;
const maximumCandidateItems = 8;
const maximumAnsweredQuestions = 100;

function requiredId(value, label) {
  const id = String(value ?? '').trim();
  if (!id) throw new TypeError(`${label} is required for live-call memory`);
  return id;
}

export function liveCallMemoryKey({ tenantId, workspaceId, agentId, callId }) {
  return JSON.stringify([
    requiredId(tenantId, 'tenantId'),
    requiredId(workspaceId, 'workspaceId'),
    requiredId(agentId, 'agentId'),
    requiredId(callId, 'callId'),
  ]);
}

function cleanMessage(message) {
  const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'user' ? 'user' : null);
  const content = String(message?.content ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximumMessageCharacters);
  return role && content ? Object.freeze({ role, content, at: Number(message.at ?? Date.now()) }) : null;
}

function retainRecentTurns(messages, turns) {
  let users = 0;
  let start = messages.length;
  while (start > 0) {
    start -= 1;
    if (messages[start].role === 'user') users += 1;
    if (users >= turns) break;
  }
  return messages.slice(start);
}

function frameText(value, maximum = 240) {
  return String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function frameLanguage(value, fallback = 'en') {
  const match = frameText(value, 40).toLocaleLowerCase().match(/\b([a-z]{2,3})(?:-[a-z]{2})?\b/u);
  return match?.[1] ?? fallback;
}

function frameItem(value = {}, fallback = {}) {
  const id = frameText(value.id ?? value.itemId ?? value.source?.recordId ?? fallback.id, 100);
  const key = frameText(value.key ?? value.itemKey ?? fallback.key, 160);
  const name = frameText(value.name ?? value.item?.name ?? fallback.name, 240);
  if (!id && !key && !name) return null;
  return Object.freeze({
    id: id || null,
    key: key || null,
    name: name || key || id,
    category: frameText(value.category ?? value.item?.category ?? fallback.category, 240) || null,
    categoryKey: frameText(value.categoryKey ?? value.item?.categoryKey ?? fallback.categoryKey, 160) || null,
    parentCategoryKey: frameText(
      value.parentCategoryKey ?? value.item?.parentCategoryKey ?? fallback.parentCategoryKey,
      160,
    ) || null,
  });
}

function frameCategory(value = {}, fallback = {}) {
  const key = frameText(value.key ?? value.categoryKey ?? fallback.key, 160);
  const name = frameText(value.name ?? value.category ?? fallback.name, 240);
  if (!key && !name) return null;
  return Object.freeze({
    key: key || null,
    name: name || key,
    parentKey: frameText(value.parentKey ?? value.parentCategoryKey ?? fallback.parentKey, 160) || null,
    description: frameText(value.description ?? value.categoryDescription ?? fallback.description, 500) || null,
  });
}

function uniqueFrameItems(values = []) {
  const items = [];
  const identities = new Set();
  for (const value of values) {
    const item = frameItem(value);
    if (!item) continue;
    const identity = frameText(item.id ?? item.key ?? item.name, 240).toLocaleLowerCase();
    if (!identity || identities.has(identity)) continue;
    identities.add(identity);
    items.push(item);
    if (items.length >= maximumCandidateItems) break;
  }
  return items;
}

function assistantQuestion(response) {
  const text = frameText(response, maximumMessageCharacters);
  if (!text.includes('?')) return null;
  return text.split(/(?<=[.!?])\s+/u).reverse().find((part) => part.includes('?')) ?? null;
}

function rememberAnsweredQuestion(state, value) {
  const question = frameText(value, 500);
  if (!question) return;
  state.answeredQuestions.delete(question);
  state.answeredQuestions.add(question);
  while (state.answeredQuestions.size > maximumAnsweredQuestions) {
    state.answeredQuestions.delete(state.answeredQuestions.values().next().value);
  }
}

function sameFrameValue(left, right) {
  return frameText(left, 500).toLocaleLowerCase() === frameText(right, 500).toLocaleLowerCase();
}

function resolvePendingQuestion(state) {
  if (!state.pendingQuestion) return;
  const answered = state.pendingQuestionText || state.pendingQuestion;
  rememberAnsweredQuestion(state, answered);
  state.lastAnsweredQuestion = answered;
  state.pendingQuestion = null;
  state.pendingQuestionText = null;
  state.pendingQuestionKind = null;
  state.resumeQuestionAfterAnswer = null;
  state.resumeQuestionContext = null;
}

function discardPendingQuestion(state) {
  state.pendingQuestion = null;
  state.pendingQuestionText = null;
  state.pendingQuestionKind = null;
  state.resumeQuestionAfterAnswer = null;
  state.resumeQuestionContext = null;
}

function schedulePendingQuestionResume(state, { groundedRelevant = false, priorTopic = null } = {}) {
  if (!state.pendingQuestion) return;
  const question = state.pendingQuestionText || state.pendingQuestion;
  if (!sameFrameValue(state.resumeQuestionAfterAnswer, question)) {
    state.flowRecovery.sideQuestions += 1;
  }
  state.resumeQuestionAfterAnswer = question;
  state.resumeQuestionContext = {
    pendingQuestion: state.pendingQuestion,
    pendingQuestionKind: state.pendingQuestionKind,
    priorTopic: frameText(priorTopic, 240) || null,
    groundedRelevant: groundedRelevant === true,
  };
}

function pendingResumeIsRelevant(state) {
  const context = state.resumeQuestionContext;
  if (!state.resumeQuestionAfterAnswer || !context || !state.pendingQuestion) return false;
  if (!sameFrameValue(context.pendingQuestion, state.pendingQuestion)) return false;
  if (context.pendingQuestionKind !== state.pendingQuestionKind) return false;
  // A pending question may cross a temporary topic detour only when the
  // validated LLM decision explicitly marked it relevant for this turn.
  if (context.groundedRelevant !== true) return false;
  return !state.answeredQuestions.has(state.resumeQuestionAfterAnswer);
}

function publicState(state) {
  const visibleFields = state.configuration.fields.filter((field) => (
    !field.requiredAction || state.activeActions.has(field.requiredAction)
  ));
  return Object.freeze({
    key: state.key,
    mode: state.configuration.mode,
    recentTurns: state.configuration.recentTurns,
    fields: visibleFields.map((field) => ({ ...field })),
    lockedFields: state.configuration.fields.filter((field) => !visibleFields.includes(field)).map((field) => field.key),
    messages: state.messages.map((message) => ({ ...message })),
    collectedData: { ...state.collectedData },
    collectedInformation: { ...state.collectedData },
    completedQuestions: [...state.completedQuestions],
    answeredQuestions: [...state.answeredQuestions],
    currentTopic: state.currentTopic,
    knownEntities: state.knownEntities.map((item) => ({ ...item })),
    language: state.language,
    pendingQuestion: state.pendingQuestion,
    pendingQuestionText: state.pendingQuestionText,
    pendingQuestionKind: state.pendingQuestionKind,
    resumeQuestionAfterAnswer: state.resumeQuestionAfterAnswer,
    lastAnswer: state.lastAnswer,
    activeToolRequest: state.activeToolRequest ? { ...state.activeToolRequest } : null,
    lastAnsweredQuestion: state.lastAnsweredQuestion,
    runningSummary: state.runningSummary,
    lastIntent: state.lastIntent,
    lastQuestionType: state.lastQuestionType,
    activeCategory: state.activeCategory ? { ...state.activeCategory } : null,
    selectedCatalogItem: state.selectedCatalogItem ? { ...state.selectedCatalogItem } : null,
    selectedItem: state.selectedCatalogItem ? { ...state.selectedCatalogItem } : null,
    candidateItems: state.candidateItems.map((item) => ({ ...item })),
    activeActions: [...state.activeActions],
    flowRecovery: { ...state.flowRecovery },
    missingFields: visibleFields.filter((field) => field.required && state.collectedData[field.key] === undefined)
      .map((field) => field.key),
    collectedFields: { ...state.collectedData },
    openedAt: state.openedAt,
    updatedAt: state.updatedAt,
  });
}

export function openLiveCallMemory(identity, settings = {}, now = Date.now(), initialFrame = {}) {
  const key = liveCallMemoryKey(identity);
  const configuration = resolveLiveMemoryConfiguration(settings);
  const restoredPending = initialFrame.pendingQuestion && typeof initialFrame.pendingQuestion === 'object'
    ? initialFrame.pendingQuestion : {};
  const restoredMessages = (initialFrame.recentTurns ?? []).map(cleanMessage).filter(Boolean);
  const configuredFieldKeys = new Set(configuration.fields.map((field) => field.key));
  const restoredFields = Object.fromEntries(Object.entries(
    initialFrame.collectedInformation ?? initialFrame.fields ?? {},
  )
    .filter(([field, value]) => configuredFieldKeys.has(field) && value !== undefined && value !== null));
  const state = {
    key, configuration, messages: restoredMessages, collectedData: restoredFields,
    completedQuestions: new Set([...(initialFrame.completedQuestions ?? []), ...Object.keys(restoredFields)]),
    answeredQuestions: new Set(initialFrame.answeredQuestions ?? []),
    currentTopic: frameText(initialFrame.currentTopic, 240) || null,
    knownEntities: uniqueFrameItems([
      ...(initialFrame.knownEntities ?? []),
      initialFrame.selectedItem,
      ...(initialFrame.candidateItems ?? []),
    ].filter(Boolean)),
    language: frameLanguage(initialFrame.language
      ?? settings.conversationLanguage ?? settings.defaultLanguage ?? settings.language),
    pendingQuestion: frameText(restoredPending.key, 500) || null,
    pendingQuestionText: frameText(restoredPending.text, 500) || null,
    pendingQuestionKind: frameText(restoredPending.kind, 40) || null,
    resumeQuestionAfterAnswer: null, resumeQuestionContext: null,
    lastAnsweredQuestion: null,
    lastAnswer: frameText(initialFrame.lastAnswer, maximumMessageCharacters) || null,
    activeToolRequest: initialFrame.activeToolRequest && typeof initialFrame.activeToolRequest === 'object'
      ? Object.freeze({ ...initialFrame.activeToolRequest }) : null,
    runningSummary: frameText(initialFrame.runningSummary, maximumRunningSummaryCharacters),
    lastIntent: null, lastQuestionType: null, summaryCursor: 0,
    activeCategory: frameCategory(initialFrame.activeCategory),
    selectedCatalogItem: frameItem(initialFrame.selectedItem),
    candidateItems: uniqueFrameItems(initialFrame.candidateItems),
    activeActions: new Set((initialFrame.activeActions ?? []).map((value) => frameText(value, 80)).filter(Boolean)),
    actionRequirements: new Map(),
    flowRecovery: { sideQuestions: 0, resumedQuestions: 0, repeatedQuestionsSuppressed: 0, clarifications: 0 },
    activeTurnToken: null,
    openedAt: now, updatedAt: now,
  };
  activeCalls.set(key, state);
  return Object.freeze({
    key,
    beginTurn(token) {
      state.activeTurnToken = token ?? Symbol('conversation-turn');
      return state.activeTurnToken;
    },
    cancelTurn(token) {
      if (token === undefined || token === state.activeTurnToken) state.activeTurnToken = null;
    },
    fieldSchemas: () => configuration.fields.map((field) => ({ ...field })),
    configuration: () => Object.freeze({ mode: configuration.mode, recentTurns: configuration.recentTurns }),
    append(message) {
      const entry = cleanMessage(message);
      if (!entry) return publicState(state);
      state.messages.push(entry);
      if (configuration.mode === conversationContextModes.FULL_CURRENT_CALL) {
        state.messages = state.messages.slice(-maximumFullCallMessages);
      } else state.messages = retainRecentTurns(state.messages, configuration.recentTurns);
      state.updatedAt = entry.at;
      return publicState(state);
    },
    captureUserUtterance(text, options = {}) {
      const pendingBeforeCapture = state.pendingQuestion;
      const pendingTextBeforeCapture = state.pendingQuestionText;
      const visibleFields = configuration.fields.filter((field) => (
        !field.requiredAction || state.activeActions.has(field.requiredAction)
      ));
      const updates = captureConfiguredMemoryFields({
        fields: visibleFields,
        collectedData: state.collectedData,
        pendingQuestion: state.pendingQuestion,
        text,
        acknowledgementPhrases: options.acknowledgementPhrases,
      });
      for (const [field, value] of Object.entries(updates)) {
        state.collectedData[field] = value;
        state.completedQuestions.add(field);
        if (state.pendingQuestion === field) {
          resolvePendingQuestion(state);
        }
      }
      const pendingIsConfiguredField = visibleFields.some((field) => field.key === pendingBeforeCapture);
      // A generic answer may actually be a side question. Keep it pending
      // until Knowledge routing or the grounded LLM decision classifies the turn.
      if (pendingBeforeCapture && !pendingIsConfiguredField && frameText(text)) {
        state.pendingQuestionText = pendingTextBeforeCapture || pendingBeforeCapture;
      }
      if (Object.keys(updates).length === 0 && !state.pendingQuestion
        && !state.activeCategory && !state.selectedCatalogItem) {
        state.currentTopic = String(text ?? '').trim().slice(0, 240) || state.currentTopic;
      }
      state.updatedAt = Date.now();
      return Object.freeze({ updates: { ...updates }, state: publicState(state) });
    },
    observeAssistantResponse(response) {
      state.lastAnswer = frameText(response, maximumMessageCharacters) || state.lastAnswer;
      const visibleFields = configuration.fields.filter((field) => (
        !field.requiredAction || state.activeActions.has(field.requiredAction)
      ));
      const pending = pendingFieldFromAssistantResponse(visibleFields, response);
      if (pending && state.collectedData[pending] === undefined) {
        state.pendingQuestion = pending;
        state.pendingQuestionText = visibleFields.find((field) => field.key === pending)?.question ?? pending;
        state.pendingQuestionKind = 'field';
        state.currentTopic = pending;
      } else if (!state.pendingQuestion) {
        const question = assistantQuestion(response);
        if (question) {
          state.pendingQuestion = question;
          state.pendingQuestionText = question;
          state.pendingQuestionKind = 'conversation';
        }
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    refreshRunningSummary() {
      if (configuration.mode !== conversationContextModes.FULL_CURRENT_CALL) return publicState(state);
      const recent = retainRecentTurns(state.messages, configuration.recentTurns);
      const olderBoundary = Math.max(0, state.messages.length - recent.length);
      if (state.summaryCursor > olderBoundary) state.summaryCursor = olderBoundary;
      const additions = state.messages.slice(state.summaryCursor, olderBoundary)
        .map((message) => `${message.role === 'user' ? 'Caller' : 'Agent'}: ${message.content.slice(0, 240)}`);
      if (additions.length) {
        state.runningSummary = [state.runningSummary, ...additions].filter(Boolean).join(' | ');
        if (state.runningSummary.length > maximumRunningSummaryCharacters) {
          state.runningSummary = `${state.runningSummary.slice(0, 900)} | … | ${state.runningSummary.slice(-2_600)}`;
        }
        state.summaryCursor = olderBoundary;
        state.updatedAt = Date.now();
      }
      return publicState(state);
    },
    mergeCollectedData(values = {}) {
      for (const field of configuration.fields.filter((entry) => (
        !entry.requiredAction || state.activeActions.has(entry.requiredAction)
      ))) {
        const value = values[field.key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          state.collectedData[field.key] = value;
          state.completedQuestions.add(field.key);
          rememberAnsweredQuestion(state, field.question || field.key);
          if (state.pendingQuestion === field.key) {
            state.pendingQuestion = null;
            state.pendingQuestionText = null;
          }
        }
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    setPosition({ currentTopic, pendingQuestion, pendingQuestionText } = {}) {
      if (currentTopic !== undefined) state.currentTopic = currentTopic ? String(currentTopic).slice(0, 240) : null;
      if (pendingQuestion !== undefined) {
        state.pendingQuestion = pendingQuestion ? String(pendingQuestion).slice(0, 500) : null;
        if (!state.pendingQuestion) state.pendingQuestionText = null;
        if (!state.pendingQuestion) state.pendingQuestionKind = null;
      }
      if (pendingQuestionText !== undefined) {
        state.pendingQuestionText = pendingQuestionText ? String(pendingQuestionText).slice(0, 500) : null;
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    setPendingQuestion(value) {
      if (!value) discardPendingQuestion(state);
      else {
        const next = typeof value === 'object' ? value : { text: value };
        state.pendingQuestion = frameText(next.key, 120) || null;
        state.pendingQuestionText = frameText(next.text ?? next.question, 500) || null;
        state.pendingQuestionKind = frameText(next.kind, 40) || 'conversation';
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    setLanguage(language) {
      state.language = frameLanguage(language, state.language);
      state.updatedAt = Date.now();
      return publicState(state);
    },
    completeQuestion(keyToComplete) {
      const value = String(keyToComplete ?? '').trim();
      if (value) {
        state.completedQuestions.add(value);
        rememberAnsweredQuestion(state, value);
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    applyGroundedDecision(decision = {}, options = {}) {
      if (options.turnToken !== undefined && options.turnToken !== state.activeTurnToken) {
        return Object.freeze({ applied: false, stale: true, state: publicState(state) });
      }
      const priorTopic = state.currentTopic;
      state.lastIntent = frameText(decision.intent, 160) || state.lastIntent;
      state.lastQuestionType = frameText(decision.questionType, 80) || state.lastQuestionType;
      const decidedTopic = frameText(decision.currentTopic, 240);
      if (decidedTopic) state.currentTopic = decidedTopic;
      if (decision.pendingQuestionRelevant === false && decision.flowAction !== 'answer_pending') {
        discardPendingQuestion(state);
      }
      if (decision.flowAction === 'answer_pending') resolvePendingQuestion(state);
      else if (decision.flowAction === 'side_question' && decision.pendingQuestionRelevant !== false) {
        schedulePendingQuestionResume(state, { groundedRelevant: true, priorTopic });
      }
      const selected = frameItem(decision.selectedEntities?.[0]);
      if (selected) {
        state.knownEntities = uniqueFrameItems([selected, ...state.knownEntities]);
        const known = [state.selectedCatalogItem, ...state.candidateItems].filter(Boolean)
          .find((item) => (selected.id && item.id === selected.id) || (selected.key && item.key === selected.key));
        state.selectedCatalogItem = frameItem(selected, known ?? {});
        state.activeCategory = frameCategory({
          key: selected.categoryKey, name: selected.category, parentKey: selected.parentCategoryKey,
        }) ?? state.activeCategory;
        state.candidateItems = [];
        state.currentTopic = selected.name;
      }
      for (const [field, value] of Object.entries(decision.fieldUpdates ?? {})) {
        if (!configuration.fields.some((configured) => configured.key === field)) continue;
        state.collectedData[field] = value;
        state.completedQuestions.add(field);
        if (state.pendingQuestion === field) resolvePendingQuestion(state);
      }
      if (decision.pendingQuestion !== undefined) {
        if (decision.pendingQuestion === null) discardPendingQuestion(state);
        else {
          const pending = typeof decision.pendingQuestion === 'object'
            ? decision.pendingQuestion : { text: decision.pendingQuestion };
          state.pendingQuestion = frameText(pending.key, 120) || null;
          state.pendingQuestionText = frameText(pending.text, 500) || null;
          state.pendingQuestionKind = frameText(pending.kind, 40) || 'conversation';
        }
      }
      if (decision.language) state.language = frameLanguage(decision.language, state.language);
      if (decision.activeToolRequest !== undefined) {
        state.activeToolRequest = decision.activeToolRequest
          ? Object.freeze({
            id: frameText(decision.activeToolRequest.id, 100) || null,
            name: frameText(decision.activeToolRequest.name, 100) || null,
            status: frameText(decision.activeToolRequest.status, 40) || 'collecting_information',
            ...(frameText(decision.activeToolRequest.authorizationRecordId, 120)
              ? { authorizationRecordId: frameText(decision.activeToolRequest.authorizationRecordId, 120) }
              : {}),
          }) : null;
      }
      state.updatedAt = Date.now();
      return Object.freeze({ applied: true, updates: { ...(decision.fieldUpdates ?? {}) }, state: publicState(state) });
    },
    applyKnowledge(knowledge) {
      const pendingBeforeKnowledge = state.pendingQuestion;
      const pendingKindBeforeKnowledge = state.pendingQuestionKind;
      const candidateIdentities = new Set(state.candidateItems.flatMap((item) => [item.id, item.key])
        .map((value) => frameText(value, 160)).filter(Boolean));
      const canonicalEntitySelection = knowledge?.resolvedEntity?.canonical === true
        ? {
          source: { recordId: knowledge.resolvedEntity.id },
          item: {
            key: knowledge.resolvedEntity.key,
            name: knowledge.resolvedEntity.name,
            category: knowledge.resolvedEntity.category,
            categoryKey: knowledge.resolvedEntity.categoryKey,
            parentCategoryKey: knowledge.resolvedEntity.parentCategoryKey,
          },
        }
        : null;
      const selection = knowledge?.catalogSelection
        ?? (knowledge?.route === 'catalog' ? knowledge : null)
        ?? canonicalEntitySelection;
      if (selection?.item?.name && selection?.source?.recordId) {
        state.selectedCatalogItem = frameItem({
          id: selection.source.recordId,
          key: selection.item.key ?? null,
          name: selection.item.name,
          category: selection.item.category ?? null,
          categoryKey: selection.item.categoryKey ?? null,
          parentCategoryKey: selection.item.parentCategoryKey ?? null,
        });
        state.activeCategory = frameCategory({
          key: selection.item.categoryKey,
          name: selection.item.category,
          parentKey: selection.item.parentCategoryKey,
          description: selection.item.categoryDescription,
        }) ?? state.activeCategory;
        state.candidateItems = [];
        state.currentTopic = selection.item.name;
        const selectedIdentity = [selection.source.recordId, selection.item.key]
          .map((value) => frameText(value, 160)).filter(Boolean);
        if (pendingBeforeKnowledge && pendingKindBeforeKnowledge !== 'field'
          && (candidateIdentities.size === 0 || selectedIdentity.some((value) => candidateIdentities.has(value)))) {
          resolvePendingQuestion(state);
        } else if (pendingBeforeKnowledge) schedulePendingQuestionResume(state);
      } else if (selection?.category?.name) {
        // A category is a browse context, never a bookable item. Selecting a
        // category must not silently retain a child selected in an earlier
        // topic; otherwise a caller can accidentally book that old child.
        state.selectedCatalogItem = null;
        for (const [action, requiresCatalogItem] of state.actionRequirements) {
          if (requiresCatalogItem) state.activeActions.delete(action);
        }
        state.activeCategory = frameCategory(selection.category);
        state.candidateItems = uniqueFrameItems((selection.category.items ?? []).map((item) => ({
          ...item,
          category: selection.category.name,
          categoryKey: item.categoryKey ?? selection.category.key,
          parentCategoryKey: item.parentCategoryKey ?? selection.category.parentKey,
        })));
        state.currentTopic = selection.category.name;
        if (pendingBeforeKnowledge && pendingKindBeforeKnowledge !== 'field') resolvePendingQuestion(state);
        else if (pendingBeforeKnowledge) schedulePendingQuestionResume(state);
      }
      if (Array.isArray(knowledge?.catalogSelections) && knowledge.catalogSelections.length) {
        state.candidateItems = uniqueFrameItems(knowledge.catalogSelections.map((candidate) => ({
          id: candidate.source?.recordId,
          ...candidate.item,
        })));
        const categories = new Map(state.candidateItems.map((item) => [item.categoryKey ?? item.category, item]));
        if (categories.size === 1) {
          const item = categories.values().next().value;
          state.activeCategory = frameCategory({
            key: item.categoryKey, name: item.category, parentKey: item.parentCategoryKey,
          }) ?? state.activeCategory;
        }
      }
      if (knowledge?.scenarioCategory?.name) {
        state.activeCategory = frameCategory(knowledge.scenarioCategory) ?? state.activeCategory;
        state.candidateItems = uniqueFrameItems(knowledge.scenarioCategory.items ?? []);
        state.currentTopic = knowledge.scenarioCategory.name;
        if (pendingBeforeKnowledge && pendingKindBeforeKnowledge !== 'field') {
          schedulePendingQuestionResume(state);
        }
      }
      if (knowledge?.route === 'clarification' && knowledge.clarification?.kind === 'catalog') {
        state.flowRecovery.clarifications += 1;
        state.candidateItems = uniqueFrameItems(knowledge.clarification.candidates);
        const clarificationQuestion = frameText(knowledge.content, 500);
        if (clarificationQuestion) {
          state.pendingQuestion = clarificationQuestion;
          state.pendingQuestionText = clarificationQuestion;
          state.pendingQuestionKind = 'clarification';
        }
      }
      if (knowledge?.route === 'workflow') {
        const actionKey = frameText(knowledge.action?.config?.actionKey, 80).toLocaleLowerCase();
        const requiresCatalogItem = knowledge.action?.config?.requiresCatalogItem === true;
        if (actionKey && (!requiresCatalogItem || state.selectedCatalogItem?.id)) {
          state.activeActions.add(actionKey);
          state.actionRequirements.set(actionKey, requiresCatalogItem);
        }
      }
      if (knowledge?.found && pendingBeforeKnowledge && state.pendingQuestion === pendingBeforeKnowledge
        && knowledge.route !== 'clarification') schedulePendingQuestionResume(state);
      state.lastAnsweredQuestion = null;
      state.updatedAt = Date.now();
      return publicState(state);
    },
    prepareAssistantResponse(response, { resumePending = true } = {}) {
      const original = frameText(response, maximumMessageCharacters);
      if (!original) return '';
      const answered = [...state.answeredQuestions];
      const completedFieldQuestions = configuration.fields
        .filter((field) => state.collectedData[field.key] !== undefined)
        .map((field) => field.question);
      const blockedQuestions = [...answered, ...completedFieldQuestions].filter(Boolean);
      const parts = original.split(/(?<=[.!?])\s+/u).filter(Boolean);
      const filtered = parts.filter((part) => !blockedQuestions.some((question) => (
        sameFrameValue(part, question)
        && !sameFrameValue(part, state.pendingQuestionText)
        && !sameFrameValue(part, state.resumeQuestionAfterAnswer)
      )));
      state.flowRecovery.repeatedQuestionsSuppressed += parts.length - filtered.length;
      const resumeQuestion = state.resumeQuestionAfterAnswer;
      if (resumePending && pendingResumeIsRelevant(state)
        && !filtered.some((part) => sameFrameValue(part, resumeQuestion))) {
        filtered.push(resumeQuestion);
        state.flowRecovery.resumedQuestions += 1;
      }
      if (resumePending) {
        state.resumeQuestionAfterAnswer = null;
        state.resumeQuestionContext = null;
      }
      state.updatedAt = Date.now();
      return filtered.join(' ').trim();
    },
    canRunAction(actionKey, { requiresCatalogItem = false } = {}) {
      const action = String(actionKey ?? '').trim().toLowerCase();
      return Boolean(action && state.activeActions.has(action)
        && (!requiresCatalogItem || state.selectedCatalogItem?.id));
    },
    activateAction(actionKey, { requiresCatalogItem = false } = {}) {
      const action = String(actionKey ?? '').trim().toLowerCase();
      if (!action || (requiresCatalogItem && !state.selectedCatalogItem?.id)) return publicState(state);
      state.activeActions.add(action);
      state.actionRequirements.set(action, requiresCatalogItem === true);
      state.updatedAt = Date.now();
      return publicState(state);
    },
    setActiveToolRequest(request = null) {
      if (!request || typeof request !== 'object') state.activeToolRequest = null;
      else {
        state.activeToolRequest = Object.freeze({
          id: frameText(request.id, 100) || null,
          name: frameText(request.name ?? request.action, 100) || null,
          status: frameText(request.status, 40) || 'pending',
          ...(frameText(request.authorizationRecordId, 120)
            ? { authorizationRecordId: frameText(request.authorizationRecordId, 120) }
            : {}),
        });
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    snapshot: () => publicState(state),
    promptMessages: () => retainRecentTurns(state.messages, configuration.recentTurns).map((message) => ({ ...message })),
    close() { activeCalls.delete(key); },
  });
}

export function activeLiveCallMemoryCount() {
  return activeCalls.size;
}

function promptText(value, maximum) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function compactLiveCallMemoryContext({ snapshot = {}, collectedData = {} }, maximumCharacters = 1_000) {
  const collectedEntries = Object.entries(snapshot.collectedInformation ?? collectedData).slice(-20)
    .map(([key, value]) => [promptText(key, 64), promptText(value, 160)])
    .filter(([key, value]) => key && value);
  const pending = snapshot.pendingQuestion && typeof snapshot.pendingQuestion === 'object'
    ? snapshot.pendingQuestion
    : {
      key: snapshot.pendingQuestion,
      text: snapshot.pendingQuestionText,
      kind: snapshot.pendingQuestionKind,
    };
  const context = {
    currentTopic: promptText(snapshot.currentTopic, 200) || undefined,
    knownEntities: (snapshot.knownEntities ?? []).slice(0, 12).map((item) => ({
      id: promptText(item.id, 100) || undefined,
      key: promptText(item.key, 120) || undefined,
      name: promptText(item.name, 200) || undefined,
      category: promptText(item.category, 160) || undefined,
    })).filter((item) => item.id || item.key || item.name),
    pendingQuestion: pending?.key || pending?.text ? {
      key: promptText(pending.key, 120) || undefined,
      text: promptText(pending.text, 300) || undefined,
      kind: promptText(pending.kind, 40) || undefined,
    } : undefined,
    language: promptText(snapshot.language, 20) || undefined,
    collectedInformation: Object.fromEntries(collectedEntries),
    recentTurns: (snapshot.messages ?? snapshot.recentTurns ?? []).slice(-10).map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: promptText(message.content, 300),
    })).filter((message) => message.content),
    lastAnswer: promptText(snapshot.lastAnswer, 500) || undefined,
    activeToolRequest: snapshot.activeToolRequest ? {
      id: promptText(snapshot.activeToolRequest.id, 100) || undefined,
      name: promptText(snapshot.activeToolRequest.name, 100) || undefined,
      status: promptText(snapshot.activeToolRequest.status, 40) || undefined,
      authorizationRecordId: promptText(snapshot.activeToolRequest.authorizationRecordId, 120) || undefined,
    } : undefined,
  };
  const size = () => JSON.stringify(context).length;
  while (size() > maximumCharacters && context.recentTurns.length > 2) context.recentTurns.shift();
  while (size() > maximumCharacters && context.knownEntities.length > 1) context.knownEntities.pop();
  const keys = Object.keys(context.collectedInformation);
  while (size() > maximumCharacters && keys.length > 1) delete context.collectedInformation[keys.shift()];
  if (size() > maximumCharacters && context.lastAnswer) {
    context.lastAnswer = context.lastAnswer.slice(0, Math.max(80, context.lastAnswer.length - (size() - maximumCharacters)));
  }
  return Object.freeze(context);
}
