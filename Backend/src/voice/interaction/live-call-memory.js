import { conversationContextModes, resolveLiveMemoryConfiguration } from './live-memory-config.js';
import { captureConfiguredMemoryFields, pendingFieldFromAssistantResponse } from './live-memory-extractor.js';
import { resolveConversationStageConfiguration, workflowStageGate } from './conversation-stage-config.js';

const activeCalls = new Map();
const maximumFullCallMessages = 2_000;
const maximumMessageCharacters = 2_000;
const maximumRunningSummaryCharacters = 3_600;

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
    currentTopic: state.currentTopic,
    pendingQuestion: state.pendingQuestion,
    runningSummary: state.runningSummary,
    currentStage: state.currentStage,
    selectedCatalogItem: state.selectedCatalogItem ? { ...state.selectedCatalogItem } : null,
    activeActions: [...state.activeActions],
    stageTransitions: state.stageTransitions.map((transition) => ({ ...transition })),
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
    currentTopic: null, pendingQuestion: null, runningSummary: '', summaryCursor: 0,
    currentStage: stageConfiguration.initialStage, selectedCatalogItem: null,
    activeActions: new Set(), stageTransitions: [],
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
        if (state.pendingQuestion === field) state.pendingQuestion = null;
      }
      if (Object.keys(updates).length === 0 && !state.pendingQuestion) {
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
        state.currentTopic = pending;
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
        if (value !== undefined && value !== null && String(value).trim() !== '') state.collectedData[field.key] = value;
      }
      state.updatedAt = Date.now();
      return publicState(state);
    },
    setPosition({ currentTopic, pendingQuestion } = {}) {
      if (currentTopic !== undefined) state.currentTopic = currentTopic ? String(currentTopic).slice(0, 240) : null;
      if (pendingQuestion !== undefined) state.pendingQuestion = pendingQuestion ? String(pendingQuestion).slice(0, 500) : null;
      state.updatedAt = Date.now();
      return publicState(state);
    },
    completeQuestion(keyToComplete) {
      const value = String(keyToComplete ?? '').trim();
      if (value) state.completedQuestions.add(value);
      state.updatedAt = Date.now();
      return publicState(state);
    },
    applyKnowledge(knowledge) {
      const selection = knowledge?.catalogSelection ?? (knowledge?.route === 'catalog' ? knowledge : null);
      if (selection?.item?.name && selection?.source?.recordId) {
        state.selectedCatalogItem = {
          id: selection.source.recordId,
          key: selection.item.key ?? null,
          name: selection.item.name,
          category: selection.item.category ?? null,
        };
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
        }
      }
      state.updatedAt = Date.now();
      return publicState(state);
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
    currentTopic: promptText(snapshot.currentTopic, 160) || undefined,
    currentStage: promptText(snapshot.currentStage, 80) || undefined,
    selectedCatalogItem: snapshot.selectedCatalogItem ? {
      id: promptText(snapshot.selectedCatalogItem.id, 80),
      key: promptText(snapshot.selectedCatalogItem.key, 80) || undefined,
      name: promptText(snapshot.selectedCatalogItem.name, 160),
      category: promptText(snapshot.selectedCatalogItem.category, 160) || undefined,
    } : undefined,
    activeActions: (snapshot.activeActions ?? []).map((value) => promptText(value, 80)).filter(Boolean).slice(-10),
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
  while (size() > maximumCharacters && context.missingFields.length > 1) context.missingFields.pop();
  const keys = Object.keys(context.collectedData);
  while (size() > maximumCharacters && keys.length > 1) delete context.collectedData[keys.shift()];
  return Object.freeze(context);
}
