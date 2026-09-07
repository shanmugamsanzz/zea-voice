import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// Deliberately offline. These adapters cannot certify live model or acoustic quality.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { RealtimeConversationOrchestrator } = await import('../src/voice/realtime-conversation-orchestrator.js');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/template-engine-sept06-replay.json', import.meta.url), 'utf8'));
const publication = { tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 1 };
const records = Object.entries(fixture.subjects).map(([id, subject]) => ({
  record_id: id, record_type: 'catalog_item', entity_name: subject.name, usage_direction: 'both',
  content: subject.answer, entity_metadata: { itemKey: id, name: subject.name,
    aliases: fixture.turns.filter((turn) => turn.subject === id && turn.id !== 'welcome' && !turn.noPublishedAlias && !turn.contextual).map((turn) => turn.text),
    details: subject.answer },
}));
records.push({ record_id: 'welcome-next', record_type: 'conversation_node', usage_direction: 'both',
  content: 'After the caller confirms their identity, explain the available packages.',
  entity_metadata: { nodeKey: 'welcome-next', purpose: 'After identity acknowledgement give the published overview.',
    catalogReferences: ['Available packages => item:overview'] } });
const recovery = 'Sorry, I could not prepare that answer. Please try again.';
const logs = [], spoken = [], audioFrames = [], results = [];
let turn, stages = new Set(), failAnswer = false, resolvedCoverageSkips = 0;
class Stt {
  listeners = new Set();
  async connect() {} cancel() {} close() {} sendAudio() {} flush() {}
  async *events() {}
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  publish(event) { for (const fn of this.listeners) fn(event); }
}
class Audio {
  waiters = [];
  start() {}
  readInbound() { return new Promise((resolve) => this.waiters.push(resolve)); }
  beginOutputGeneration(id) { this.current = id; return id; }
  async enqueueSynthesized(audio, id) {
    if (id !== this.current) return false;
    audioFrames.push({ id, bytes: audio.length }); return true;
  }
  async flushSynthesized() { return true; }
  async drainOutput() {}
  cancelStaleAudio() { this.current = null; return { removedFrames: 0 }; }
  async close() { for (const resolve of this.waiters.splice(0)) resolve(null); }
}
const stt = new Stt();
const llm = { async connect() {}, cancel() {}, close() {}, async *stream(request) {
  const name = request.responseFormat?.name;
  stages.add(name);
  let output;
  if (name === 'template_engine_contextual_subject_review') {
    const data = JSON.parse(request.messages.at(-1).content);
    const candidate = data.candidates.find((item) => item.name === fixture.subjects[turn.subject].name);
    assert.ok(candidate);
    output = { relation: 'reference', subjectIds: [candidate.id] };
  } else if (name === 'template_engine_multilingual_entity_review') {
    const data = JSON.parse(request.messages.at(-1).content);
    const candidate = data.candidates.find((item) => item.name === fixture.subjects[turn.subject].name);
    assert.ok(candidate);
    assert.ok(!candidate.aliases.includes(turn.text), 'Cross-script regression must not rely on an exact alias');
    output = { relation: 'equivalent', candidateId: candidate.id };
  } else if (name === 'template_engine_welcome_meaning') {
    output = { continuation: true, guidanceRecordId: 'welcome-next', query: 'Available packages', requestedFact: 'details' };
  } else if (name === 'template_engine_entity_coverage') {
    const data = JSON.parse(request.messages.at(-1).content);
    assert.ok(data.evidence.some((item) => item.recordId === turn.subject), `Wrong evidence for ${turn.id}`);
    output = { resolved: true, evidenceIds: data.evidence.map((item) => item.evidenceId) };
  } else if (name === 'template_engine_claim_validation') {
    output = { supported: !failAnswer, successClaimed: false, requestedFactAddressed: !failAnswer,
      reason: failAnswer ? 'invented price 9999' : null };
  } else if (name === 'template_engine_post_search_decision') {
    const data = JSON.parse(request.messages[0].content.split('<orchestrator_turn_input>\n')[1].split('\n</orchestrator_turn_input>')[0]);
    const cited = data.verifiedEvidence.find((item) => item.recordId === turn.subject);
    assert.ok(cited, `Requested subject missing for ${turn.id}`);
    output = { decision: 'RESPONSE', response: failAnswer ? 'The price is 9999.' : fixture.subjects[turn.subject].answer,
      clarification: null, evidenceIds: [cited.evidenceId], nextQuestion: null, stateUpdate: null };
  } else if (name === 'template_engine_reference_review') {
    output = { relation: turn.contextual ? 'reference' : 'new_request' };
  } else if (name === 'template_engine_pending_request_review') {
    output = { acknowledgementOnly: false, act: 'request', acknowledgementText: '' };
  } else {
    output = { decision: 'SEARCH', response: '', clarification: null,
      search: { query: fixture.subjects[turn.subject].name, requestedFact: 'details',
        contextualReference: turn.contextual ? 'Kids' : null,
        preferredRecordIds: turn.contextual ? ['kids'] : [] },
      tool: null, nextQuestion: null, stateUpdate: null };
  }
  // Exercise the actual streaming structured-output parser, not outputParsed mocks.
  const json = JSON.stringify(output);
  yield { type: 'text_delta', delta: json.slice(0, 20) };
  yield { type: 'text_delta', delta: json.slice(20) };
  yield { type: 'completed', usage: {} };
} };
const tts = { async connect() {}, cancel() {}, close() {}, async *synthesizeStream({ text, generationId }) {
  spoken.push(text);
  yield { type: 'audio_chunk', generationId, audio: Buffer.alloc(160) };
  yield { type: 'completed', generationId, usage: { characters: text.length, audioOutputMs: 20 } };
} };
const media = new EventEmitter();
media.callId = 'offline-conversation-replay'; media.started = true;
media.call = { id: media.callId, providerCallId: media.callId, agentId: 'agent-a', tenantId: 'tenant-a',
  workspaceId: 'workspace-a', direction: 'inbound', from: '+10000000000', to: '+10000000001' };
media.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (entry) => logs.push(entry)]));
media.close = () => { if (!media.closed) { media.closed = true; media.emit('closed', { session: media }); } };
const orchestrator = new RealtimeConversationOrchestrator(media, {
  loadProfile: async () => ({ agent: { id: 'agent-a', tenantId: 'tenant-a', workspaceId: 'workspace-a',
    language: 'Tamil', prompt: 'Follow published guidance and answer the current request.',
    welcomeMessage: 'Am I speaking to the account holder?', inactivityTimeoutSeconds: 60,
    settings: { nonFactualRecoveryMessage: recovery, technicalFailureMessage: 'Technical failure.',
      informationUnavailableMessage: 'No published information.' } },
    providers: { stt: {}, llm: {}, tts: {} }, tools: [],
    limits: { maxCallDurationMinutes: 5, ttsMaxCharactersPerResponse: 500 } }),
  createAdapters: async () => ({ stt, llm, tts }), createAudioEngine: () => new Audio(),
  welcomeCache: { get: async () => Buffer.alloc(160), set: async () => true },
  appendTranscript: async () => {}, completeCall: async () => ({}),
  contextStore: { get: async () => null, set: async () => true, delete: async () => true },
  memoryStore: { load: async () => null, save: async () => ({}) },
  executeTools: async () => assert.fail('Informational replay must not execute tools'),
  templateEngineKnowledgeDependencies: {
    loadArtifacts: async () => ({ publications: [publication], sparseIndexes: [], bundles: [{ ...publication, records }] }),
    searchCandidates: async () => { stages.add('retrieval'); return { channels: { structured: [], bm25: [], qdrant: [] } }; },
    hydrateEvidence: async ({ retrieval }) => ({ evidence: retrieval.candidates.map((entry) => {
      const record = records.find((item) => item.record_id === entry.recordId);
      return { ...entry, id: entry.recordId, callerFacing: true, hydrationValidated: true, publicationValidated: true,
        content: record.content, authoritativeData: record.entity_metadata, provenance: publication };
    }) }),
  },
});
async function waitFor(fn) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, `Replay timed out: ${turn?.id}; stages=${[...stages]}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  await orchestrator.ready;
  media.emit('start', { session: media });
  await waitFor(() => orchestrator.controller.state === 'listening');
  for (turn of [...fixture.turns, { id: 'rejected-repair', text: 'Kids package details please', subject: 'kids' }]) {
    stages = new Set(); failAnswer = turn.id === 'rejected-repair';
    const before = spoken.length, framesBefore = audioFrames.length;
    const completed = logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length;
    stt.publish({ type: 'final_transcript', text: turn.text, language: 'ta', isFinal: true });
    await waitFor(() => logs.filter((entry) => entry.stage === 'template_engine.turn_completed').length > completed
      && orchestrator.controller.state === 'listening');
    const answer = spoken.slice(before).join(' ');
    assert.ok(answer && audioFrames.length > framesBefore, `Silent turn ${turn.id}`);
    if (failAnswer) { assert.ok(answer.includes(recovery)); assert.ok(!answer.includes('9999')); }
    else {
      assert.ok(answer.includes(fixture.subjects[turn.subject].answer), `Wrong spoken answer: ${turn.id}: ${answer}; diagnostics=${JSON.stringify(logs.filter((entry) => entry.error || entry.code || entry.validationReason || entry.reason))}`);
      for (const token of fixture.subjects[turn.subject].required) assert.ok(answer.includes(token));
      assert.ok(!answer.includes(recovery));
    }
    for (const stage of ['retrieval', 'template_engine_post_search_decision']) {
      assert.ok(stages.has(stage), `Stage skipped: ${turn.id}: ${stage}`);
    }
    if (failAnswer) {
      assert.equal(stages.has('template_engine_claim_validation'), false,
        'Deterministically rejected drafts must not consume semantic claim validation');
    } else {
      assert.ok(stages.has('template_engine_claim_validation'),
        `Stage skipped: ${turn.id}: template_engine_claim_validation`);
    }
    if (!stages.has('template_engine_entity_coverage')) resolvedCoverageSkips += 1;
    if (turn.id === 'welcome') assert.ok(stages.has('template_engine_welcome_meaning'));
    if (turn.noPublishedAlias) assert.ok(stages.has('template_engine_multilingual_entity_review'));
    if (turn.contextual) assert.ok(stages.has('template_engine_contextual_subject_review'), JSON.stringify([...stages]));
    assert.ok(!media.closed);
    results.push({ id: turn.id, answer, audioFrames: audioFrames.length - framesBefore });
  }
  assert.ok(resolvedCoverageSkips > 0,
    'Resolved factual replay must skip at least one duplicate entity-coverage LLM review');
  console.log(JSON.stringify({ passed: true, mode: 'offline-provider-fixtures', liveModelVerified: false,
    acousticQualityVerified: false, productionRolloutApproved: false, results }, null, 2));
} finally { media.close(); }
