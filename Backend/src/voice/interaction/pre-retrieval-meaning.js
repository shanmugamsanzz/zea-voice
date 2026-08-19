const maximumText = 500;
const maximumList = 12;

function text(value, maximum = maximumText) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function list(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, maximumList)
    : [];
}

function requestType(value) {
  const normalized = text(value, 64).toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : null;
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

export const preRetrievalMeaningSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: [
    'requestType', 'topic', 'explicitEntities', 'requestedFacts', 'constraints',
    'contextualReferences', 'contextDependent', 'topicChanged',
  ],
  properties: {
    requestType: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_]{0,63}$' },
    topic: { type: ['string', 'null'], maxLength: 240 },
    explicitEntities: {
      type: 'array', maxItems: maximumList, items: { type: 'string', maxLength: 160 },
    },
    requestedFacts: {
      type: 'array', maxItems: maximumList, items: { type: 'string', maxLength: 160 },
    },
    constraints: {
      type: 'array', maxItems: maximumList, items: { type: 'string', maxLength: 160 },
    },
    contextualReferences: {
      type: 'array', maxItems: maximumList, items: { type: 'string', maxLength: 160 },
    },
    contextDependent: { type: 'boolean' },
    topicChanged: { type: 'boolean' },
  },
});

export const preRetrievalMeaningSystemPrompt = `You resolve conversational meaning before knowledge retrieval for a multi-tenant voice agent.
Return only the requested JSON object. Do not answer the caller.
Use the complete latest utterance as primary. Use memory only to resolve genuine follow-ups or references.
Choose a concise generic requestType in snake_case. Do not use application-defined intents or assume an industry.
explicitEntities contains only specifically named or context-resolved people, products, services, places, policies or other subjects. Do not include generic words such as item, option, service, details or information by themselves.
requestedFacts contains the facts the caller asks for. contextualReferences contains unresolved or resolved references such as this, that, it or the previous subject.
Set contextDependent true only when the latest utterance cannot be understood correctly without recent context.
Set topicChanged true when the caller explicitly moves away from the saved topic.`;

export function preRetrievalMeaningInput(latestUtterance, memory = {}) {
  return JSON.stringify({
    latestUtterance: text(latestUtterance, 2_000),
    memory: {
      currentTopic: text(memory.currentTopic, 240) || null,
      knownEntities: (memory.knownEntities ?? []).slice(0, 8).map((entity) => ({
        key: text(entity?.key, 160) || null,
        name: text(entity?.name, 240) || null,
        category: text(entity?.category, 240) || null,
      })),
      pendingQuestion: text(memory.pendingQuestion?.text
        ?? memory.pendingQuestionText ?? memory.pendingQuestion, 500) || null,
      lastAnswer: text(memory.lastAnswer, 1_000) || null,
      recentTurns: (memory.recentTurns ?? []).slice(-4).map((turn) => ({
        role: turn?.role === 'assistant' ? 'assistant' : 'user',
        content: text(turn?.content, 500),
      })).filter((turn) => turn.content),
    },
  });
}

export function parsePreRetrievalMeaning(value) {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const expected = [
    'constraints', 'contextDependent', 'contextualReferences', 'explicitEntities',
    'requestType', 'requestedFacts', 'topic', 'topicChanged',
  ];
  if (Object.keys(parsed).sort().join('|') !== expected.sort().join('|')) return null;
  const resolvedRequestType = parsed.requestType === null ? null : requestType(parsed.requestType);
  if (parsed.requestType !== null && !resolvedRequestType) return null;
  if (typeof parsed.contextDependent !== 'boolean' || typeof parsed.topicChanged !== 'boolean') return null;
  if (![parsed.explicitEntities, parsed.requestedFacts, parsed.constraints, parsed.contextualReferences]
    .every(Array.isArray)) return null;
  return Object.freeze({
    requestType: resolvedRequestType,
    questionType: resolvedRequestType,
    topic: parsed.topic === null ? null : text(parsed.topic, 240) || null,
    currentTopic: parsed.topic === null ? null : text(parsed.topic, 240) || null,
    explicitEntities: Object.freeze(list(parsed.explicitEntities)),
    selectedEntities: Object.freeze(list(parsed.explicitEntities).map((name) => Object.freeze({ name }))),
    requestedFacts: Object.freeze(list(parsed.requestedFacts)),
    constraints: Object.freeze(list(parsed.constraints)),
    contextualReferences: Object.freeze(list(parsed.contextualReferences)),
    contextDependent: parsed.contextDependent,
    requiresContext: parsed.contextDependent,
    topicChanged: parsed.topicChanged,
  });
}

export function emptyPreRetrievalMeaning() {
  return Object.freeze({
    requestType: null, questionType: null, topic: null, currentTopic: null,
    explicitEntities: Object.freeze([]), selectedEntities: Object.freeze([]),
    requestedFacts: Object.freeze([]), constraints: Object.freeze([]),
    contextualReferences: Object.freeze([]), contextDependent: false,
    requiresContext: false, topicChanged: false,
  });
}
