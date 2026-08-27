import { env } from '../../config/env.js';

export const GROUNDED_TURN_LATENCY_VERSION = 1;

export const voiceTurnStages = Object.freeze({
  STT_FINALIZATION: 'sttFinalizationMs',
  ROUTING: 'routingMs',
  RETRIEVAL: 'retrievalMs',
  HYDRATION: 'hydrationMs',
  LLM: 'llmMs',
  TTS_FIRST_CHUNK: 'ttsFirstChunkMs',
  FIRST_AUDIO_DELIVERY: 'firstAudioDeliveryMs',
});

function clean(value) {
  return String(value ?? '').trim().slice(0, 200);
}

function rounded(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
}

function stageError(stage, code, message) {
  return Object.assign(new Error(message), { code, stage });
}

export class VoiceTurnLatencyTracker {
  constructor(identity = {}, options = {}) {
    this.identity = Object.freeze({
      tenantId: clean(identity.tenantId), agentId: clean(identity.agentId),
      callId: clean(identity.callId), turnId: clean(identity.turnId),
    });
    if (Object.values(this.identity).some((value) => !value)) {
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

  setKnownAnswer(value) { this.knownAnswer = value === true; }

  setResponseClass(value) { this.responseClass = clean(value) || 'unresolved'; }

  markLatencyAcknowledgement() { this.latencyAcknowledgement = true; }

  async measure(stage, work, { timeoutMs, cancel, metadata = {} } = {}) {
    const startedAt = this.now();
    const workPromise = Promise.resolve().then(() => work());
    const effectiveTimeoutMs = Math.max(1, Math.min(
      Number(timeoutMs ?? this.remaining()) || 1,
      this.remaining(),
    ));
    const deadline = completionDeadline(effectiveTimeoutMs, stage, cancel);
    try {
      return await Promise.race([workPromise, deadline.promise]);
    } finally {
      deadline.clear();
      this.record(stage, this.now() - startedAt, metadata);
    }
  }

  record(stage, durationMs, metadata = {}) {
    if (!Object.values(voiceTurnStages).includes(stage)) {
      throw new TypeError(`Unsupported voice latency stage: ${stage}`);
    }
    const duration = rounded(durationMs);
    this.stages[stage] = rounded((this.stages[stage] ?? 0) + duration);
    const event = Object.freeze({
      stage: 'voice.knowledge_engine_stage', ...this.identity,
      metric: stage, durationMs: duration,
      elapsedMs: rounded(this.now() - this.startedAt), ...metadata,
    });
    if (this.events.length < 50) this.events.push(event);
    this.log?.info?.(event, 'Grounded-turn voice stage completed');
    return duration;
  }

  snapshot() {
    const firstAudioMs = this.stages[voiceTurnStages.FIRST_AUDIO_DELIVERY] ?? null;
    const targetMs = this.knownAnswer ? this.knownAnswerTargetMs : this.firstAudioDeadlineMs;
    return Object.freeze({
      version: GROUNDED_TURN_LATENCY_VERSION,
      ...this.identity,
      responseClass: this.responseClass,
      knownAnswer: this.knownAnswer,
      latencyAcknowledgement: this.latencyAcknowledgement,
      targetMs,
      deadlineMs: this.firstAudioDeadlineMs,
      deadlineRemainingMs: rounded(this.remaining()),
      elapsedMs: rounded(this.now() - this.startedAt),
      firstAudioMs,
      firstAudioStatus: firstAudioMs === null ? 'pending'
        : (firstAudioMs < targetMs ? 'target_met'
          : (firstAudioMs <= this.firstAudioDeadlineMs ? 'deadline_met' : 'deadline_breached')),
      stages: Object.freeze({ ...this.stages }),
      events: Object.freeze([...this.events]),
    });
  }
}

function completionDeadline(timeoutMs, stage, cancel) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try { cancel?.(); } catch { /* best-effort provider cancellation */ }
      reject(stageError(stage, 'VOICE_TURN_STAGE_TIMEOUT', `Voice stage timed out: ${stage}`));
    }, Math.max(1, Number(timeoutMs)));
    timer.unref?.();
  });
  return Object.freeze({ promise, clear: () => clearTimeout(timer) });
}

export async function awaitLlmWithSafeLatency(work, {
  tracker,
  acknowledgementEnabled = false,
  acknowledgementAfterMs = env.VOICE_LLM_TURN_TIMEOUT_MS,
  ttsReserveMs = env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS,
  acknowledgementText = '',
  onAcknowledgement,
  completionTimeoutMs = env.LLM_REQUEST_TIMEOUT_MS,
  cancel,
} = {}) {
  if (!(tracker instanceof VoiceTurnLatencyTracker)) {
    throw new TypeError('Grounded LLM latency handling requires a voice latency tracker');
  }
  const startedAt = tracker.now();
  const workPromise = Promise.resolve().then(() => work);
  let workSettled = false;
  workPromise.then(
    () => { workSettled = true; },
    () => { workSettled = true; },
  );
  const acknowledgement = clean(acknowledgementText);
  if (acknowledgementEnabled !== true || !acknowledgement) {
    const deadline = completionDeadline(completionTimeoutMs, voiceTurnStages.LLM, cancel);
    try {
      const value = await Promise.race([workPromise, deadline.promise]);
      return Object.freeze({ value, acknowledged: false });
    } finally {
      deadline.clear();
      tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, {
        acknowledged: false, acknowledgementEligible: false,
      });
    }
  }
  const waitMs = Math.max(1, Math.min(
    Number(acknowledgementAfterMs),
    tracker.remaining(Math.max(1, Number(ttsReserveMs))),
  ));
  let timer;
  const marker = Symbol('grounded-latency-acknowledgement');
  const softDeadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(marker), waitMs);
    timer.unref?.();
  });
  let first;
  try { first = await Promise.race([workPromise, softDeadline]); } finally { clearTimeout(timer); }
  if (first !== marker) {
    tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, { acknowledged: false });
    return Object.freeze({ value: first, acknowledged: false });
  }
  // The completion and soft-deadline callbacks can become runnable in the
  // same event-loop turn. Do not play an acknowledgement once the final
  // grounded decision has already settled.
  if (workSettled) {
    const value = await workPromise;
    tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, { acknowledged: false });
    return Object.freeze({ value, acknowledged: false });
  }
  tracker.markLatencyAcknowledgement();
  await onAcknowledgement?.(acknowledgement);
  const elapsedMs = Math.max(0, tracker.now() - startedAt);
  const remainingCompletionMs = Math.max(1, Number(completionTimeoutMs) - elapsedMs);
  const deadline = completionDeadline(remainingCompletionMs, voiceTurnStages.LLM, cancel);
  try {
    const value = await Promise.race([workPromise, deadline.promise]);
    return Object.freeze({ value, acknowledged: true, acknowledgementText: acknowledgement });
  } finally {
    deadline.clear();
    tracker.record(voiceTurnStages.LLM, tracker.now() - startedAt, { acknowledged: true });
  }
}
