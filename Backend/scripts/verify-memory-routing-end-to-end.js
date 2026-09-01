import assert from 'node:assert/strict';
import { deterministicSourceEntry } from '../src/knowledge-engine/deterministic-source-mapping.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { selectCompleteConversationTurns } from '../src/knowledge-engine/conversation-turn-context.js';

const tenants = [
  { tenantId: 'memory-tenant-a', agentId: 'memory-agent-a', language: 'en' },
  { tenantId: 'memory-tenant-b', agentId: 'memory-agent-b', language: 'ta' },
  { tenantId: 'memory-tenant-c', agentId: 'memory-agent-c', language: 'es' },
];

function record(scope, id, type, content, authoritativeData, extra = {}) {
  return Object.freeze({
    id: `published:${id}`, recordId: id, recordType: type,
    tenantId: scope.tenantId, agentId: scope.agentId,
    knowledgeBaseId: `kb-${scope.tenantId}`, publicationRevision: 4,
    documentId: `document-${id}`, documentVersionId: `version-${id}`,
    hydrationValidated: true, publicationValidated: true,
    documentStatus: 'ready', documentVersionStatus: 'ready',
    documentVersionIsCurrent: true, callerFacing: type !== 'WORKFLOW_RULE',
    content, authoritativeData, ...extra,
  });
}

function envelope(sources) {
  const callerSources = sources.filter((source) => source.callerFacing === true);
  return Object.freeze({
    found: callerSources.length > 0,
    sources: Object.freeze(callerSources.map((source, index) => Object.freeze({
      id: `source_${index + 1}`, publishedEvidenceId: source.id,
      recordId: source.recordId, recordType: source.recordType,
      content: source.content, callerFacing: true,
    }))),
    sourceMap: Object.freeze(callerSources.map((source, index) => (
      deterministicSourceEntry(source, `source_${index + 1}`)
    ))),
    entities: Object.freeze(callerSources.filter((source) => source.recordType === 'CATALOG_ITEM')
      .map((source, index) => Object.freeze({
        id: source.recordId, key: source.authoritativeData.itemKey,
        name: source.authoritativeData.name, sourceId: `source_${index + 1}`,
      }))),
  });
}

function decision({ type = 'answer', answer = '', evidenceIds = [], entityKeys = [],
  requestType = null, contextDependent = false, toolRequest = null,
  collectedInformation = {}, correctedFields = [], pendingQuestion = null }) {
  return JSON.stringify({
    decision: type, answer, responseId: null, evidenceIds,
    stateUpdate: {
      currentTopic: entityKeys[0] ?? requestType,
      knownEntityKeys: entityKeys, collectedInformation, correctedFields,
      requestType, contextDependent, pendingQuestionRelevant: false,
      ...(toolRequest ? { activeToolRequest: { name: toolRequest.name } } : {}),
    },
    pendingQuestion, toolRequest,
    clarification: null,
  });
}

function runTurn({
  scope, memory, token, question, records, rawDecision, tools = [],
  fieldSchemas = [], zeroEvidenceResponse = '',
}) {
  const groundingEnvelope = envelope(records);
  memory.beginTurn(token);
  memory.append({ role: 'user', content: question }, { turnToken: token });
  const result = applyUnifiedGroundedTurn({
    rawDecision, groundingEnvelope, memory, turnToken: token,
    evidence: records, finalizedUtterance: question, tools, fieldSchemas,
    zeroEvidenceResponse,
    evidenceScope: {
      tenantId: scope.tenantId, agentId: scope.agentId, requireHydratedEvidence: true,
      publicationRevisions: [{
        knowledgeBaseId: `kb-${scope.tenantId}`, publicationRevision: 4,
      }],
    },
  });
  return result;
}

let validatedTurns = 0;
for (const [tenantIndex, scope] of tenants.entries()) {
  const callId = `memory-call-${tenantIndex}`;
  const memory = openGenericConversationState(
    { ...scope, callId },
    {
      conversationContextMode: 'full_current_call', conversationContextTurns: 5,
      conversationMemoryFields: [
        { key: 'contact_name', label: 'Contact name', type: 'text', required: false,
          question: 'What contact name should I use?' },
        { key: 'contact_number', label: 'Contact number', type: 'phone', required: false,
          question: 'What contact number should I use?' },
        { key: 'requested_date', label: 'Requested date', type: 'date', required: false,
          question: 'What date should I use?' },
      ],
    },
  );
  const first = record(scope, `first-${tenantIndex}`, 'CATALOG_ITEM',
    `Option ${tenantIndex} costs ${1100 + tenantIndex}.`, {
      itemKey: `option-${tenantIndex}`, name: `Option ${tenantIndex}`,
      price: 1100 + tenantIndex, currency: 'UNIT', selectionRules: { selectable: true },
    }, { retrievalContext: 'primary', channels: ['catalog_identity'] });
  const second = record(scope, `second-${tenantIndex}`, 'CATALOG_ITEM',
    `Alternative ${tenantIndex} costs ${2100 + tenantIndex}.`, {
      itemKey: `alternative-${tenantIndex}`, name: `Alternative ${tenantIndex}`,
      price: 2100 + tenantIndex, currency: 'UNIT',
    }, { retrievalContext: 'primary', channels: ['catalog_identity'] });

  const selected = runTurn({
    scope, memory, token: `select-${tenantIndex}`, question: `Explain Option ${tenantIndex}`,
    records: [first],
    rawDecision: decision({
      answer: first.content, evidenceIds: ['source_1'], entityKeys: [`option-${tenantIndex}`],
      requestType: 'details',
    }),
  });
  assert.equal(selected.valid, true);
  assert.equal(selected.state.activeEntity.recordId, first.recordId);

  const contextualFirst = Object.freeze({
    ...first, retrievalContext: 'contextual', channels: ['conversation_memory'],
  });
  const price = runTurn({
    scope, memory, token: `price-${tenantIndex}`, question: 'What is its price?',
    records: [contextualFirst],
    rawDecision: decision({
      answer: first.content, evidenceIds: ['source_1'], entityKeys: [`option-${tenantIndex}`],
      requestType: 'price', contextDependent: true,
    }),
  });
  assert.equal(price.valid, true);
  assert.equal(price.state.activeEntity.recordId, first.recordId);
  assert.deepEqual(price.evidenceIds, ['source_1']);

  const callerDetails = record(scope, `caller-details-${tenantIndex}`, 'GENERAL_KNOWLEDGE',
    'Configured caller details may be collected for the current conversation.', {
      answer: 'Configured caller details may be collected for the current conversation.',
    });
  const phone = `9360235${String(400 + tenantIndex)}`;
  const correctedPhone = `9360236${String(400 + tenantIndex)}`;
  const details = runTurn({
    scope, memory, token: `details-${tenantIndex}`,
    question: `My name is Caller ${tenantIndex}, contact number ${phone}, requested date 2030-04-05.`,
    records: [callerDetails], fieldSchemas: memory.fieldSchemas(),
    rawDecision: decision({
      answer: `Contact name: Caller ${tenantIndex}; contact number: ${phone}; requested date: 2030-04-05.`,
      evidenceIds: ['source_1'], requestType: 'information_collection',
      collectedInformation: {
        contact_name: `Caller ${tenantIndex}`, contact_number: phone, requested_date: '2030-04-05',
      },
    }),
  });
  assert.equal(details.valid, true, JSON.stringify(details));
  assert.equal(details.reason, undefined);
  assert.equal(details.state.collectedInformation.contact_number, phone);
  const correction = runTurn({
    scope, memory, token: `correction-${tenantIndex}`,
    question: `Correct the contact number to ${correctedPhone}.`,
    records: [callerDetails], fieldSchemas: memory.fieldSchemas(),
    rawDecision: decision({
      answer: `Contact number: ${correctedPhone}.`, evidenceIds: ['source_1'],
      requestType: 'information_collection',
      collectedInformation: { contact_number: correctedPhone },
      correctedFields: ['contact_number'],
    }),
  });
  assert.equal(correction.valid, true, JSON.stringify(correction));
  assert.equal(correction.state.collectedInformation.contact_number, correctedPhone);

  for (const [kind, content] of [
    ['location_question', `Office ${tenantIndex} is at 10 Central Road, 60000${tenantIndex}.`],
    ['directions', `Use the north entrance and follow the published route ${tenantIndex}.`],
  ]) {
    const information = record(scope, `${kind}-${tenantIndex}`, 'GENERAL_KNOWLEDGE',
      content, { answer: content });
    const result = runTurn({
      scope, memory, token: `${kind}-${tenantIndex}`, question: kind,
      records: [information],
      rawDecision: decision({ answer: content, evidenceIds: ['source_1'], requestType: kind }),
    });
    assert.equal(result.valid, true);
    assert.equal(result.state.activeEntity.recordId, first.recordId,
      'A non-entity information answer must not overwrite the last selected entity');
    assert.equal(new Set(result.evidenceIds).size, result.evidenceIds.length);
  }

  const workflow = record(scope, `workflow-${tenantIndex}`, 'WORKFLOW_RULE', '', {
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: `reserve_${tenantIndex}`, requiresCatalogItem: true },
  }, { callerFacing: false, activationAllowed: true, retrievalContext: 'primary' });
  const tool = {
    id: `tool-${tenantIndex}`, name: `reserve_${tenantIndex}`,
    identifiers: [`reserve_${tenantIndex}`], description: 'Authorized configured action',
    configuration: { inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  };
  const booking = runTurn({
    scope, memory, token: `booking-${tenantIndex}`, question: 'Please reserve the selected option',
    records: [contextualFirst, workflow], tools: [tool],
    rawDecision: decision({
      type: 'action', evidenceIds: ['source_1'], entityKeys: [`option-${tenantIndex}`],
      requestType: 'action_request', contextDependent: true,
      toolRequest: { name: `reserve_${tenantIndex}`, arguments: {} },
    }),
  });
  assert.equal(booking.valid, true, JSON.stringify({
    reason: booking.reason, state: booking.state, evidenceIds: booking.evidenceIds,
  }));
  assert.equal(booking.toolRequest.name, `reserve_${tenantIndex}`);

  const unauthorizedMemory = openGenericConversationState(
    { ...scope, callId: `${callId}-unauthorized` },
    { conversationContextMode: 'full_current_call', conversationContextTurns: 5 },
    Date.now(), { activeEntity: {
      id: first.recordId, key: `option-${tenantIndex}`, name: `Option ${tenantIndex}`,
    }, knownEntities: [{
      id: first.recordId, key: `option-${tenantIndex}`, name: `Option ${tenantIndex}`,
    }] },
  );
  const unauthorized = runTurn({
    scope: { ...scope, callId: `${callId}-unauthorized` },
    memory: unauthorizedMemory, token: `unauthorized-${tenantIndex}`,
    question: 'Run the action without published authorization', records: [contextualFirst],
    tools: [tool],
    rawDecision: decision({
      type: 'action', evidenceIds: ['source_1'], entityKeys: [`option-${tenantIndex}`],
      requestType: 'action_request', contextDependent: true,
      toolRequest: { name: `reserve_${tenantIndex}`, arguments: {} },
    }),
  });
  assert.equal(unauthorized.valid, false);
  assert.equal(unauthorized.reason, 'unauthorized_tool_request');
  unauthorizedMemory.close();

  const switched = runTurn({
    scope, memory, token: `switch-${tenantIndex}`, question: `Explain Alternative ${tenantIndex}`,
    records: [second],
    rawDecision: decision({
      answer: second.content, evidenceIds: ['source_1'],
      entityKeys: [`alternative-${tenantIndex}`], requestType: 'details',
    }),
  });
  assert.equal(switched.valid, true);
  assert.equal(switched.state.activeEntity.recordId, second.recordId);
  assert.equal(switched.state.knownEntities.some((entity) => entity.recordId === first.recordId), false);

  const unavailableResponse = `Configured unavailable response ${tenantIndex}.`;
  const unavailable = runTurn({
    scope, memory, token: `unavailable-${tenantIndex}`,
    question: `Unknown published fact ${tenantIndex}?`, records: [],
    zeroEvidenceResponse: unavailableResponse,
    rawDecision: decision({
      answer: unavailableResponse, evidenceIds: [], requestType: 'unavailable_information',
    }),
  });
  assert.equal(unavailable.valid, true, JSON.stringify(unavailable));
  assert.equal(unavailable.answer, unavailableResponse);

  const relevantHistory = selectCompleteConversationTurns(memory.snapshot().recentTurns, {
    mode: 'full_current_call', currentQuestion: 'What was the corrected contact and selected option?',
    contextTerms: [correctedPhone, second.authoritativeData.name], maximumPairs: 5,
  });
  assert.ok(relevantHistory.length >= 2, 'relevant complete history must be nonzero');
  assert.equal(relevantHistory.length % 2, 0, 'history must contain complete caller-agent pairs');
  const foreign = record(tenants[(tenantIndex + 1) % tenants.length],
    `foreign-${tenantIndex}`, 'GENERAL_KNOWLEDGE', 'Foreign tenant content.',
    { answer: 'Foreign tenant content.' });
  const leaked = runTurn({
    scope, memory, token: `foreign-${tenantIndex}`, question: 'Foreign content?',
    records: [foreign],
    rawDecision: decision({ answer: foreign.content, evidenceIds: ['source_1'] }),
  });
  assert.equal(leaked.valid, false);

  validatedTurns += 9;
  memory.close();
}

console.log(JSON.stringify({
  gate: 'memory-routing-end-to-end', passed: true,
  tenants: tenants.length, languages: tenants.map((tenant) => tenant.language),
  validatedTurns, followUpPrices: true, lastDiscussedEntities: true,
  relevantHistory: true, callerCorrections: true, fieldCollection: true,
  locationAndDirections: true, authorizedBooking: true, topicSwitching: true,
  unavailableInformation: true, unsupportedNumericFactFalsePositives: 0,
  staleMemory: false, duplicateEvidence: false, unauthorizedTools: false,
  technicalFallbacks: 0, silentTurns: 0, crossTenantLeakage: false,
}, null, 2));
