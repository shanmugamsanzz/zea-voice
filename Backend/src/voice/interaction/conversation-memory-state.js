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

export function normalizeConversationMemoryState(value = {}) {
  const updatedAt = isoDate(value.updatedAt, new Date().toISOString());
  return Object.freeze({
    schemaVersion: 1,
    summary: text(value.summary, maxSummaryCharacters),
    recentMessages: Object.freeze(messages(value.recentMessages)),
    collectedData: Object.freeze(safeJson(value.collectedData) ?? {}),
    completedQuestions: Object.freeze(stringList(value.completedQuestions)),
    pendingQuestions: Object.freeze(stringList(value.pendingQuestions)),
    callback: Object.freeze(safeJson(value.callback) ?? {}),
    lastCall: Object.freeze(safeJson(value.lastCall) ?? {}),
    updatedAt,
  });
}

export function buildConversationMemoryState({ previous = {}, history = [], call, outcome, reason, callback, at = new Date() }) {
  const prior = normalizeConversationMemoryState(previous);
  const currentMessages = messages(history);
  const recentSummary = currentMessages.slice(-6)
    .map((message) => `${message.role === 'user' ? 'Caller' : 'Agent'}: ${message.content}`)
    .join(' | ');
  const summary = [prior.summary.slice(-8_000), recentSummary].filter(Boolean).join(' | ');
  return normalizeConversationMemoryState({
    ...prior,
    summary,
    recentMessages: [...prior.recentMessages, ...currentMessages],
    callback: callback ?? prior.callback,
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
