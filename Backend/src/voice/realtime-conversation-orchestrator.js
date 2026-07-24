import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { appendTranscriptEntry } from '../calls/call.service.js';
import { routeKnowledgeQuery } from '../knowledge-bases/knowledge-runtime.service.js';
import { ProviderIndependentAudioEngine } from './audio/audio-engine.js';
import { completeVoiceCall } from './call-completion.service.js';
import { CallController } from './call-controller.js';
import { callStates } from './call-state-machine.js';
import { ProviderUsageTracker } from './provider-usage-tracker.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';
import { createRuntimeAdapters, providerAdapterRegistry } from './providers/registry.js';
import { registerImplementedProviderAdapters } from './providers/defaults.js';
import { createSelectedLlmStream } from './providers/llm/llm-response.service.js';
import { executeAgentTools } from './tools/tool-executor.service.js';
import { LlmCircuitBreaker } from './providers/llm/streaming-runtime.js';
import { welcomeAudioCache } from './welcome-audio-cache.service.js';
import { tenantProviderHealth } from './provider-health.service.js';
import { renderWelcomeTemplate, welcomeTemplateContext } from './welcome-template.service.js';
import { resolveInterruptionConfiguration } from './interruption/interruption-config.js';
import { InterruptionCandidateManager } from './interruption/interruption-candidate-manager.js';

const closeIntent = /\b(?:bye|goodbye|hang\s*up|disconnect|end (?:the )?call|not interested|call me later|i(?:'m| am) busy)\b|(?:போதும்|அழைப்பை முடி|பிறகு அழைக்கவும்)/iu;

function languageCode(value) {
  const match = String(value ?? '').match(/\b([a-z]{2,3})(?:-[A-Z]{2})?\b/);
  if (match) return match[1].toLowerCase();
  const names = { english: 'en', tamil: 'ta', hindi: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml' };
  const lower = String(value ?? '').toLowerCase();
  return Object.entries(names).find(([name]) => lower.includes(name))?.[1] ?? 'en';
}

function fallbackClosing(profile) {
  const configured = profile.integrations?.postCall?.dynamicClosing;
  if (typeof configured === 'string' && configured.trim() && configured !== 'true') return configured.trim();
  return profile.agent.language?.toLowerCase().includes('tamil') || profile.agent.language?.toLowerCase().includes('ta')
    ? 'அழைத்ததற்கு நன்றி. வணக்கம்.' : 'Thank you for calling. Goodbye.';
}

function fallbackRecovery(profile) {
  return String(profile.agent.settings?.errorRecoveryMessage ?? '').trim()
    || (profile.agent.language?.toLowerCase().includes('tamil')
      ? 'மன்னிக்கவும், ஒரு சிறிய சிக்கல் ஏற்பட்டது. மீண்டும் சொல்ல முடியுமா?'
      : 'Sorry, I had a temporary problem. Could you please say that again?');
}

export class RealtimeConversationOrchestrator {
  constructor(mediaSession, dependencies = {}) {
    if (!mediaSession?.callId) throw new TypeError('A Plivo media session is required');
    this.mediaSession = mediaSession;
    this.call = mediaSession.call;
    this.dependencies = dependencies;
    this.log = dependencies.logger ?? mediaSession.log ?? logger;
    this.registry = dependencies.registry ?? providerAdapterRegistry;
    this.startedAt = Date.now();
    this.epoch = 0;
    this.errorCount = 0;
    this.finalized = false;
    this.closing = false;
    this.activeLlm = null;
    this.inactivityTimer = null;
    this.listeners = [];
    this.runtimeMetrics = {
      knowledge: [], tools: [], latency: {},
      interruptions: { candidates: 0, confirmed: 0, rejected: 0, confirmationMethods: {} },
    };
    this.llmCircuitBreaker = new LlmCircuitBreaker();
    this.providerHealth = dependencies.providerHealth ?? tenantProviderHealth;
    this.#attach();
    this.ready = this.#prepare();
    void this.ready.catch((error) => this.#recover(error, 'initialize')).catch((recoveryError) => {
      this.log.error({ err: recoveryError, callId: this.call.id }, 'Voice initialization recovery failed');
    });
  }

  #attach() {
    const bind = (event, handler) => {
      this.mediaSession.on(event, handler);
      this.listeners.push([event, handler]);
    };
    bind('start', () => void this.#guard('start', () => this.#onStart()));
    bind('media', ({ audio }) => void this.#guard('media', () => this.#onMedia(audio)));
    bind('dtmf', ({ digit }) => void this.#guard('dtmf', () => this.#onDtmf(digit)));
    bind('stop', () => void this.#finalize('completed', 'plivo_stream_stopped'));
    bind('failure', ({ error }) => void this.#recover(error, 'plivo_media'));
    bind('closed', ({ code, reason }) => void this.#finalize(
      code === 1000 ? 'completed' : 'failed', reason || 'media_closed',
    ));
  }

  async #prepare() {
    const loadProfile = this.dependencies.loadProfile ?? loadAgentRuntimeProfile;
    this.runtimeProfile = await loadProfile({
      agentId: this.call.agentId,
      tenantId: this.call.tenantId,
      workspaceId: this.call.workspaceId,
      callDirection: this.call.direction,
    });
    this.log = this.log.child?.({
      tenantId: this.runtimeProfile.agent.tenantId,
      workspaceId: this.runtimeProfile.agent.workspaceId,
      agentId: this.runtimeProfile.agent.id,
      callId: this.call.id,
    }) ?? this.log;
    this.preCallContext = this.call.providerMetadata?.preCall?.context ?? {};
    const renderedWelcome = renderWelcomeTemplate(
      this.runtimeProfile.agent.welcomeMessage,
      welcomeTemplateContext(this.call),
      {
        language: this.runtimeProfile.agent.language,
        fallbackMessage: this.runtimeProfile.agent.settings?.welcomeFallbackMessage,
      },
    );
    this.runtimeProfile = {
      ...this.runtimeProfile,
      agent: { ...this.runtimeProfile.agent, welcomeMessage: renderedWelcome.text },
    };
    this.personalizedWelcome = renderedWelcome.personalized;
    if (renderedWelcome.dynamic) {
      this.log.info({
        icon: '👤', stage: 'welcome.template_rendered', callId: this.call.id,
        personalized: renderedWelcome.personalized,
        resolvedVariables: renderedWelcome.resolvedVariables,
        missingVariables: renderedWelcome.missingVariables,
      }, renderedWelcome.personalized
        ? '👤 Personalized welcome message prepared'
        : '👤 Generic welcome fallback prepared');
    }
    this.welcomeCache = this.dependencies.welcomeCache ?? welcomeAudioCache;
    this.cachedWelcomePromise = this.runtimeProfile.agent.welcomeMessage && !this.personalizedWelcome
      ? this.welcomeCache.get(this.runtimeProfile, this.runtimeProfile.agent.welcomeMessage)
      : Promise.resolve(null);
    this.controller = new CallController({
      callSession: this.call,
      runtimeProfile: this.runtimeProfile,
      hooks: {
        onTranscript: async (entry) => (this.dependencies.appendTranscript ?? appendTranscriptEntry)({
          ...entry,
          offsetMs: Math.max(0, entry.at - this.startedAt),
        }),
        onInterrupt: async ({ reason }) => this.log.info({
          icon: '🛑', stage: 'conversation.barge_in', callId: this.call.id, reason,
        }, '🛑 Caller interrupted active agent output'),
        onStateChange: async ({ previous, current, reason }) => this.log.info({
          icon: '🔄', stage: 'conversation.state', callId: this.call.id, previous, current, reason,
        }, `🔄 Voice call state: ${previous} → ${current}`),
      },
    });
    this.interruptionConfiguration = resolveInterruptionConfiguration(
      this.runtimeProfile.agent.settings,
      this.runtimeProfile.agent.interruptionSensitivity,
    );
    this.interruptionCandidate = new InterruptionCandidateManager({
      configuration: this.interruptionConfiguration,
      onConfirm: (details) => void this.#guard('interruption', () => this.#confirmInterruption(details)),
      onReject: (details) => {
        this.runtimeMetrics.interruptions.rejected += 1;
        this.log.debug({
          stage: 'interruption.rejected', callId: this.call.id,
          elapsedMs: details.elapsedMs, wordCount: details.wordCount,
        }, 'Short caller audio did not meet the interruption policy');
      },
    });
    this.usageTracker = new ProviderUsageTracker(this.runtimeProfile);
    registerImplementedProviderAdapters(this.registry);
    const createAdapters = this.dependencies.createAdapters ?? createRuntimeAdapters;
    const runtimeContext = {
      callId: this.call.id,
      fetch: this.dependencies.fetchImpl,
      fetchImpl: this.dependencies.fetchImpl,
      webSocketFactory: this.dependencies.webSocketFactory,
      breaker: this.llmCircuitBreaker,
    };
    this.adapters = await createAdapters(this.runtimeProfile, runtimeContext, this.registry);
    this.audioEngine = (this.dependencies.createAudioEngine ?? ((options) => new ProviderIndependentAudioEngine(options)))({
      runtimeProfile: this.runtimeProfile,
      mediaSession: this.mediaSession,
      onError: (error) => void this.#recover(error, 'audio_output'),
    });
    this.unsubscribeStt = this.adapters.stt.onEvent((event) => (
      void this.#guard('stt_event', () => this.#handleSttEvent(event))
    ));
    try {
      await this.adapters.stt.connect();
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'stt', this.runtimeProfile.providers.stt, 'success');
    } catch (error) {
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'stt', this.runtimeProfile.providers.stt, 'failure', {
        code: error.code,
      });
      throw error;
    }
    if (this.finalized) {
      await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
      await this.audioEngine.close();
      return this;
    }
    this.log.info({
      icon: '✅', stage: 'conversation.ready', callId: this.call.id,
      agentId: this.runtimeProfile.agent.id,
      stt: this.runtimeProfile.providers.stt.modelKey,
      llm: this.runtimeProfile.providers.llm.modelKey,
      tts: this.runtimeProfile.providers.tts.modelKey,
    }, '✅ Real-time voice pipeline initialized');
    return this;
  }

  async #guard(stage, operation) {
    try { await operation(); } catch (error) {
      try { await this.#recover(error, stage); } catch (recoveryError) {
        this.log.error({ err: recoveryError, callId: this.call.id, stage }, 'Voice pipeline recovery failed');
        if (!this.mediaSession.closed) this.mediaSession.close(1011, 'voice recovery failed');
      }
    }
  }

  async #onStart() {
    await this.ready;
    if (this.finalized) return;
    this.audioEngine.start();
    this.mediaStartedAt = Date.now();
    void this.#guard('audio_input', () => this.#pumpInbound());
    const action = await this.controller.initialize();
    if (action.action === 'speak') {
      const epoch = this.epoch;
      void this.#guard('welcome', async () => {
        await this.#synthesizeWelcome(action.text, `welcome-${epoch}`);
        if (epoch === this.epoch && this.controller.state === callStates.GREETING) {
          await this.controller.greetingComplete();
          this.#armInactivity();
        }
      });
    } else this.#armInactivity();
  }

  async #onMedia(audio) {
    await this.ready;
    if (!this.finalized) await this.audioEngine.enqueueInbound(audio, { callId: this.call.id });
  }

  async #pumpInbound() {
    while (!this.finalized) {
      const frame = await this.audioEngine.readInbound();
      if (!frame) return;
      this.adapters.stt.sendAudio(frame.data);
    }
  }

  async #handleSttEvent(event) {
    if (this.finalized) return;
    if (event.type === 'usage') {
      this.usageTracker.record('stt', { audioInputMs: event.audioDurationMs, durationMs: event.processingLatencyMs ?? 0 });
      return;
    }
    if (event.type === 'error') {
      await this.#recover(Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable }), 'stt');
      return;
    }
    if (event.type === 'speech_started') {
      this.#clearInactivity();
      if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
        if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
        this.interruptionCandidate.start();
      }
      return;
    }
    if (event.type === 'partial_transcript') {
      if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)
        || this.interruptionCandidate.active) {
        if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
        this.interruptionCandidate.observeTranscript(event.text);
      }
      return;
    }
    if (event.type === 'speech_ended') {
      try { this.adapters.stt.flush(); } catch (error) { this.log.debug({ err: error, callId: this.call.id }, 'STT flush was not required'); }
      if (this.interruptionCandidate.active && !this.interruptionCandidate.confirmed) {
        this.interruptionCandidate.finish('speech_ended_below_threshold');
      }
      return;
    }
    if (event.type !== 'final_transcript') return;
    this.#clearInactivity();
    const outputWasActive = [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state);
    if (outputWasActive || this.interruptionCandidate.active) {
      if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
      const decision = this.interruptionCandidate.observeTranscript(event.text);
      if (decision.confirmed) await this.#cancelActive('caller_barge_in');
      else if (outputWasActive) {
        this.interruptionCandidate.finish('final_transcript_below_threshold');
        return;
      }
    }
    this.interruptionCandidate.reset();
    if (this.controller.state !== callStates.LISTENING || !event.text.trim()) return;
    const action = await this.controller.receiveFinalTranscript(event.text);
    if (closeIntent.test(event.text)) {
      await this.#close('caller_requested_hangup');
      return;
    }
    const epoch = ++this.epoch;
    void this.#guard('turn', () => this.#runTurn(event.text, action.history, epoch));
  }

  async #confirmInterruption(details) {
    if (this.finalized || ![callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) return;
    this.runtimeMetrics.interruptions.confirmed += 1;
    const method = details.confirmedBy ?? 'unknown';
    this.runtimeMetrics.interruptions.confirmationMethods[method] =
      (this.runtimeMetrics.interruptions.confirmationMethods[method] ?? 0) + 1;
    this.log.info({
      stage: 'interruption.confirmed', callId: this.call.id, method,
      elapsedMs: details.elapsedMs, wordCount: details.wordCount,
      matchedTrigger: details.matchedTrigger ?? undefined,
      policy: this.interruptionConfiguration.policy,
    }, 'Caller interruption confirmed');
    await this.#cancelActive('caller_barge_in');
  }

  async #knowledge(query) {
    try {
      const routeKnowledge = this.dependencies.routeKnowledge ?? routeKnowledgeQuery;
      const result = await routeKnowledge({
        tenantId: this.runtimeProfile.agent.tenantId,
        workspaceId: this.runtimeProfile.agent.workspaceId,
        userId: null,
        role: 'COMPANY_DEVELOPER',
      }, {
        agentId: this.runtimeProfile.agent.id,
        query,
        usageDirection: this.call.direction,
        language: languageCode(this.runtimeProfile.agent.language),
        routeHint: 'auto',
      });
      this.runtimeMetrics.knowledge.push({
        route: result.route, found: result.found === true, durationMs: Number(result.durationMs ?? 0),
      });
      return result;
    } catch (error) {
      this.log.warn({ err: error, callId: this.call.id }, 'Knowledge retrieval failed; continuing without unverified context');
      return { route: 'none', found: false, content: null, source: null, error: error.code ?? 'KNOWLEDGE_UNAVAILABLE' };
    }
  }

  async #llmAttempt(query, history, knowledge, context = {}) {
    const session = await createSelectedLlmStream(this.runtimeProfile, {
      callId: this.call.id,
      query,
      history,
      knowledge,
      context: {
        callId: this.call.id,
        direction: this.call.direction,
        preCall: this.preCallContext,
        ...context,
      },
      usageDirection: this.call.direction,
    }, { registry: this.registry, adapter: this.adapters.llm, skipDefaultRegistration: true });
    this.activeLlm = session;
    let text = '';
    let toolCalls = [];
    try {
      for await (const event of session.events) {
        if (event.type === 'text_delta') text += event.delta;
        else if (event.type === 'tool_call') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        else if (event.type === 'usage') this.usageTracker.record('llm', event.usage);
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
        else if (event.type === 'cancelled') return { cancelled: true, text: '', toolCalls: [] };
        else if (event.type === 'completed') {
          toolCalls = event.toolCalls?.length ? event.toolCalls : toolCalls;
          if (event.durationMs) this.usageTracker.record('llm', { requests: 0, durationMs: event.durationMs });
          this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'success', {
            latencyMs: event.durationMs,
          });
        }
      }
      return { cancelled: false, text: text.trim(), toolCalls };
    } finally {
      if (this.activeLlm === session) this.activeLlm = null;
      await session.close();
    }
  }

  async #llm(query, history, knowledge, context = {}) {
    let lastError;
    for (let attempt = 0; attempt <= env.VOICE_PROVIDER_MAX_RETRIES; attempt += 1) {
      try {
        return await this.#llmAttempt(query, history, knowledge, context);
      } catch (error) {
        lastError = error;
        if (error?.retryable !== true || attempt >= env.VOICE_PROVIDER_MAX_RETRIES) throw error;
        const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
        this.log.warn({
          stage: 'llm.retry', attempt: attempt + 1, delayMs,
          providerId: this.runtimeProfile.providers.llm.providerId,
          modelId: this.runtimeProfile.providers.llm.modelId,
        }, 'Retrying selected LLM after transient failure');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async #runTurn(query, history, epoch) {
    const turnStartedAt = Date.now();
    const knowledge = await this.#knowledge(query);
    if (epoch !== this.epoch || this.finalized) return;
    let response;
    try {
      response = await this.#llm(query, history, knowledge);
    } catch (error) {
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'failure', {
        code: error.code,
      });
      if (!knowledge.found || !String(knowledge.content ?? '').trim()) throw error;
      this.log.warn({
        stage: 'llm.verified_knowledge_fallback', code: error.code,
        providerId: this.runtimeProfile.providers.llm.providerId,
      }, 'Selected LLM failed; using verified knowledge response for this call');
      response = { cancelled: false, text: String(knowledge.content).trim(), toolCalls: [] };
    }
    if (response.cancelled || epoch !== this.epoch) return;
    if (response.toolCalls.length) {
      const toolResults = await (this.dependencies.executeTools ?? executeAgentTools)(
        this.runtimeProfile, this.call, response.toolCalls, { fetchImpl: this.dependencies.fetchImpl },
      );
      this.runtimeMetrics.tools.push(...toolResults.map((result) => ({
        name: result.name, success: result.success, durationMs: Number(result.durationMs ?? 0),
      })));
      if (epoch !== this.epoch) return;
      response = await this.#llm(query, history, knowledge, {
        toolResults,
        instruction: 'Use these tool results to answer the caller. Never claim an unsuccessful tool completed.',
      });
    }
    if (response.cancelled || epoch !== this.epoch || this.finalized) return;
    const answer = response.text || String(this.runtimeProfile.agent.settings?.noResponseMessage ?? 'Sorry, I could not form a response.');
    await this.controller.setAssistantResponse(answer);
    await this.#synthesize(answer, `turn-${epoch}`, { kind: 'response', startedAt: turnStartedAt });
    if (epoch !== this.epoch || this.finalized || this.controller.state !== callStates.SPEAKING) return;
    await this.controller.playbackComplete();
    this.errorCount = 0;
    this.#armInactivity();
  }

  async #synthesizeWelcome(text, generationId) {
    const cached = await this.cachedWelcomePromise;
    if (cached?.length) {
      this.audioEngine.beginOutputGeneration(generationId);
      this.runtimeMetrics.latency.welcomeCacheHit = true;
      this.runtimeMetrics.latency.welcomeAudioStartMs = Math.max(0, Date.now() - this.mediaStartedAt);
      await this.audioEngine.enqueueSynthesized(cached, generationId);
      await this.audioEngine.flushSynthesized(generationId);
      await this.audioEngine.drainOutput();
      return true;
    }
    const chunks = [];
    const result = await this.#synthesize(text, generationId, {
      kind: 'welcome', startedAt: this.mediaStartedAt, capture: chunks,
    });
    this.runtimeMetrics.latency.welcomeCacheHit = false;
    if (result && chunks.length && !this.personalizedWelcome) {
      void this.welcomeCache.set(this.runtimeProfile, text, Buffer.concat(chunks));
    }
    return result;
  }

  async #synthesizeAttempt(text, generationId, options = {}) {
    this.audioEngine.beginOutputGeneration(generationId);
    let completed = false;
    let firstAudio = true;
    try {
      for await (const event of this.adapters.tts.synthesizeStream({ text, generationId })) {
        if (event.type === 'audio_chunk') {
          if (firstAudio) {
            firstAudio = false;
            const latencyMs = Math.max(0, Date.now() - (options.startedAt ?? Date.now()));
            if (options.kind === 'welcome') this.runtimeMetrics.latency.welcomeAudioStartMs = latencyMs;
            if (options.kind === 'response') {
              this.runtimeMetrics.latency.firstResponseAudioMs ??= [];
              this.runtimeMetrics.latency.firstResponseAudioMs.push(latencyMs);
            }
          }
          if (options.capture) options.capture.push(Buffer.from(event.audio));
          if (!await this.audioEngine.enqueueSynthesized(event.audio, generationId)) return false;
        } else if (event.type === 'usage') this.usageTracker.record('tts', event.usage);
        else if (event.type === 'completed') {
          completed = true;
          this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'tts', this.runtimeProfile.providers.tts, 'success', {
            latencyMs: event.firstAudioLatencyMs,
          });
        }
        else if (event.type === 'cancelled') return false;
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
      }
    } catch (error) {
      error.audioStarted = !firstAudio;
      throw error;
    }
    if (!completed) throw new AppError(502, 'TTS stream ended without completion', 'TTS_STREAM_INCOMPLETE');
    await this.audioEngine.flushSynthesized(generationId);
    await this.audioEngine.drainOutput();
    return true;
  }

  async #synthesize(text, generationId, options = {}) {
    let lastError;
    for (let attempt = 0; attempt <= env.VOICE_PROVIDER_MAX_RETRIES; attempt += 1) {
      try {
        return await this.#synthesizeAttempt(text, generationId, options);
      } catch (error) {
        lastError = error;
        const canRetry = error?.retryable === true && error.audioStarted !== true
          && attempt < env.VOICE_PROVIDER_MAX_RETRIES;
        if (!canRetry) throw error;
        if (options.capture) options.capture.length = 0;
        const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
        this.log.warn({
          stage: 'tts.retry', attempt: attempt + 1, delayMs,
          providerId: this.runtimeProfile.providers.tts.providerId,
          modelId: this.runtimeProfile.providers.tts.modelId,
        }, 'Retrying selected TTS before audio playback started');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async #onDtmf(digit) {
    await this.ready;
    if (digit === '#') await this.#close('caller_pressed_hash');
  }

  async #cancelActive(reason = 'cancelled', transition = true) {
    this.epoch += 1;
    this.activeLlm?.cancel(reason);
    this.adapters?.llm?.cancel?.(reason);
    this.adapters?.tts?.cancel?.(reason);
    this.audioEngine?.cancelStaleAudio?.(reason);
    if (transition && this.controller && [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
      await this.controller.interrupt(reason);
    }
  }

  #clearInactivity() {
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  #armInactivity() {
    this.#clearInactivity();
    if (this.finalized || this.controller.state !== callStates.LISTENING) return;
    const seconds = Number(this.runtimeProfile.agent.inactivityTimeoutSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.inactivityTimer = setTimeout(() => void this.#guard('inactivity', () => this.#handleInactivity()), seconds * 1000);
    this.inactivityTimer.unref?.();
  }

  async #handleInactivity() {
    if (this.finalized || this.controller.state !== callStates.LISTENING) return;
    const action = await this.controller.handleSilence();
    if (action.action === 'close') return this.#close(action.reason);
    if (action.action !== 'inactivity_response') return;
    await this.controller.setAssistantResponse(action.text);
    const epoch = ++this.epoch;
    await this.#synthesize(action.text, `silence-${epoch}`);
    if (epoch === this.epoch && this.controller.state === callStates.SPEAKING) {
      await this.controller.playbackComplete();
      this.#armInactivity();
    }
  }

  async #closingMessage(reason) {
    const prompt = String(this.runtimeProfile.integrations?.postCall?.prompt ?? '').trim();
    const dynamic = String(this.runtimeProfile.integrations?.postCall?.messageType ?? '').toLowerCase() === 'dynamic'
      || this.runtimeProfile.integrations?.postCall?.dynamicClosing === true;
    if (!dynamic && !prompt) return fallbackClosing(this.runtimeProfile);
    try {
      const response = await this.#llm(
        `End the call now. Reason: ${reason}. Generate one brief natural closing sentence.${prompt ? ` Closing instruction: ${prompt}` : ''}`,
        this.controller.history,
        { route: 'none', found: false },
        { closingReason: reason },
      );
      return response.text || fallbackClosing(this.runtimeProfile);
    } catch { return fallbackClosing(this.runtimeProfile); }
  }

  async #close(reason) {
    if (this.closing || this.finalized) return;
    this.closing = true;
    this.#clearInactivity();
    await this.#cancelActive(reason);
    await this.controller.requestClose(reason);
    const message = await this.#closingMessage(reason);
    if (message && !this.mediaSession.closed) {
      await this.controller.recordAssistantMessage(message);
      try { await this.#synthesize(message, `closing-${this.epoch}`); } catch (error) {
        this.log.warn({ err: error, callId: this.call.id }, 'Dynamic closing audio failed');
      }
    }
    await this.#finalize('completed', reason);
    if (!this.mediaSession.closed) this.mediaSession.close(1000, reason);
  }

  async #recover(error, stage) {
    if (this.finalized) return;
    this.errorCount += 1;
    const kind = stage === 'stt' ? 'stt' : (stage.startsWith('tts') || stage === 'audio_output' ? 'tts' : (stage.startsWith('llm') || stage === 'turn' ? 'llm' : null));
    if (kind) this.providerHealth.record(
      this.runtimeProfile?.agent?.tenantId,
      kind,
      this.runtimeProfile?.providers?.[kind] ?? {},
      'failure',
      { code: error?.code },
    );
    this.log.error({ err: error, icon: '⚠️', stage, callId: this.call.id, recoverableAttempt: this.errorCount }, '⚠️ Voice pipeline error');
    if (!this.controller || this.errorCount > env.VOICE_RUNTIME_MAX_RECOVERABLE_ERRORS || error?.retryable === false) {
      await this.#finalize('failed', error?.code ?? `${stage}_failed`);
      if (!this.mediaSession.closed) this.mediaSession.close(1011, 'voice runtime failed');
      return;
    }
    await this.#cancelActive(`${stage}_recovery`);
    if (stage === 'stt' && error?.retryable) {
      try { await this.adapters.stt.connect(); } catch { return this.#finalize('failed', 'stt_reconnect_failed'); }
    }
    const ttsFailed = stage === 'audio_output' || stage.startsWith('tts') || String(error?.code ?? '').startsWith('TTS_');
    if (!ttsFailed && this.controller.state === callStates.LISTENING) {
      try {
        const message = fallbackRecovery(this.runtimeProfile);
        await this.controller.beginSystemResponse('error_recovery');
        await this.controller.setAssistantResponse(message);
        await this.#synthesize(message, `recovery-${this.epoch}`);
        if (this.controller.state === callStates.SPEAKING) await this.controller.playbackComplete();
      } catch (recoveryError) {
        this.log.error({ err: recoveryError, callId: this.call.id }, 'Voice error recovery message failed');
      }
    }
    this.#armInactivity();
  }

  async #finalize(outcome, reason) {
    if (this.finalized) return;
    this.finalized = true;
    this.#clearInactivity();
    this.interruptionCandidate?.reset();
    this.epoch += 1;
    this.activeLlm?.cancel(reason);
    this.adapters?.tts?.cancel?.(reason);
    this.unsubscribeStt?.();
    await this.audioEngine?.close?.();
    if (!this.controller || !this.runtimeProfile || !this.usageTracker) return;
    try {
      await (this.dependencies.completeCall ?? completeVoiceCall)({
        controller: this.controller,
        runtimeProfile: this.runtimeProfile,
        usageTracker: this.usageTracker,
        adapters: this.adapters ?? {},
        outcome,
        reason,
        metrics: this.runtimeMetrics,
      }, this.dependencies.completionDependencies ?? {});
    } catch (error) {
      this.log.error({ err: error, callId: this.call.id }, 'Voice call finalization failed');
    }
  }
}

export function attachRealtimeConversationOrchestrator(mediaSession, dependencies = {}) {
  return new RealtimeConversationOrchestrator(mediaSession, dependencies);
}
