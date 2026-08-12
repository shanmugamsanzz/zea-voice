import { conversationContextModes, resolveLiveMemoryConfiguration } from './live-memory-config.js';
import { captureConfiguredMemoryFields, pendingFieldFromAssistantResponse } from './live-memory-extractor.js';
import { resolveConversationStageConfiguration, workflowStageGate } from './conversation-stage-config.js';

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
}

function schedulePendingQuestionResume(state) {
  if (!state.pendingQuestion) return;
  state.resumeStage ??= state.currentStage;
  const question = state.pendingQuestionText || state.pendingQuestion;
  if (!sameFrameValue(state.resumeQuestionAfterAnswer, question)) {
    state.flowRecovery.sideQuestions += 1;
  }
  state.resumeQuestionAfterAnswer = question;
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
    completedQuestions: [...state.completedQuestions],
    answeredQuestions: [...state.answeredQuestions],
    currentTopic: state.currentTopic,
    language: state.language,
    pendingQuestion: state.pendingQuestion,
    pendingQuestionText: state.pendingQuestionText,
    pendingQuestionKind: state.pendingQuestionKind,
    resumeQuestionAfterAnswer: state.resumeQuestionAfterAnswer,
    lastAnsweredQuestion: state.lastAnsweredQuestion,
    runningSummary: state.runningSummary,
    lastIntent: state.lastIntent,
    lastQuestionType: state.lastQuestionType,
    currentStage: state.currentStage,
    resumeStage: state.resumeStage,
    activeCategory: state.activeCategory ? { ...state.activeCategory } : null,
    selectedCatalogItem: state.selectedCatalogItem ? { ...state.selectedCatalogItem } : null,
    selectedItem: state.selectedCatalogItem ? { ...state.selectedCatalogItem } : null,
    candidateItems: state.candidateItems.map((item) => ({ ...item })),
    activeActions: [...state.activeActions],
    stageTransitions: state.stageTransitions.map((transition) => ({ ...transition })),
    flowRecovery: { ...state.flowRecovery },
    missingFields: visibleFields.filter((field) => field.required && state.collectedData[field.key] === undefined)
      .map((field) => field.key),
    openedAt: state.openedAt,
    updatedAt: state.updatedAt,
  });
}

export function openLiveCallMemory(identity, settings = {}, now = Date.now()) {
  const key = liveCallMemoryKey(identity);
  const configuration = resolveLiveMemoryConfiguration(settings);
  const stageConfiguration = resolveConversationStageConfiguration(settings);
  const state = {
    key, configuration, messages: [], collectedData: {}, completedQuestions: new Set(),
    answeredQuestions: new Set(), currentTopic: null, language: frameLanguage(
      settings.conversationLanguage ?? settings.defaultLanguage ?? settings.language,
    ), pendingQuestion: null,
    pendingQuestionText: null, pendingQuestionKind: null, resumeQuestionAfterAnswer: null,
    lastAnsweredQuestion: null, runningSummary: '', lastIntent: null, lastQuestionType: null, summaryCursor: 0,
    currentStage: stageConfiguration.initialStage, resumeStage: null,
    activeCategory: null, selectedCatalogItem: null, candidateItems: [],
    activeActions: new Set(), stageTransitions: [],
    flowRecovery: { sideQuestions: 0, resumedQuestions: 0, repeatedQuestionsSuppressed: 0, clarifications: 0 },
    openedAt: now, updatedAt: now,
  };
  activeCalls.set(key, state);
  return Object.freeze({
    key,
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
    setPosition({ currentTopic, pendingQuestion, pendingQuestionText, resumeStage } = {}) {
      if (currentTopic !== undefined) state.currentTopic = currentTopic ? String(currentTopic).slice(0, 240) : null;
      if (pendingQuestion !== undefined) {
        state.pendingQuestion = pendingQuestion ? String(pendingQuestion).slice(0, 500) : null;
        if (!state.pendingQuestion) state.pendingQuestionText = null;
        if (!state.pendingQuestion) state.pendingQuestionKind = null;
      }
      if (pendingQuestionText !== undefined) {
        state.pendingQuestionText = pendingQuestionText ? String(pendingQuestionText).slice(0, 500) : null;
      }
      if (resumeStage !== undefined) state.resumeStage = resumeStage ? String(resumeStage).slice(0, 80) : null;
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
    suspendForDetour() {
      if (!state.resumeStage) state.resumeStage = state.currentStage;
      state.updatedAt = Date.now();
      return publicState(state);
    },
    resumeFromDetour() {
      if (state.resumeStage) state.currentStage = state.resumeStage;
      state.resumeStage = null;
      state.updatedAt = Date.now();
      return publicState(state);
    },
    applyGroundedDecision(decision = {}) {
      state.lastIntent = frameText(decision.intent, 160) || state.lastIntent;
      state.lastQuestionType = frameText(decision.questionType, 80) || state.lastQuestionType;
      if (decision.flowAction === 'answer_pending') resolvePendingQuestion(state);
      else if (decision.flowAction === 'side_question') schedulePendingQuestionResume(state);
      const selected = frameItem(decision.selectedEntities?.[0]);
      if (selected) {
        const known = [state.selectedCatalogItem, ...state.candidateItems].filter(Boolean)
          .find((item) => (selected.id && item.id === selected.id) || (selected.key && item.key === selected.key));
        state.selectedCatalogItem = frameItem(selected, known ?? {});
        state.activeCategory = frameCategory({
          key: selected.categoryKey, name: selected.category, parentKey: selected.parentCategoryKey,
        }) ?? state.activeCategory;
        state.candidateItems = [];
        state.currentTopic = selected.name;
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    applyKnowledge(knowledge) {
      const pendingBeforeKnowledge = state.pendingQuestion;
      const pendingKindBeforeKnowledge = state.pendingQuestionKind;
      const candidateIdentities = new Set(state.candidateItems.flatMap((item) => [item.id, item.key])
        .map((value) => frameText(value, 160)).filter(Boolean));
      const selection = knowledge?.catalogSelection ?? (knowledge?.route === 'catalog' ? knowledge : null);
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
        state.resumeStage = null;
        const selectedIdentity = [selection.source.recordId, selection.item.key]
          .map((value) => frameText(value, 160)).filter(Boolean);
        if (pendingBeforeKnowledge && pendingKindBeforeKnowledge !== 'field'
          && (candidateIdentities.size === 0 || selectedIdentity.some((value) => candidateIdentities.has(value)))) {
          resolvePendingQuestion(state);
        } else if (pendingBeforeKnowledge) schedulePendingQuestionResume(state);
      } else if (selection?.category?.name) {
        state.activeCategory = frameCategory(selection.category);
        state.candidateItems = uniqueFrameItems((selection.category.items ?? []).map((item) => ({
          ...item,
          category: selection.category.name,
          categoryKey: item.categoryKey ?? selection.category.key,
          parentCategoryKey: item.parentCategoryKey ?? selection.category.parentKey,
        })));
        state.currentTopic = selection.category.name;
        state.resumeStage = null;
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
        if (!state.resumeStage) state.resumeStage = state.currentStage;
        const clarificationQuestion = frameText(knowledge.content, 500);
        if (clarificationQuestion) {
          state.pendingQuestion = clarificationQuestion;
          state.pendingQuestionText = clarificationQuestion;
          state.pendingQuestionKind = 'clarification';
        }
      }
      if (knowledge?.route === 'workflow') {
        const gate = workflowStageGate({
          conditions: knowledge.workflow?.conditions,
          action_config: knowledge.action?.config,
        }, {
          currentStage: state.currentStage,
          selectedCatalogItemId: state.selectedCatalogItem?.id,
        });
        if (knowledge.workflow?.gate?.allowed === false || !gate.allowed) return publicState(state);
        if (gate.actionKey) state.activeActions.add(gate.actionKey);
        if (gate.nextStage && gate.nextStage !== state.currentStage) {
          state.stageTransitions.push({
            from: state.currentStage,
            to: gate.nextStage,
            actionKey: gate.actionKey || null,
            at: Date.now(),
          });
          state.currentStage = gate.nextStage;
          if (pendingBeforeKnowledge && pendingKindBeforeKnowledge !== 'field') resolvePendingQuestion(state);
        }
      }
      if (knowledge?.found && pendingBeforeKnowledge && state.pendingQuestion === pendingBeforeKnowledge
        && knowledge.route !== 'clarification') schedulePendingQuestionResume(state);
      state.lastAnsweredQuestion = null;
      state.updatedAt = Date.now();
      return publicState(state);
    },
    prepareAssistantResponse(response) {
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
      if (resumeQuestion && !filtered.some((part) => sameFrameValue(part, resumeQuestion))) {
        filtered.push(resumeQuestion);
        state.flowRecovery.resumedQuestions += 1;
      }
      state.resumeQuestionAfterAnswer = null;
      state.updatedAt = Date.now();
      return filtered.join(' ').trim();
    },
    canRunAction(actionKey, { requiresCatalogItem = false } = {}) {
      const action = String(actionKey ?? '').trim().toLowerCase();
      return Boolean(action && state.activeActions.has(action)
        && (!requiresCatalogItem || state.selectedCatalogItem?.id));
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

export function compactLiveCallMemoryContext({ snapshot = {}, collectedData = {}, missingFields = [] }, maximumCharacters = 1_000) {
  const collectedEntries = Object.entries(collectedData).slice(-12)
    .map(([key, value]) => [promptText(key, 64), promptText(value, 120)]).filter(([key, value]) => key && value);
  const missing = missingFields.slice(0, 20).map((field) => promptText(field.key ?? field, 64)).filter(Boolean);
  const next = missingFields[0];
  const context = {
    collectedData: Object.fromEntries(collectedEntries),
    completedQuestions: [...new Set([
      ...(snapshot.completedQuestions ?? []).map((entry) => promptText(entry, 64)),
      ...Object.keys(collectedData).map((entry) => promptText(entry, 64)),
    ].filter(Boolean))].slice(-20),
    pendingQuestion: promptText(snapshot.pendingQuestion, 64) || undefined,
    pendingQuestionKind: promptText(snapshot.pendingQuestionKind, 32) || undefined,
    resumeQuestionAfterAnswer: promptText(snapshot.resumeQuestionAfterAnswer, 200) || undefined,
    currentTopic: promptText(snapshot.currentTopic, 160) || undefined,
    language: promptText(snapshot.language, 12) || undefined,
    currentStage: promptText(snapshot.currentStage, 80) || undefined,
    lastIntent: promptText(snapshot.lastIntent, 80) || undefined,
    lastQuestionType: promptText(snapshot.lastQuestionType, 80) || undefined,
    resumeStage: promptText(snapshot.resumeStage, 80) || undefined,
    activeCategory: snapshot.activeCategory ? {
      key: promptText(snapshot.activeCategory.key, 80) || undefined,
      name: promptText(snapshot.activeCategory.name, 160),
      parentKey: promptText(snapshot.activeCategory.parentKey, 80) || undefined,
    } : undefined,
    selectedCatalogItem: snapshot.selectedCatalogItem ? {
      id: promptText(snapshot.selectedCatalogItem.id, 80),
      key: promptText(snapshot.selectedCatalogItem.key, 80) || undefined,
      name: promptText(snapshot.selectedCatalogItem.name, 160),
      category: promptText(snapshot.selectedCatalogItem.category, 160) || undefined,
    } : undefined,
    activeActions: (snapshot.activeActions ?? []).map((value) => promptText(value, 80)).filter(Boolean).slice(-10),
    candidateItems: (snapshot.candidateItems ?? []).slice(0, 5).map((item) => ({
      id: promptText(item.id, 80) || undefined,
      key: promptText(item.key, 80) || undefined,
      name: promptText(item.name, 120),
      category: promptText(item.category, 120) || undefined,
    })).filter((item) => item.name),
    answeredQuestions: (snapshot.answeredQuestions ?? [])
      .map((value) => promptText(value, 120)).filter(Boolean).slice(-12),
    lockedFields: (snapshot.lockedFields ?? []).map((value) => promptText(value, 64)).filter(Boolean).slice(0, 20),
    missingFields: missing,
    nextMissingField: next ? {
      key: promptText(next.key, 64), label: promptText(next.label, 80),
      type: promptText(next.type, 20), question: promptText(next.question, 240),
    } : undefined,
    runningSummary: promptText(snapshot.runningSummary, 500) || undefined,
    mode: snapshot.mode,
  };
  const size = () => JSON.stringify(context).length;
  while (size() > maximumCharacters && context.runningSummary) {
    context.runningSummary = context.runningSummary.slice(0, Math.max(0, context.runningSummary.length - 100)) || undefined;
  }
  while (size() > maximumCharacters && context.completedQuestions.length > 1) context.completedQuestions.shift();
  while (size() > maximumCharacters && context.answeredQuestions.length > 1) context.answeredQuestions.shift();
  while (size() > maximumCharacters && context.candidateItems.length > 1) context.candidateItems.pop();
  while (size() > maximumCharacters && context.missingFields.length > 1) context.missingFields.pop();
  const keys = Object.keys(context.collectedData);
  while (size() > maximumCharacters && keys.length > 1) delete context.collectedData[keys.shift()];
  return Object.freeze(context);
}
