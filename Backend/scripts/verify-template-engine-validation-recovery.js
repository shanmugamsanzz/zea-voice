import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { RealtimeConversationOrchestrator } = await import('../src/voice/realtime-conversation-orchestrator.js');

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

for (const mode of ['dedicated', 'technical', 'cancelled', 'workflow-config', 'field-config', 'hydration-failure', 'speech-budget']) {
  const configurationFailure = mode.endsWith('-config');
  const recovery = 'Sorry, I could not prepare that answer. Please try again.';
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
      const name = request.responseFormat?.name;
      let output;
      if (configurationFailure) {
        output = { decision: 'TOOL', response: '', clarification: null, search: null,
          tool: { name: 'create_record', arguments: {} }, nextQuestion: null, stateUpdate: null };
      } else if (name === 'template_engine_claim_validation') {
        output = { supported: false, successClaimed: false, requestedFactAddressed: false, reason: 'unsupported_test_claim' };
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
      settings: { technicalFailureMessage: recovery, informationUnavailableMessage: 'No published information.',
        ...(mode === 'dedicated' ? { evidenceValidationFailureMessage: recovery } : {}) } },
    providers: { stt: {}, llm: {}, tts: {} }, tools: [], limits: { maxCallDurationMinutes: 1 },
  };
  const publication = { knowledgeBaseId: 'kb-a', publicationRevision: 1 };
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
      hydrateEvidence: async ({ retrieval }) => ({ evidence: (mode === 'hydration-failure' ? [] : retrieval.candidates).map((entry) => ({
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
    if (mode === 'cancelled') {
      await waitFor(() => postSearchAttempts === 2 && orchestrator.activeLlm === null);
      assert.ok(!spoken.includes(recovery), 'Cancelled generations must not speak recovery');
      assert.ok(!spoken.some((text) => text.includes('9999')));
      continue;
    }
    await waitFor(() => logs.some((entry) => entry.stage === 'template_engine.turn_completed'));
    assert.equal(postSearchAttempts, configurationFailure || mode === 'hydration-failure' ? 0 : 2,
      'Configuration and hydration failures must not reach answer generation');
    if (configurationFailure) assert.equal(orchestrator.templateEngineState.activeWorkflowId, null,
      'No workflow state may be activated on configuration failure');
    assert.ok(spoken.includes(recovery), 'Configured recovery must reach TTS');
    assert.ok(!spoken.some((text) => text.includes('9999')), 'Rejected speech must never reach TTS');
    assert.ok(!JSON.stringify(transcript).includes('9999'), 'Rejected speech must never be committed to the transcript');
    assert.equal(orchestrator.controller.state, 'listening');
    const completed = logs.find((entry) => entry.stage === 'template_engine.turn_completed');
    assert.ok(completed.validationFailure);
    assert.equal(completed.operationalFailure, null);
    assert.deepEqual(completed.evidenceIds, []);
    assert.equal(orchestrator.runtimeMetrics.providerFailures.llm, 0);
  } finally {
    media.close();
  }
}
console.log('Template-engine failed-repair spoken recovery verification passed.');
