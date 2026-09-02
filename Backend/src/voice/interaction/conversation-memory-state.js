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
  const collectedInformation = Object.freeze(safeJson(
    value.collectedInformation ?? value.collectedData ?? value.collectedFields ?? value.fields,
  ) ?? {});
  // Canonical entities are committed explicitly by the unified turn. Never
  // rebuild active memory from stale selected-item aliases, categories or
  // ordinary retrieval candidates when serializing the call frame.
  const canonicalEntities = (Array.isArray(value.knownEntities) ? value.knownEntities : [])
    .filter((entry) => entry && typeof entry === 'object');
  return Object.freeze({
    memoryVersion: 1,
    scope: Object.freeze(safeJson(value.scope) ?? {}),
    activeEntity: Object.freeze(safeJson(value.activeEntity) ?? {}),
    activeCategory: Object.freeze(safeJson(value.activeCategory) ?? {}),
    latestIntent: text(value.latestIntent ?? value.requestType, 80) || null,
    pendingClarification: Object.freeze(safeJson(value.pendingClarification) ?? {}),
    activeTool: Object.freeze(safeJson(value.activeTool ?? value.activeToolRequest) ?? {}),
    collectedToolFields: Object.freeze(safeJson(
      value.collectedToolFields ?? collectedInformation,
    ) ?? {}),
    citedEvidence: Object.freeze((Array.isArray(value.citedEvidence)
      ? value.citedEvidence : []).slice(-20).map((source) => safeJson(source)).filter(Boolean)),
    currentTopic: text(value.currentTopic, 240) || null,
    knownEntities: Object.freeze(canonicalEntities.slice(0, 20)
      .map((item) => safeJson(item)).filter(Boolean)),
    comparisonEntities: Object.freeze((Array.isArray(value.comparisonEntities)
      ? value.comparisonEntities : []).slice(0, 5).map((item) => safeJson(item)).filter(Boolean)),
    pendingQuestion: Object.freeze({
      key: text(pending?.key, 500) || null,
      text: text(pending?.text, 500) || null,
      kind: text(pending?.kind, 40) || null,
    }),
    language: text(value.language, 20) || null,
    collectedInformation,
    recentTurns: Object.freeze(messages(Array.isArray(value.recentTurns) ? value.recentTurns : value.messages)),
    lastAnswer: text(value.lastAnswer, maxMessageCharacters) || null,
    activeToolRequest: Object.freeze(safeJson(value.activeToolRequest) ?? {}),
    latestCallerQuestion: text(value.latestCallerQuestion, maxMessageCharacters) || null,
    correctedFields: Object.freeze(stringList(value.correctedFields).slice(0, 30)),
  });
}

export function normalizeConversationMemoryState(value = {}) {
  value = objectValue(value);
  const updatedAt = isoDate(value.updatedAt, new Date().toISOString());
  return Object.freeze({
    schemaVersion: 3,
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
    ...objectValue(prior.callFrame?.collectedInformation),
    ...objectValue(incomingFrame.collectedInformation),
    ...objectValue(incomingFrame.fields),
    ...objectValue(incomingFrame.collectedData),
    ...objectValue(safeJson(collectedData)),
  };
  const mergedCallFrame = callFrame ? normalizeLiveCallFrame({
    ...prior.callFrame,
    ...incomingFrame,
    currentTopic: owns(incomingFrame, 'currentTopic')
      ? incomingFrame.currentTopic : prior.callFrame.currentTopic,
    knownEntities: owns(incomingFrame, 'knownEntities')
      ? incomingFrame.knownEntities : prior.callFrame.knownEntities,
    activeEntity: owns(incomingFrame, 'activeEntity')
      ? incomingFrame.activeEntity : prior.callFrame.activeEntity,
    comparisonEntities: owns(incomingFrame, 'comparisonEntities')
      ? incomingFrame.comparisonEntities : prior.callFrame.comparisonEntities,
    activeCategory: owns(incomingFrame, 'activeCategory')
      ? incomingFrame.activeCategory : prior.callFrame.activeCategory,
    latestIntent: owns(incomingFrame, 'latestIntent')
      ? incomingFrame.latestIntent : prior.callFrame.latestIntent,
    pendingClarification: owns(incomingFrame, 'pendingClarification')
      ? incomingFrame.pendingClarification : prior.callFrame.pendingClarification,
    activeTool: owns(incomingFrame, 'activeTool')
      ? incomingFrame.activeTool : prior.callFrame.activeTool,
    collectedToolFields: owns(incomingFrame, 'collectedToolFields')
      ? incomingFrame.collectedToolFields : prior.callFrame.collectedToolFields,
    citedEvidence: owns(incomingFrame, 'citedEvidence')
      ? incomingFrame.citedEvidence : prior.callFrame.citedEvidence,
    pendingQuestion: owns(incomingFrame, 'pendingQuestion')
      ? incomingFrame.pendingQuestion : prior.callFrame.pendingQuestion,
    language: owns(incomingFrame, 'language') ? incomingFrame.language : prior.callFrame.language,
    collectedInformation: mergedCollectedData,
    recentTurns: owns(incomingFrame, 'recentTurns')
      ? incomingFrame.recentTurns : prior.callFrame.recentTurns,
    lastAnswer: owns(incomingFrame, 'lastAnswer') ? incomingFrame.lastAnswer : prior.callFrame.lastAnswer,
    activeToolRequest: owns(incomingFrame, 'activeToolRequest')
      ? incomingFrame.activeToolRequest : prior.callFrame.activeToolRequest,
    latestCallerQuestion: owns(incomingFrame, 'latestCallerQuestion')
      ? incomingFrame.latestCallerQuestion : prior.callFrame.latestCallerQuestion,
    correctedFields: owns(incomingFrame, 'correctedFields')
      ? incomingFrame.correctedFields : prior.callFrame.correctedFields,
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
