import { env } from '../config/env.js';
import { knowledgeQueryClasses } from './query-classifier.js';
import { prepareKnowledgeQuery, refineKnowledgeResolution } from './fast-query-preparation.js';
import { retrieveTargetedCandidates } from './targeted-retrieval.js';
import { rankAndHydrateAuthoritativeEvidence } from './authoritative-evidence.js';
import { planSafeKnowledgeResponse } from './safe-response-tool-runtime.js';
import { buildCompactEvidenceBundle } from './compact-evidence-bundle.js';

export const VOICE_TURN_LATENCY_VERSION = 1;

export const voiceTurnStages = Object.freeze({
  STT_FINALIZATION: 'sttFinalizationMs',
  ROUTING: 'routingMs',
  RETRIEVAL: 'retrievalMs',
  HYDRATION: 'hydrationMs',
  LLM: 'llmMs',
  TTS_FIRST_CHUNK: 'ttsFirstChunkMs',
  FIRST_AUDIO_DELIVERY: 'firstAudioDeliveryMs',
});

const knownIntentClasses = new Set([
  knowledgeQueryClasses.KNOWN_INFORMATION,
  knowledgeQueryClasses.DETAILS_OR_PRICE,
  knowledgeQueryClasses.CATEGORY_OVERVIEW,
  knowledgeQueryClasses.CLARIFICATION_ANSWER,
  knowledgeQueryClasses.ACKNOWLEDGEMENT,
  knowledgeQueryClasses.CALL_CONTROL,
  knowledgeQueryClasses.SAFETY_EMERGENCY,
]);

function cleanId(value) {
  return String(value ?? '').trim().slice(0, 200);
}

function rounded(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
}

function deadlineError(stage) {
  return Object.assign(new Error(`Voice turn deadline exceeded during ${stage}`), {
    code: 'VOICE_TURN_FIRST_AUDIO_DEADLINE', stage,
  });
}

function timeoutError(stage) {
  return Object.assign(new Error(`Voice stage timed out: ${stage}`), {
    code: 'VOICE_TURN_STAGE_TIMEOUT', stage,
  });
}

export class VoiceTurnLatencyTracker {
  constructor(identity = {}, options = {}) {
    this.identity = Object.freeze({
      tenantId: cleanId(identity.tenantId),
      agentId: cleanId(identity.agentId),
      callId: cleanId(identity.callId),
      turnId: cleanId(identity.turnId),
    });
    if (!this.identity.tenantId || !this.identity.agentId
      || !this.identity.callId || !this.identity.turnId) {
      throw new TypeError('Voice latency tracker requires tenant, agent, call and turn identifiers');
    }
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? null;
    this.startedAt = Number(options.startedAt ?? this.now());
    this.knownAnswerTargetMs = Math.min(1_000,
      Math.max(100, Number(options.knownAnswerTargetMs ?? env.VOICE_FIRST_AUDIO_TARGET_MS)));
    this.firstAudioDeadlineMs = Math.min(2_000,
      Math.max(1_000, Number(options.firstAudioDeadlineMs
        ?? env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS)));
    this.deadlineAt = this.startedAt + this.firstAudioDeadlineMs;
    this.knownAnswer = false;
    this.responseClass = 'unresolved';
    this.latencyAcknowledgement = false;
    this.stages = {};
    this.events = [];
  }

  remaining(reserveMs = 0) {
    return Math.max(0, this.deadlineAt - this.now() - Math.max(0, Number(reserveMs) || 0));
  }

  setKnownAnswer(value) {
    this.knownAnswer = value === true;
  }

  setResponseClass(value) {
    this.responseClass = cleanId(value) || 'unresolved';
  }

  record(stage, durationMs, metadata = {}) {
    if (!Object.values(voiceTurnStages).includes(stage)) {
      throw new TypeError(`Unsupported voice latency stage: ${stage}`);
    }
    const duration = rounded(durationMs);
    this.stages[stage] = rounded((this.stages[stage] ?? 0) + duration);
    const event = Object.freeze({
      stage: 'voice.knowledge_engine_stage',
      ...this.identity,
      metric: stage,
      durationMs: duration,
      elapsedMs: rounded(this.now() - this.startedAt),
      ...metadata,
    });
    if (this.events.length < 50) this.events.push(event);
    this.log?.info?.(event, 'Knowledge-engine voice stage completed');
    return duration;
  }

  async measure(stage, operation, options = {}) {
    const startedAt = this.now();
    const stageLimit = Math.max(1, Number(options.timeoutMs ?? this.remaining(options.reserveMs)));
    const timeoutMs = Math.min(stageLimit, this.remaining(options.reserveMs));
    if (timeoutMs <= 0) throw deadlineError(stage);
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try { options.cancel?.(); } catch { /* best-effort cancellation */ }
        reject(this.remaining() <= 0 ? deadlineError(stage) : timeoutError(stage));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
      clearTimeout(timer);
      this.record(stage, this.now() - startedAt);
    }
  }

  markLatencyAcknowledgement() {
    this.latencyAcknowledgement = true;
  }

  snapshot() {
    const elapsedMs = rounded(this.now() - this.startedAt);
    const firstAudioMs = this.stages[voiceTurnStages.FIRST_AUDIO_DELIVERY] ?? null;
    const targetMs = this.knownAnswer ? this.knownAnswerTargetMs : this.firstAudioDeadlineMs;
    return Object.freeze({
      version: VOICE_TURN_LATENCY_VERSION,
      ...this.identity,
      responseClass: this.responseClass,
      knownAnswer: this.knownAnswer,
      latencyAcknowledgement: this.latencyAcknowledgement,
      targetMs,
      deadlineMs: this.firstAudioDeadlineMs,
      deadlineRemainingMs: rounded(this.remaining()),
      elapsedMs,
      firstAudioMs,
      firstAudioStatus: firstAudioMs === null ? 'pending'
        : (firstAudioMs < targetMs ? 'target_met'
          : (firstAudioMs <= this.firstAudioDeadlineMs ? 'deadline_met' : 'deadline_breached')),
      stages: Object.freeze({ ...this.stages }),
      events: Object.freeze([...this.events]),
    });
  }
}

export function safeLatencyAcknowledgement(configuredMessage) {
  const configured = String(configuredMessage ?? '').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
  return configured || 'One moment while I check the published information.';
}

export async function awaitLlmWithSafeLatency(work, {
  tracker,
  acknowledgementEnabled = true,
  acknowledgementAfterMs = env.VOICE_LLM_TURN_TIMEOUT_MS,
  ttsReserveMs = env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS,
  acknowledgementText,
  onAcknowledgement,
  completionTimeoutMs = env.LLM_REQUEST_TIMEOUT_MS,
  postAcknowledgementTimeoutMs = env.VOICE_LLM_TURN_TIMEOUT_MS,
  cancel,
} = {}) {
  if (!(tracker instanceof VoiceTurnLatencyTracker)) {
    throw new TypeError('Safe LLM latency handling requires a voice latency tracker');
  }
  const startedAt = tracker.now();
  const promise = Promise.resolve().then(() => work);
  if (acknowledgementEnabled !== true) {
    let completionTimer;
    const completionDeadline = new Promise((_resolve, reject) => {
      completionTimer = setTimeout(() => {
        try { cancel?.(); } catch { /* best-effort cancellation */ }
        reject(timeoutError(voiceTurnStages.LLM));
      }, Math.max(1, Number(completionTimeoutMs)));
      completionTimer.unref?.();
    });
    try {
      const value = await Promise.race([promise, completionDeadline]);
      return Object.freeze({ value, acknowledged: false });
    } finally {
      clearTimeout(completionTimer);
      tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, {
        acknowledged: false, acknowledgementEligible: false,
      });
    }
  }
  const softWaitMs = Math.max(1, Math.min(
    Number(acknowledgementAfterMs),
    tracker.remaining(Math.max(1, Number(ttsReserveMs))),
  ));
  let softTimer;
  const softDeadline = new Promise((resolve) => {
    softTimer = setTimeout(() => resolve(Symbol.for('voice-latency-ack')), softWaitMs);
    softTimer.unref?.();
  });
  let first;
  try { first = await Promise.race([promise, softDeadline]); } finally { clearTimeout(softTimer); }
  if (first !== Symbol.for('voice-latency-ack')) {
    tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, { acknowledged: false });
    return Object.freeze({ value: first, acknowledged: false });
  }
  const text = safeLatencyAcknowledgement(acknowledgementText);
  tracker.markLatencyAcknowledgement();
  await onAcknowledgement?.(text);
  let completionTimer;
  const postAcknowledgementWaitMs = Math.max(1, Math.min(
    Number(completionTimeoutMs),
    Number(postAcknowledgementTimeoutMs),
  ));
  const completionDeadline = new Promise((_resolve, reject) => {
    completionTimer = setTimeout(() => {
      try { cancel?.(); } catch { /* best-effort cancellation */ }
      reject(timeoutError(voiceTurnStages.LLM));
    }, postAcknowledgementWaitMs);
    completionTimer.unref?.();
  });
  try {
    const value = await Promise.race([promise, completionDeadline]);
    return Object.freeze({ value, acknowledged: true, acknowledgementText: text });
  } finally {
    clearTimeout(completionTimer);
    tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, { acknowledged: true });
  }
}

export async function runObservedKnowledgeTurn({
  auth, input, publicationBundles, sparseIndexes = [], runtimeProfile,
  semanticMatches = [], confirmation = false, tracker,
} = {}, dependencies = {}) {
  const latency = tracker ?? new VoiceTurnLatencyTracker({
    tenantId: input?.tenantId, agentId: input?.agentId,
    callId: input?.callId, turnId: input?.callId,
  });
  const prepare = dependencies.prepare ?? prepareKnowledgeQuery;
  const retrieve = dependencies.retrieve ?? retrieveTargetedCandidates;
  const refineResolution = dependencies.refineResolution ?? refineKnowledgeResolution;
  const hydrate = dependencies.hydrate ?? rankAndHydrateAuthoritativeEvidence;
  const plan = dependencies.plan ?? planSafeKnowledgeResponse;
  let resolution;
  let classification;
  let turnInput = input;
  await latency.measure(voiceTurnStages.ROUTING, async () => {
    const prepared = await prepare(input, publicationBundles, { semanticMatches }, {
      resolve: dependencies.resolve,
      classify: dependencies.classify,
    });
    turnInput = prepared.input ?? input;
    resolution = prepared.resolution;
    classification = prepared.classification;
  }, { timeoutMs: env.VOICE_ROUTING_TURN_TIMEOUT_MS, reserveMs: env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS });
  latency.setKnownAnswer(knownIntentClasses.has(classification.intentClass)
    && classification.requiresConfirmation !== true);
  const retrieval = await latency.measure(voiceTurnStages.RETRIEVAL, () => retrieve({
    input: turnInput, classification, resolution, publicationBundles, sparseIndexes,
  }, dependencies.retrievalDependencies), {
    timeoutMs: env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS,
    reserveMs: env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS,
    cancel: dependencies.cancelRetrieval,
  });
  resolution = await refineResolution(
    turnInput, publicationBundles, resolution, classification, retrieval.channels?.qdrant ?? [],
    { resolve: dependencies.resolve },
  );
  const authoritative = await latency.measure(voiceTurnStages.HYDRATION, () => hydrate({
    auth, input: turnInput, classification, resolution, retrieval,
  }, dependencies.hydrationDependencies), {
    timeoutMs: env.VOICE_HYDRATION_TURN_TIMEOUT_MS,
    reserveMs: env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS,
    cancel: dependencies.cancelHydration,
  });
  const decision = plan({
    input: turnInput, classification, resolution, authoritative, runtimeProfile, confirmation,
  });
  const llmEvidenceBundle = buildCompactEvidenceBundle({
    input: turnInput, classification, resolution, authoritative, runtimeProfile, decision,
  });
  latency.setResponseClass(decision.type);
  return Object.freeze({
    input: turnInput, resolution, classification, retrieval, authoritative, decision, llmEvidenceBundle,
    latency: latency.snapshot(), tracker: latency,
  });
}
