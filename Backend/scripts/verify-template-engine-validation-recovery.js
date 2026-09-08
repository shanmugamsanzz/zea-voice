import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { RealtimeConversationOrchestrator, configuredTemplateEngineFailureResponse } = await import('../src/voice/realtime-conversation-orchestrator.js');
const { validateOperationalResponseSettings } = await import('../src/agents/agent.service.js');
const { createTemplateEngineStructuredInvoker } = await import('../src/voice/realtime-conversation-orchestrator.js');
const { templateEngineDecisionJsonSchema, validateTemplateEngineDecision } = await import('../src/voice/interaction/template-engine-decision-contract.js');
const { respondToTemplateEngineSearch } = await import('../src/voice/interaction/template-engine-orchestrator.js');
const { validateTemplateEngineClaims } = await import('../src/voice/interaction/template-engine-claim-validator.js');
const { isPendingRequestAcknowledgement } = await import('../src/voice/interaction/template-engine-pending-request.js');
const { validateRecoveryReadiness } = await import('../src/voice/interaction/recovery-readiness.js');

for (const latestUtterance of [
  'Oncocare package பத்தி சொல்லுங்கன்னு கேட்டேன்',
  'Kids health checkup பத்தி சொல்ல முடியுமானு கேட்டேன்',
  'Okay diabetic appointment book பண்ணுங்க',
  'No, I meant the other option', 'Please answer my earlier question',
  'இதைத்தான் கேட்டேன் பதில் சொல்லுங்க', 'Price?', 'சொல்ல முடியுமா?',
  'Explain the selected option',
]) {
  assert.equal(await isPendingRequestAcknowledgement({ latestUtterance,
    pendingRequest: 'Explain the selected option' }, () => assert.fail('Requests must bypass the shortcut reviewer')), false);
}
for (const act of ['request', 'correction', 'cancellation', 'refusal', 'field_value', 'uncertain']) {
  const invoke = createTemplateEngineStructuredInvoker({ cancel() {}, async *stream() {
    // An inconsistent affirmative boolean must not override the routing act.
    yield { type: 'text_delta', delta: JSON.stringify({ acknowledgementOnly: true, act, acknowledgementText: 'Continue' }) };
    yield { type: 'completed', finishReason: 'stop' };
  } });
  assert.equal(await isPendingRequestAcknowledgement({ latestUtterance: 'Continue', pendingRequest: 'Explain an option' }, invoke), false);
}
assert.equal(await isPendingRequestAcknowledgement({ latestUtterance: 'Okay continue', pendingRequest: 'Explain an option' },
  async () => ({ outputParsed: { acknowledgementOnly: true, act: 'acknowledgement', acknowledgementText: 'Okay' } })), false);
assert.equal(await isPendingRequestAcknowledgement({ latestUtterance: 'Selected option', pendingRequest: 'Explain the selected option' },
  () => assert.fail('Repeated subject words must enter routing')), false);

for (const question of ['Which option do you mean?', 'நீங்கள் எந்தப் பேக்கேஜைக் குறிப்பிடுகிறீர்கள்?']) {
  for (const rejected of [false, true]) {
    let generations = 0;
    const invoke = createTemplateEngineStructuredInvoker({ cancel() {}, async *stream(request) {
      let output;
      if (request.responseFormat.name === 'template_engine_claim_validation') {
        assert.ok(request.messages[0].content.includes('supported without factual evidence'));
        assert.ok(request.messages[0].content.includes('NOT that it provides tests, prices or details'));
        assert.ok(request.messages[0].content.includes('Named candidates must both belong to ambiguity.candidates'));
        assert.ok(!request.messages[0].content.includes('A requested list must give its supported entries'));
        assert.ok(request.messages[0].content.includes('"ambiguity":{"required":true'));
        output = { supported: !rejected, successClaimed: false, requestedFactAddressed: !rejected,
          reason: rejected ? 'unsupported_named_option' : null };
      } else {
        generations += 1;
        assert.deepEqual(request.responseFormat.schema.properties.decision.enum, ['CLARIFY']);
        output = { decision: 'CLARIFY', response: '', evidenceIds: [], nextQuestion: null,
          stateUpdate: null, clarification: { question: rejected ? 'Did you mean Unpublished Premium?' : question,
            reason: null, candidates: [] } };
      }
      yield { type: 'text_delta', delta: JSON.stringify(output) };
      yield { type: 'completed', finishReason: 'stop' };
    } });
    const pending = respondToTemplateEngineSearch({ mainPrompt: 'Clarify unresolved requests.',
      latestUtterance: 'Unclear option details', state: {}, verifiedEvidence: [],
      scope: { tenantId: 'tenant-a', agentId: 'agent-a', publications: [{ knowledgeBaseId: 'kb-a', publicationRevision: 1 }] },
      informationUnavailableResponse: 'Information unavailable.',
      searchDecision: { decision: 'SEARCH', response: '', clarification: null, tool: null,
        nextQuestion: null, stateUpdate: null, search: { query: 'Unclear option', requestedFact: 'details',
          contextualReference: null, preferredRecordIds: [] } },
    }, { tenantBoundaryVerified: true, invokeStructuredLlm: invoke,
      ambiguity: { required: true, kind: 'unresolved_published_entity', candidates: [] },
      validateGroundedClaims: ({ response, selectedEvidence, ...rest }) => validateTemplateEngineClaims({
        ...rest, speech: response, evidence: selectedEvidence }, { invokeStructuredLlm: invoke }),
    });
    if (rejected) await assert.rejects(pending, { code: 'TEMPLATE_ENGINE_OUTPUT_INVALID' });
    else assert.equal((await pending).decision.clarification.question, question);
    assert.equal(generations, rejected ? 2 : 1);
  }
}

const initiation = { decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'configured_action', arguments: {} }, nextQuestion: null, stateUpdate: null };
const cancellation = { ...initiation, decision: 'RESPONSE', response: 'Cancelled.', tool: null,
  stateUpdate: { set: { confirmationStatus: null },
    clear: ['activeWorkflowId', 'collectedToolFields', 'confirmationStatus'] } };
assert.equal(validateTemplateEngineDecision(cancellation).valid, true);
for (const [update, violation] of [
  [{ ...cancellation, nextQuestion: { question: 'Continue?', reason: null } }, 'cancellation_disallows_next_question'],
  [{ ...cancellation, stateUpdate: { ...cancellation.stateUpdate, set: { confirmationStatus: 'confirmed' } } }, 'cancellation_requires_null_confirmation'],
  [{ ...cancellation, stateUpdate: { ...cancellation.stateUpdate, clear: ['activeWorkflowId', 'confirmationStatus'] } }, 'cancellation_missing_clear:collectedToolFields'],
]) {
  const rejection = validateTemplateEngineDecision(update);
  assert.equal(rejection.reason, 'invalid_workflow_cancellation');
  assert.ok(rejection.details.violations.includes(violation));
}
for (const repeatFailure of [false, true]) {
  let attempts = 0;
  const diagnostics = [];
  const invoke = createTemplateEngineStructuredInvoker({
    async *stream(request) {
      attempts += 1;
      if (attempts === 2) {
        const feedback = request.messages.at(-1).content;
        assert.ok(feedback.includes('cancellation_requires_response'));
        assert.ok(feedback.includes('cancellation_missing_clear:collectedToolFields'));
        assert.ok(feedback.includes('Do not change a booking request into cancellation'));
        assert.equal(request.messages[0].content, 'Start the requested configured action.');
      }
      const output = attempts === 1 || repeatFailure ? { ...initiation,
        stateUpdate: { set: { confirmationStatus: null }, clear: ['activeWorkflowId'] } } : initiation;
      yield { type: 'text_delta', delta: JSON.stringify(output) };
      yield { type: 'completed', finishReason: 'stop' };
    },
    cancel() {},
  }, { onStructuredOutputRetry: (details) => diagnostics.push(details) });
  const pending = invoke({ messages: [{ role: 'user', content: 'Start the requested configured action.' }],
    responseFormat: { type: 'json_schema', name: 'template_engine_decision', strict: true,
      schema: templateEngineDecisionJsonSchema } });
  if (repeatFailure) await assert.rejects(pending, (error) =>
    error.code === 'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID'
    && error.details.reason === 'invalid_workflow_cancellation');
  else {
    const result = await pending;
    assert.equal(result.outputParsed.decision, 'TOOL');
    assert.equal(result.outputParsed.stateUpdate, null);
    assert.deepEqual(result.outputParsed.tool.arguments, {});
  }
  assert.equal(attempts, 2, 'Only one structured-output repair is permitted');
  assert.equal(diagnostics[0].reason, 'invalid_workflow_cancellation');
  assert.ok(diagnostics[0].contractDetails.violations.includes('cancellation_requires_response'));
}
const activeSettings = { technicalFailureMessage: 'Technical problem.',
  informationUnavailableMessage: 'That detail is not published.' };
assert.throws(() => validateOperationalResponseSettings('active', activeSettings),
  { code: 'AGENT_NEUTRAL_RECOVERY_MESSAGE_REQUIRED' });
assert.throws(() => validateOperationalResponseSettings('active', { ...activeSettings,
  nonFactualRecoveryMessage: '   ' }), { code: 'AGENT_NEUTRAL_RECOVERY_MESSAGE_REQUIRED' });
assert.doesNotThrow(() => validateOperationalResponseSettings('inactive', activeSettings));
assert.doesNotThrow(() => validateOperationalResponseSettings('active', { ...activeSettings,
  nonFactualRecoveryMessage: 'Please rephrase your request.' }));
assert.doesNotThrow(() => validateOperationalResponseSettings('active', { ...activeSettings,
  evidenceValidationFailureMessage: 'Please rephrase.',
  workflowConfigurationFailureMessage: 'I cannot complete this request right now.' }));
assert.throws(() => validateOperationalResponseSettings('active', { ...activeSettings,
  nonFactualRecoveryMessage: 'a'.repeat(501) }), { code: 'AGENT_RECOVERY_MESSAGE_INVALID' });
for (const value of ['{{missing}}', '\u200b', 'workflow: start the configured tool', { text: 'Please rephrase.' }]) {
  assert.throws(() => validateOperationalResponseSettings('active', { ...activeSettings,
    nonFactualRecoveryMessage: value }), { code: 'AGENT_RECOVERY_MESSAGE_INVALID' });
}
const messageProfile = { agent: { settings: {
  evidenceValidationFailureMessage: 'Please rephrase that request.',
  workflowConfigurationFailureMessage: 'I cannot start this request right now.',
  technicalFailureMessage: 'The service is temporarily having a technical problem.',
  nonFactualRecoveryMessage: 'Sorry, I could not complete that response.',
} } };
for (const [kind, key] of [['validation', 'evidenceValidationFailureMessage'],
  ['configuration', 'workflowConfigurationFailureMessage'], ['operational', 'technicalFailureMessage'],
  ['unexpected', 'technicalFailureMessage']]) {
  assert.equal(configuredTemplateEngineFailureResponse(messageProfile, kind), messageProfile.agent.settings[key]);
}
for (const kind of ['validation', 'configuration']) {
  assert.equal(configuredTemplateEngineFailureResponse({ agent: { settings: {
    technicalFailureMessage: 'Technical problem.',
  } } }, kind), '', 'Non-operational failures must never borrow technical speech');
}
assert.equal(configuredTemplateEngineFailureResponse(messageProfile, 'cancelled'), '');
assert.equal(configuredTemplateEngineFailureResponse(messageProfile, 'unclassified'), '');
const onlyRephrase = { nonFactualRecoveryMessage: 'Please rephrase your request.' };
assert.equal(configuredTemplateEngineFailureResponse({ agent: { settings: onlyRephrase } }, 'configuration'), '',
  'A caller cannot repair tool configuration by rephrasing');
assert.equal(configuredTemplateEngineFailureResponse({ agent: { settings: onlyRephrase } }, 'operational'), '');
assert.throws(() => validateRecoveryReadiness(onlyRephrase, { requiresWorkflowRecovery: true }),
  { code: 'AGENT_WORKFLOW_RECOVERY_MESSAGE_REQUIRED' });
assert.doesNotThrow(() => validateRecoveryReadiness({ ...onlyRephrase,
  workflowConfigurationFailureMessage: 'I cannot start that action right now.',
  technicalFailureMessage: 'A technical failure occurred.' }, { requiresWorkflowRecovery: true }));
assert.throws(() => validateRecoveryReadiness({ ...onlyRephrase,
  workflowConfigurationFailureMessage: 'I cannot start that action right now.' },
{ requiresWorkflowRecovery: true }), { code: 'AGENT_TECHNICAL_FAILURE_MESSAGE_REQUIRED' });

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Voice recovery did not complete');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Stt {
  listeners = new Set();
  async connect() {}
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event) { for (const listener of this.listeners) listener(event); }
  async *events() {}
  sendAudio() {}
  flush() {}
  cancel() {}
  close() {}
}
class Audio {
  waiters = [];
  start() {}
  readInbound() { return new Promise((resolve) => this.waiters.push(resolve)); }
  beginOutputGeneration(id) { this.current = id; return id; }
  async enqueueSynthesized(_audio, id) { return this.current === id; }
  async flushSynthesized() { return true; }
  async drainOutput() {}
  cancelStaleAudio() { this.current = null; return { removedFrames: 0 }; }
  async close() { for (const resolve of this.waiters.splice(0)) resolve(null); }
}

for (const mode of ['dedicated', 'neutral', 'unconfigured', 'cancelled', 'workflow-config', 'field-config', 'hydration-failure', 'speech-budget', 'booking-routing', 'provider-failure', 'unexpected-failure']) {
  const configurationFailure = mode.endsWith('-config');
  const providerFailure = mode === 'provider-failure';
  const unexpectedFailure = mode === 'unexpected-failure';
  const routingFailure = mode === 'booking-routing';
  const forceHydrationFailure = ['dedicated', 'neutral', 'unconfigured',
    'hydration-failure'].includes(mode);
  const recovery = providerFailure || unexpectedFailure ? 'A technical failure occurred.' : mode === 'neutral'
    ? 'மன்னிக்கவும், உங்கள் கோரிக்கைக்கு சரியான பதிலைத் தயார் செய்ய முடியவில்லை. கொஞ்சம் வேறு விதமாகச் சொல்ல முடியுமா?'
    : 'Sorry, I could not prepare that answer. Please try again.';
  const logs = [];
  const spoken = [];
  const transcript = [];
  let postSearchAttempts = 0;
  const media = new EventEmitter();
  media.callId = 'recovery-call';
  media.started = true;
  media.call = { id: media.callId, providerCallId: media.callId, agentId: 'agent-a',
    tenantId: 'tenant-a', workspaceId: 'workspace-a', direction: 'inbound', from: '+10000000000', to: '+10000000001' };
  media.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (entry) => logs.push(entry)]));
  media.close = () => { if (!media.closed) { media.closed = true; media.emit('closed', { session: media }); } };
  const stt = new Stt();
  const llm = {
    async connect() {}, cancel() {}, close() {},
    async *stream(request) {
      if (providerFailure) throw Object.assign(new Error('Simulated provider outage'), { code: 'LLM_PROVIDER_TIMEOUT' });
      if (unexpectedFailure) throw new Error('Simulated unexpected application failure');
      const name = request.responseFormat?.name;
      let output;
      if (name === 'template_engine_multilingual_entity_review') {
        output = { relation: 'unrelated', candidateId: null };
      } else if (name === 'template_engine_entity_coverage') {
        const data = JSON.parse(request.messages.at(-1).content);
        output = { resolved: true, evidenceIds: data.evidence.map((entry) => entry.evidenceId) };
      } else if (name === 'template_engine_pending_request_review') {
        const data = JSON.parse(request.messages.at(-1).content);
        const acknowledgementOnly = ['Hello', 'ஆ'].includes(data.latestUtterance);
        output = { acknowledgementOnly, act: acknowledgementOnly ? 'acknowledgement' : 'request',
          acknowledgementText: acknowledgementOnly ? data.latestUtterance : '' };
      } else if (name === 'template_engine_orchestrator_decision'
        && ['Hello', 'ஆ'].includes(request.messages.at(-1)?.content)) {
        output = { decision: 'RESPONSE', response: 'I am listening.', clarification: null,
          search: null, tool: null, nextQuestion: null, stateUpdate: null };
      } else if (routingFailure) {
        output = { ...initiation, stateUpdate: { set: { confirmationStatus: null }, clear: ['activeWorkflowId'] } };
      } else if (configurationFailure) {
        output = { decision: 'TOOL', response: '', clarification: null, search: null,
          tool: { name: 'create_record', arguments: {} }, nextQuestion: null, stateUpdate: null };
      } else if (name === 'template_engine_claim_validation') {
        const conversational = request.messages.some((message) => message.content.includes('I am listening.'));
        output = { supported: conversational, successClaimed: false,
          requestedFactAddressed: conversational,
          reason: conversational ? null : 'unsupported_test_claim' };
      } else if (name === 'template_engine_post_search_decision') {
        postSearchAttempts += 1;
        if (mode === 'speech-budget') assert.ok(request.messages[0].content.includes('100 characters'),
          'The live configured TTS limit must reach answer generation');
        if (mode === 'cancelled' && postSearchAttempts === 2) {
          yield { type: 'cancelled', reason: 'caller_barge_in' };
          return;
        }
        output = { decision: 'RESPONSE', response: mode === 'speech-budget'
          ? 'The price is 9999 units. '.repeat(10) : 'The price is 9999 units.',
          clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null };
      } else {
        output = { decision: 'SEARCH', response: '', clarification: null,
          search: { query: 'Alpha price', requestedFact: 'price', contextualReference: null, preferredRecordIds: [] },
          tool: null, nextQuestion: null, stateUpdate: null };
      }
      yield { type: 'text_delta', delta: JSON.stringify(output) };
      yield { type: 'completed', usage: {} };
    },
  };
  const tts = {
    async connect() {}, cancel() {}, close() {},
    async *synthesizeStream({ text, generationId }) {
      spoken.push(text);
      yield { type: 'audio_chunk', generationId, audio: Buffer.alloc(160) };
      yield { type: 'completed', generationId, usage: { characters: text.length, audioOutputMs: 20 } };
    },
  };
  const profile = {
    agent: { id: 'agent-a', tenantId: 'tenant-a', workspaceId: 'workspace-a', language: 'English (US)',
      prompt: 'Answer only from supplied evidence.', welcomeMessage: 'Welcome.', inactivityTimeoutSeconds: 60,
      settings: { technicalFailureMessage: 'A technical failure occurred.', informationUnavailableMessage: 'No published information.',
        acknowledgementPhrases: ['Hello', 'ஆ'],
        ...(mode !== 'unconfigured' ? { nonFactualRecoveryMessage: recovery } : {}),
        ...(configurationFailure ? { workflowConfigurationFailureMessage: recovery } : {}),
        ...(mode === 'dedicated' ? { evidenceValidationFailureMessage: recovery } : {}) } },
    providers: { stt: {}, llm: {}, tts: {} }, tools: [], limits: { maxCallDurationMinutes: 1 },
  };
  const publication = { tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 1 };
  if (mode === 'speech-budget') profile.limits.ttsMaxCharactersPerResponse = 100;
  if (configurationFailure) profile.tools = [{ id: 'tool-a', name: 'create_record', status: 'active',
    type: 'webhook_api', inputSchema: { type: 'object', additionalProperties: false,
      properties: mode === 'field-config' ? { caller_name: { type: 'string' } } : {},
      required: mode === 'field-config' ? ['caller_name'] : [],
    } }];
  const orchestrator = new RealtimeConversationOrchestrator(media, {
    loadProfile: async () => profile, createAdapters: async () => ({ stt, llm, tts }),
    createAudioEngine: () => new Audio(),
    welcomeCache: { get: async () => Buffer.alloc(160), set: async () => true },
    appendTranscript: async (entry) => transcript.push(entry), completeCall: async () => ({}),
    contextStore: { get: async () => null, set: async () => true, delete: async () => true },
    memoryStore: { load: async () => null, save: async () => ({}) },
    executeTools: async () => { assert.fail('Incomplete configuration must never execute a tool'); },
    templateEngineKnowledgeDependencies: {
      loadArtifacts: async () => ({ publications: [publication], sparseIndexes: [], bundles: [{
        ...publication, tenantId: 'tenant-a', records: configurationFailure ? [{ record_id: 'workflow-a',
          record_type: 'WORKFLOW_RULE', entity_metadata: { actionType: 'configured_tool',
            actionConfig: { toolIdentifier: 'create_record' } } }] : [{ record_id: 'alpha', record_type: 'catalog_item',
          entity_name: 'Alpha', entity_metadata: { price: 17 }, usage_direction: 'both' }],
      }] }),
      searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
      hydrateEvidence: async ({ retrieval }) => ({ evidence: (forceHydrationFailure && spoken.length === 0
        ? [] : retrieval.candidates).map((entry) => ({
        ...entry, id: entry.recordId, callerFacing: true, hydrationValidated: true, publicationValidated: true,
        content: 'Alpha costs 17 units.', authoritativeData: { price: 17 }, provenance: publication,
      })) }),
    },
  });
  try {
    await orchestrator.ready;
    media.emit('start', { session: media });
    await waitFor(() => orchestrator.controller.state === 'listening');
    stt.publish({ type: 'final_transcript', text: 'Alpha price please', language: 'en', isFinal: true });
    if (mode === 'unconfigured') {
      await waitFor(() => logs.some((entry) => entry.stage === 'template_engine.recovery_unconfigured')
        && orchestrator.controller.state === 'listening');
      assert.ok(!media.closed, 'Missing recovery must not hang up an established call');
      assert.ok(logs.some((entry) => entry.stage === 'template_engine.recovery_unconfigured'));
      assert.ok(!spoken.includes('A technical failure occurred.'));
      assert.ok(!spoken.some((text) => text.includes('9999')));
      continue;
    }
    if (mode === 'cancelled') {
      await waitFor(() => postSearchAttempts === 2 && orchestrator.activeLlm === null);
      assert.ok(!spoken.includes(recovery), 'Cancelled generations must not speak recovery');
      assert.ok(!spoken.some((text) => text.includes('9999')));
      continue;
    }
    await waitFor(() => logs.some((entry) => entry.stage === 'template_engine.turn_completed'));
    assert.equal(postSearchAttempts, configurationFailure || providerFailure || unexpectedFailure
      || routingFailure || forceHydrationFailure ? 0 : 2,
      'Configuration and hydration failures must not reach answer generation');
    if (configurationFailure) assert.equal(orchestrator.templateEngineState.activeWorkflowId, null,
      'No workflow state may be activated on configuration failure');
    const completed = logs.find((entry) => entry.stage === 'template_engine.turn_completed');
    if (mode === 'speech-budget') {
      assert.equal(completed.recoveryKind, null,
        'A supported extractive answer should be preferred over configured recovery');
      assert.ok(!spoken.some((text) => text.includes('9999')),
        'Oversized rejected speech must never reach TTS');
      continue;
    }
    assert.ok(spoken.includes(recovery), `Configured recovery must reach TTS (${mode})`);
    assert.ok(!media.closed, 'Approved recovery must preserve the established call');
    if (!configurationFailure && !providerFailure && !unexpectedFailure
      && !routingFailure && !forceHydrationFailure) {
      const retrievalLog = logs.find((entry) => entry.stage === 'template_engine.retrieval_completed');
      assert.ok(Object.hasOwn(retrievalLog, 'entityMatch'));
      assert.ok(Object.hasOwn(retrievalLog, 'preferredRecordIds'));
      assert.ok(Object.hasOwn(retrievalLog, 'ambiguity'));
    }
    assert.equal(spoken.includes('A technical failure occurred.'), providerFailure || unexpectedFailure,
      'Only operational or unexpected runtime failures may use the technical failure message');
    if (mode === 'field-config') {
      const rejection = logs.find((entry) => entry.stage === 'template_engine.response_rejected');
      assert.equal(rejection.err.details.reason, 'TEMPLATE_ENGINE_WORKFLOW_FIELD_CONFIGURATION_MISSING');
      assert.deepEqual(rejection.err.details.validationDetails, {
        fields: ['caller_name'],
        toolId: 'tool-a',
        schemaDiagnostics: { effectiveSource: 'inputSchema', sources: [{ source: 'inputSchema',
          propertyKeys: ['caller_name'], requiredKeys: ['caller_name'] }] },
        fieldIssues: [{ field: 'caller_name', reason: 'missing_input_field' }],
      });
      assert.ok(!spoken.some((text) => text.includes('caller_name')),
        'Internal field diagnostics must never become spoken recovery');
      assert.ok(!JSON.stringify(transcript).includes('caller_name'));
    }
    assert.ok(!spoken.some((text) => text.includes('9999')), 'Rejected speech must never reach TTS');
    assert.ok(!JSON.stringify(transcript).includes('9999'), 'Rejected speech must never be committed to the transcript');
    assert.equal(orchestrator.controller.state, 'listening');
    assert.equal(completed.recoveryKind, providerFailure ? 'operational'
      : unexpectedFailure ? 'unexpected' : configurationFailure ? 'configuration' : 'validation');
    assert.equal(Boolean(completed.validationFailure), !providerFailure && !unexpectedFailure);
    assert.equal(completed.operationalFailure, providerFailure ? 'LLM_PROVIDER_TIMEOUT' : null);
    assert.equal(completed.unexpectedFailure,
      unexpectedFailure ? 'TEMPLATE_ENGINE_UNEXPECTED_FAILURE' : null);
    assert.deepEqual(completed.evidenceIds, []);
    assert.equal(orchestrator.runtimeMetrics.providerFailures.llm, providerFailure ? 1 : 0);
    assert.ok(logs.some((entry) => entry.stage === 'template_engine.recovery_delivered'));
    if (mode === 'neutral' || routingFailure) {
      const pendingText = orchestrator.pendingTemplateEngineRequest.text;
      const initialAttempts = postSearchAttempts;
      for (const utterance of ['Hello', 'ஆ']) {
        const before = logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length;
        stt.publish({ type: 'final_transcript', text: utterance, language: 'ta', isFinal: true });
        await waitFor(() => logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length > before);
        assert.equal(orchestrator.pendingTemplateEngineRequest.text, pendingText);
        assert.equal(postSearchAttempts, initialAttempts, 'Acknowledgements must not become new knowledge searches');
        assert.equal(orchestrator.controller.state, 'listening');
        assert.ok(!media.closed);
      }
      assert.equal(logs.filter((entry) => entry.stage === 'template_engine.pending_request_preserved').length, 2);
      const before = logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length;
      stt.publish({ type: 'final_transcript', text: 'Different service price please', language: 'en', isFinal: true });
      await waitFor(() => logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length > before);
      if (routingFailure) assert.equal(orchestrator.pendingTemplateEngineRequest.text, 'Different service price please');
      else {
        assert.equal(orchestrator.pendingTemplateEngineRequest, null,
          'A safe configured NO_MATCH response must complete an empty-evidence request');
        assert.ok(postSearchAttempts > initialAttempts, 'A new question must proceed through normal routing');
      }
      const bounded = logs.filter((entry) => ['template_engine.pending_request_preserved',
        'template_engine.recovery_delivered'].includes(entry.stage));
      assert.ok(!JSON.stringify(bounded).includes(pendingText), 'New diagnostics must not expose caller text');
    }
  } finally {
    media.close();
  }
}
console.log('Template-engine failed-repair spoken recovery verification passed.');
