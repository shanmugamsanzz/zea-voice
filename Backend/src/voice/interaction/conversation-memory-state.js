const maxSummaryCharacters = 12_000;
const maxMessages = 12;
const maxMessageCharacters = 2_000;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

function text(value, max) {
  return String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJson(value, depth = 0) {
  if (depth > 4 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return text(value, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeJson(entry, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      if (forbiddenKeys.has(key) || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      output[key] = safeJson(entry, depth + 1);
    }
    return output;
  }
  return null;
}

function messages(value) {
  return (Array.isArray(value) ? value : []).flatMap((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'user' ? 'user' : null);
    const content = text(message?.content, maxMessageCharacters);
    return role && content ? [{ role, content }] : [];
  }).slice(-maxMessages);
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => text(entry, 240)).filter(Boolean))].slice(0, 50);
}

function isoDate(value, fallback = null) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeLiveCallFrame(value = {}) {
  value = objectValue(value);
  const pending = value.pendingQuestion && typeof value.pendingQuestion === 'object'
    ? value.pendingQuestion : { key: value.pendingQuestion, text: value.pendingQuestionText, kind: value.pendingQuestionKind };
  return Object.freeze({
    callId: text(value.callId, 100) || null,
    currentStage: text(value.currentStage ?? value.conversationStage, 80) || null,
    resumeStage: text(value.resumeStage, 80) || null,
    currentTopic: text(value.currentTopic, 240) || null,
    activeCategory: Object.freeze(safeJson(value.activeCategory) ?? {}),
    selectedItem: Object.freeze(safeJson(value.selectedItem ?? value.selectedCatalogItem) ?? {}),
    candidateItems: Object.freeze((Array.isArray(value.candidateItems) ? value.candidateItems : [])
      .slice(0, 8).map((item) => safeJson(item)).filter(Boolean)),
    pendingQuestion: Object.freeze({
      key: text(pending?.key, 500) || null,
      text: text(pending?.text, 500) || null,
      kind: text(pending?.kind, 40) || null,
    }),
    language: text(value.language, 20) || null,
    fields: Object.freeze(safeJson(value.collectedData ?? value.fields) ?? {}),
    completedQuestions: Object.freeze(stringList(value.completedQuestions)),
    answeredQuestions: Object.freeze(stringList(value.answeredQuestions)),
    activeActions: Object.freeze(stringList(value.activeActions)),
    recentTurns: Object.freeze(messages(Array.isArray(value.recentTurns) ? value.recentTurns : value.messages)),
    runningSummary: text(value.runningSummary, 3_600),
    updatedAt: isoDate(value.updatedAt, new Date().toISOString()),
  });
}

export function normalizeConversationMemoryState(value = {}) {
  value = objectValue(value);
  const updatedAt = isoDate(value.updatedAt, new Date().toISOString());
  return Object.freeze({
    schemaVersion: 2,
    summary: text(value.summary, maxSummaryCharacters),
    recentMessages: Object.freeze(messages(value.recentMessages)),
    collectedData: Object.freeze(safeJson(value.collectedData) ?? {}),
    completedQuestions: Object.freeze(stringList(value.completedQuestions)),
    pendingQuestions: Object.freeze(stringList(value.pendingQuestions)),
    callback: Object.freeze(safeJson(value.callback) ?? {}),
    lastCall: Object.freeze(safeJson(value.lastCall) ?? {}),
    callFrame: normalizeLiveCallFrame(value.callFrame),
    updatedAt,
  });
}

export function buildConversationMemoryState({
  previous = {}, history = [], call, outcome, reason, callback, collectedData,
  completedQuestions, pendingQuestions, runningSummary, callFrame, at = new Date(),
}) {
  const prior = normalizeConversationMemoryState(previous);
  const incomingFrame = objectValue(callFrame);
  const mergedCollectedData = {
    ...prior.collectedData,
    ...objectValue(prior.callFrame?.fields),
    ...objectValue(incomingFrame.fields),
    ...objectValue(incomingFrame.collectedData),
    ...objectValue(safeJson(collectedData)),
  };
  const mergedCallFrame = callFrame ? normalizeLiveCallFrame({
    ...prior.callFrame,
    ...incomingFrame,
    callId: call?.id ?? incomingFrame.callId ?? prior.callFrame.callId,
    currentStage: owns(incomingFrame, 'currentStage') ? incomingFrame.currentStage
      : (owns(incomingFrame, 'conversationStage') ? incomingFrame.conversationStage : prior.callFrame.currentStage),
    activeCategory: owns(incomingFrame, 'activeCategory')
      ? incomingFrame.activeCategory : prior.callFrame.activeCategory,
    selectedItem: owns(incomingFrame, 'selectedItem') ? incomingFrame.selectedItem
      : (owns(incomingFrame, 'selectedCatalogItem')
        ? incomingFrame.selectedCatalogItem : prior.callFrame.selectedItem),
    pendingQuestion: owns(incomingFrame, 'pendingQuestion')
      ? incomingFrame.pendingQuestion : prior.callFrame.pendingQuestion,
    language: owns(incomingFrame, 'language') ? incomingFrame.language : prior.callFrame.language,
    collectedData: mergedCollectedData,
    completedQuestions: [
      ...prior.callFrame.completedQuestions,
      ...(incomingFrame.completedQuestions ?? []),
      ...(completedQuestions ?? []),
    ],
  }) : prior.callFrame;
  const currentMessages = messages(history);
  const recentSummary = currentMessages.slice(-6)
    .map((message) => `${message.role === 'user' ? 'Caller' : 'Agent'}: ${message.content}`)
    .join(' | ');
  const summary = [prior.summary.slice(-8_000), text(runningSummary, 3_600), recentSummary].filter(Boolean).join(' | ');
  return normalizeConversationMemoryState({
    ...prior,
    summary,
    recentMessages: [...prior.recentMessages, ...currentMessages],
    callback: callback ?? prior.callback,
    collectedData: mergedCollectedData,
    completedQuestions: [...prior.completedQuestions, ...(completedQuestions ?? [])],
    pendingQuestions: pendingQuestions ?? prior.pendingQuestions,
    callFrame: mergedCallFrame,
    lastCall: {
      id: call?.id ?? null,
      providerCallId: call?.providerCallId ?? null,
      direction: call?.direction ?? null,
      outcome: outcome ?? null,
      reason: reason ?? null,
      endedAt: at.toISOString(),
    },
    updatedAt: at.toISOString(),
  });
}
