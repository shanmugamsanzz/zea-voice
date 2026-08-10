import { conversationContextModes, resolveLiveMemoryConfiguration } from './live-memory-config.js';
import { captureConfiguredMemoryFields, pendingFieldFromAssistantResponse } from './live-memory-extractor.js';

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
  return Object.freeze({
    key: state.key,
    mode: state.configuration.mode,
    recentTurns: state.configuration.recentTurns,
    fields: state.configuration.fields.map((field) => ({ ...field })),
    messages: state.messages.map((message) => ({ ...message })),
    collectedData: { ...state.collectedData },
    completedQuestions: [...state.completedQuestions],
    currentTopic: state.currentTopic,
    pendingQuestion: state.pendingQuestion,
    runningSummary: state.runningSummary,
    missingFields: state.configuration.fields.filter((field) => field.required && state.collectedData[field.key] === undefined)
      .map((field) => field.key),
    openedAt: state.openedAt,
    updatedAt: state.updatedAt,
  });
}

export function openLiveCallMemory(identity, settings = {}, now = Date.now()) {
  const key = liveCallMemoryKey(identity);
  const configuration = resolveLiveMemoryConfiguration(settings);
  const state = {
    key, configuration, messages: [], collectedData: {}, completedQuestions: new Set(),
    currentTopic: null, pendingQuestion: null, runningSummary: '', summaryCursor: 0,
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
      const updates = captureConfiguredMemoryFields({
        fields: configuration.fields,
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
      const pending = pendingFieldFromAssistantResponse(configuration.fields, response);
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
      for (const field of configuration.fields) {
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
