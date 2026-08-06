import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { appendTranscriptEntry } from '../calls/call.service.js';
import { routeKnowledgeQuery } from '../knowledge-bases/knowledge-runtime.service.js';
import { ProviderIndependentAudioEngine } from './audio/audio-engine.js';
import { completeVoiceCall, completeVoiceCallWithoutRuntime } from './call-completion.service.js';
import { CallController } from './call-controller.js';
import { TranscriptPersistenceQueue } from './transcript-persistence-queue.js';
import { TtsCharacterBudget } from './tts-character-budget.js';
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
import { CustomerUtteranceBuffer } from './interruption/customer-utterance-buffer.js';
import { validateFinalCustomerTurn } from './interruption/final-turn-validator.js';
import { greetingModes, resolveInteractionConfiguration } from './interaction/interaction-config.js';
import { resolveCallContextId } from './interaction/context-id-resolver.js';
import { createContextCachePolicy, publicContextCacheMetadata } from './interaction/context-cache-policy.js';
import { conversationContextCache } from './interaction/conversation-context-cache.service.js';
import {
  conversationMemoryRepository,
  conversationMemoryScope,
} from './interaction/conversation-memory.service.js';
import { buildConversationMemoryState } from './interaction/conversation-memory-state.js';
import { resolveCallbackConfiguration } from './interaction/callback-config.js';
import {
  captureTaskCompletionInput,
  createTaskCompletionState,
  publicTaskCompletionState,
  renderTaskCompletionConfirmation,
} from './interaction/task-completion-state.js';
import {
  resolveCustomerCallbackRequest,
  scheduleCustomerCallback,
} from '../campaigns/customer-callback.service.js';
import { createPronunciationTextProcessor } from './pronunciation/pronunciation-text-processor.js';
import { createTtsTextPreprocessor } from './tts-text-preprocessor.js';
import { createStreamingSentenceBuffer } from './streaming-sentence-buffer.js';
import { createTtsSpeedMonitor } from './tts-speed-monitor.js';
import { loadRuntimeAmbience } from './ambience-runtime.service.js';
import { resolvePostCallClosingConfiguration } from './integrations/postcall-closing-config.js';
import { findCallEndTriggerPhrase } from './integrations/postcall-end-trigger-config.js';
import {
  createMessageSource,
  knowledgeMessageSources,
  llmMessageSource,
  MessageSourceTrace,
  mergeMessageSources,
  messageSourceTypes,
  toolMessageSources,
} from './source-trace.js';

function languageCode(value) {
  const match = String(value ?? '').match(/\b([a-z]{2,3})(?:-[A-Z]{2})?\b/);
  if (match) return match[1].toLowerCase();
  const names = { english: 'en', tamil: 'ta', hindi: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml' };
  const lower = String(value ?? '').toLowerCase();
  return Object.entries(names).find(([name]) => lower.includes(name))?.[1] ?? 'en';
}

function fallbackClosing(profile) {
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
    this.activeLookaheadTtsAdapters = new Set();
    this.activeLookaheadSchedulers = new Set();
    this.interruptionConfirmationPromise = null;
    this.customerUtterance = new CustomerUtteranceBuffer();
    this.recentFinalTurns = new Map();
    this.cancelledEpochs = new Set();
    this.activeCancellationPromise = null;
    this.inactivityTimer = null;
    this.callDurationTimer = null;
    this.listeners = [];
    this.runtimeMetrics = {
      knowledge: [], tools: [], latency: {},
      interruptions: {
        candidates: 0, confirmed: 0, rejected: 0, confirmationMethods: {},
        cancellationEpochs: 0, clearedAudioFrames: 0, cancellationCalls: 0,
        lateGenerationEventsRejected: 0, transcriptFragments: 0, finalTurns: 0,
        samples: [],
      },
    };
    this.followUpOpeningSources = [];
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
    const ttsMaximumCharacters = Number(
      this.runtimeProfile.limits?.ttsMaxCharactersPerMinute
      ?? this.runtimeProfile.agent.settings?.ttsMaxCharactersPerMinute
      ?? 0,
    );
    const ttsMaximumResponseCharacters = Number(
      this.runtimeProfile.limits?.ttsMaxCharactersPerResponse
      ?? this.runtimeProfile.agent.settings?.ttsMaxCharactersPerResponse
      ?? 0,
    );
    const maximumCallMinutes = Number(
      this.runtimeProfile.limits?.maxCallDurationMinutes
      ?? this.runtimeProfile.agent.settings?.maxCallDurationMinutes
      ?? 0,
    );
    this.runtimeProfile = {
      ...this.runtimeProfile,
      limits: {
        ...this.runtimeProfile.limits,
        ttsMaxCharactersPerResponse: ttsMaximumResponseCharacters,
        ttsMaxCharactersPerMinute: ttsMaximumCharacters,
        maxCallDurationMinutes: maximumCallMinutes,
      },
    };
    this.ttsCharacterBudget = new TtsCharacterBudget(ttsMaximumCharacters);
    this.runtimeMetrics.ttsLimits = {
      maximumCharactersPerResponse: ttsMaximumResponseCharacters,
      maximumCharactersPerMinute: ttsMaximumCharacters,
      maximumCallDurationMinutes: maximumCallMinutes,
      charactersSynthesized: 0,
      throttleWaitMs: 0,
      durationLimitReached: false,
    };
    this.ttsSpeedMonitor = (this.dependencies.createTtsSpeedMonitor
      ?? createTtsSpeedMonitor)({
      enabled: env.TTS_SPEED_MONITOR_ENABLED,
      minimumCharactersPerSecond: env.TTS_SPEED_MIN_CHARACTERS_PER_SECOND,
      maximumCharactersPerSecond: env.TTS_SPEED_MAX_CHARACTERS_PER_SECOND,
      minimumSampleCharacters: env.TTS_SPEED_MIN_SAMPLE_CHARACTERS,
      minimumAudioMs: env.TTS_SPEED_MIN_AUDIO_MS,
    });
    this.runtimeMetrics.ttsSpeed = {
      enabled: this.ttsSpeedMonitor.enabled,
      expectedCharactersPerSecond: {
        minimum: this.ttsSpeedMonitor.minimumCharactersPerSecond,
        maximum: this.ttsSpeedMonitor.maximumCharactersPerSecond,
      },
      measured: 0, normal: 0, abnormal: 0, tooFast: 0, tooSlow: 0,
      retries: 0, retriesSuppressedAfterAudio: 0, samples: [],
    };
    this.runtimeMetrics.audioContinuity = {
      underruns: 0, totalUnderrunMs: 0, maximumGapMs: 0,
      playbackDeadlineMisses: 0, totalSchedulingDelayMs: 0, maximumSchedulingDelayMs: 0,
      websocketDeliveries: 0, totalWebsocketDeliveryMs: 0, maximumWebsocketDeliveryMs: 0,
      slowWebsocketDeliveries: 0, websocketBackpressureEvents: 0,
      maximumWebsocketBufferedBytes: 0,
      sentenceBoundaries: 0, smoothedBoundaries: 0,
      lastBufferedAudioMs: 0, minimumBufferedAudioMs: null,
      samples: [],
    };
    this.runtimeMetrics.sentenceGrouping = {
      enabled: env.VOICE_TTS_SENTENCE_GROUPING_ENABLED,
      maximumWaitMs: env.VOICE_TTS_GROUP_WAIT_MS,
      groupsQueued: 0, sentencesGrouped: 0, multiSentenceGroups: 0,
    };
    this.runtimeMetrics.ttsLookahead = {
      enabled: env.VOICE_TTS_LOOKAHEAD_ENABLED,
      concurrency: env.VOICE_TTS_LOOKAHEAD_CONCURRENCY,
      scheduled: 0, started: 0, completed: 0, cancelled: 0, failed: 0,
      readyBeforePlayback: 0, waitedAtPlayback: 0,
      sequentialFallbacks: 0, isolatedFailures: 0, successfulHandoffs: 0,
      partialTurnsPreserved: 0,
      bufferedBytes: 0, maximumSegmentBytes: 0,
    };
    this.runtimeMetrics.ttsGeneration = {
      requests: 0, completed: 0, failed: 0, cancelled: 0,
      firstAudioSamples: 0, totalFirstAudioLatencyMs: 0, maximumFirstAudioLatencyMs: 0,
      totalGenerationMs: 0, maximumGenerationMs: 0,
      sentenceHandoffWaits: 0, totalSentenceHandoffWaitMs: 0,
      maximumSentenceHandoffWaitMs: 0,
      samples: [],
    };
    this.runtimeMetrics.providerFailures = {
      total: 0, stt: 0, llm: 0, tts: 0, audioTransport: 0, samples: [],
    };
    this.recordedProviderFailures = new WeakSet();
    this.pronunciationProcessor = (this.dependencies.createPronunciationProcessor
      ?? createPronunciationTextProcessor)(this.runtimeProfile.pronunciation);
    this.log = this.log.child?.({
      tenantId: this.runtimeProfile.agent.tenantId,
      workspaceId: this.runtimeProfile.agent.workspaceId,
      agentId: this.runtimeProfile.agent.id,
      callId: this.call.id,
    }) ?? this.log;
    this.preCallContext = this.call.providerMetadata?.preCall?.context ?? {};
    const ttsTemplateContext = welcomeTemplateContext(this.call);
    this.ttsTextProcessor = (this.dependencies.createTtsTextProcessor
      ?? createTtsTextPreprocessor)({
      language: this.runtimeProfile.agent.language,
      timeZone: this.runtimeProfile.agent.timeZone
        ?? this.runtimeProfile.agent.settings?.timeZone
        ?? this.runtimeProfile.agent.settings?.timezone
        ?? ttsTemplateContext.timeZone
        ?? ttsTemplateContext.timezone,
      context: {
        ...ttsTemplateContext,
        direction: this.call.direction,
      },
      now: this.dependencies.nowForTts,
    });
    this.interactionConfiguration = resolveInteractionConfiguration({
      ...this.runtimeProfile.agent.settings,
      ...this.runtimeProfile.agent.speech?.interaction,
    });
    this.callbackConfiguration = resolveCallbackConfiguration(this.runtimeProfile.agent.settings);
    this.taskCompletionState = createTaskCompletionState(this.runtimeProfile.agent.settings, {
      ...(this.call.providerMetadata?.context ?? {}),
      ...(this.call.providerMetadata?.preCall?.context ?? {}),
    });
    this.runtimeMetrics.taskCompletion = publicTaskCompletionState(this.taskCompletionState);
    this.contextResolution = this.call.providerMetadata?.conversationContext
      ?? resolveCallContextId({ call: this.call, runtimeProfile: this.runtimeProfile });
    this.contextCachePolicy = createContextCachePolicy({
      runtimeProfile: this.runtimeProfile,
      call: this.call,
      contextResolution: this.contextResolution,
    });
    this.contextStore = this.dependencies.contextStore ?? conversationContextCache;
    this.memoryStore = this.dependencies.memoryStore ?? conversationMemoryRepository;
    await this.#loadConversationMemory();
    this.runtimeProfile = {
      ...this.runtimeProfile,
      callContext: {
        ...this.contextResolution,
        cache: publicContextCacheMetadata(this.contextCachePolicy),
      },
    };
    this.log.info({
      stage: 'context.cache_policy', callId: this.call.id,
      policy: this.contextCachePolicy.policy, scope: this.contextCachePolicy.scope,
      crossCall: this.contextCachePolicy.crossCall,
    }, 'Conversation context cache policy activated');
    const agentInitiates = this.interactionConfiguration.greetingMode === greetingModes.AGENT_INITIATES;
    const renderedWelcome = agentInitiates
      ? renderWelcomeTemplate(
        this.runtimeProfile.agent.welcomeMessage,
        welcomeTemplateContext(this.call),
      )
      : { text: this.runtimeProfile.agent.welcomeMessage, dynamic: false, personalized: false, resolvedVariables: [], missingVariables: [] };
    const constrainedWelcome = this.#fitTtsMessage(renderedWelcome.text);
    this.runtimeProfile = {
      ...this.runtimeProfile,
      agent: { ...this.runtimeProfile.agent, welcomeMessage: constrainedWelcome },
    };
    this.personalizedWelcome = renderedWelcome.personalized;
    this.followUpOpeningRequired = this.callbackConfiguration.enabled && (
      this.previousConversationMemory?.callback?.scheduled === true
      || this.previousConversationMemory?.callback?.scheduling === 'scheduled'
    );
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
    this.cachedWelcomePromise = agentInitiates && this.runtimeProfile.agent.welcomeMessage
      && !this.personalizedWelcome && !this.followUpOpeningRequired
      ? this.welcomeCache.get(this.runtimeProfile, this.runtimeProfile.agent.welcomeMessage)
      : Promise.resolve(null);
    const persistTranscript = this.dependencies.appendTranscript ?? appendTranscriptEntry;
    this.transcriptPersistence = new TranscriptPersistenceQueue({
      persist: persistTranscript,
      log: this.log,
    });
    this.controller = new CallController({
      callSession: this.call,
      runtimeProfile: this.runtimeProfile,
      hooks: {
        onTranscript: (entry) => this.transcriptPersistence.enqueue({
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
      onConfirm: (details) => {
        const confirmation = this.#guard('interruption', () => this.#confirmInterruption(details));
        this.interruptionConfirmationPromise = confirmation;
        void confirmation.finally(() => {
          if (this.interruptionConfirmationPromise === confirmation) {
            this.interruptionConfirmationPromise = null;
          }
        });
      },
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
    this.ttsRuntimeContext = runtimeContext;
    this.adapters = await createAdapters(this.runtimeProfile, runtimeContext, this.registry);
    this.runtimeAmbience = await (this.dependencies.loadRuntimeAmbience ?? loadRuntimeAmbience)(
      this.runtimeProfile,
      { getObject: this.dependencies.getAmbienceObject, log: this.log },
    );
    this.audioEngine = (this.dependencies.createAudioEngine ?? ((options) => new ProviderIndependentAudioEngine(options)))({
      runtimeProfile: this.runtimeProfile,
      mediaSession: this.mediaSession,
      ambience: this.runtimeAmbience,
      onError: (error) => void this.#recover(error, 'audio_output'),
      onAmbienceError: (error) => this.log.warn({
        err: error, stage: 'ambience.mixer_disabled', callId: this.call.id,
      }, 'Ambience mixer failed; speech playback will continue without background sound'),
      onPlaybackMetric: (metric) => {
        const continuity = this.runtimeMetrics.audioContinuity;
        const gapMs = Math.max(0, Number(metric.gapMs ?? 0));
        const hasBufferedAudio = Number.isFinite(Number(metric.bufferedAudioMs));
        const bufferedAudioMs = hasBufferedAudio
          ? Math.max(0, Number(metric.bufferedAudioMs)) : null;
        continuity.maximumGapMs = Math.max(continuity.maximumGapMs, gapMs);
        if (hasBufferedAudio) {
          continuity.lastBufferedAudioMs = bufferedAudioMs;
          continuity.minimumBufferedAudioMs = continuity.minimumBufferedAudioMs === null
            ? bufferedAudioMs : Math.min(continuity.minimumBufferedAudioMs, bufferedAudioMs);
        }
        if (metric.sentenceBoundary) continuity.sentenceBoundaries += 1;
        if (metric.type === 'boundary_smoothed') continuity.smoothedBoundaries += 1;
        if (metric.type === 'underrun') {
          continuity.underruns += 1;
          continuity.totalUnderrunMs += gapMs;
        }
        if (metric.type === 'playback_deadline_miss') {
          continuity.playbackDeadlineMisses += 1;
          continuity.totalSchedulingDelayMs += gapMs;
          continuity.maximumSchedulingDelayMs = Math.max(
            continuity.maximumSchedulingDelayMs, gapMs,
          );
        }
        if (metric.type === 'websocket_delivery') {
          const deliveryMs = Math.max(0, Number(metric.deliveryMs ?? 0));
          const bufferedAmount = Math.max(0, Number(metric.bufferedAmount ?? 0));
          continuity.websocketDeliveries += 1;
          continuity.totalWebsocketDeliveryMs += deliveryMs;
          continuity.maximumWebsocketDeliveryMs = Math.max(
            continuity.maximumWebsocketDeliveryMs, deliveryMs,
          );
          continuity.maximumWebsocketBufferedBytes = Math.max(
            continuity.maximumWebsocketBufferedBytes, bufferedAmount,
          );
          if (metric.slow) continuity.slowWebsocketDeliveries += 1;
          if (metric.backpressured) continuity.websocketBackpressureEvents += 1;
        }
        if (continuity.samples.length < 100) continuity.samples.push({
          type: metric.type, gapMs, bufferedAudioMs,
          deliveryMs: Math.max(0, Number(metric.deliveryMs ?? 0)),
          bufferedAmount: Math.max(0, Number(metric.bufferedAmount ?? 0)),
          sentenceBoundary: metric.sentenceBoundary === true,
          carriedFrameBytes: Number(metric.carriedFrameBytes ?? 0),
          fromGenerationId: metric.fromGenerationId,
          toGenerationId: metric.toGenerationId,
        });
        const logData = {
          stage: metric.type === 'underrun' ? 'audio.buffer_underrun'
            : (metric.type === 'boundary_smoothed'
              ? 'audio.sentence_boundary_smoothed'
              : (metric.type === 'playback_deadline_miss'
                ? 'audio.playback_deadline_miss'
                : (metric.type === 'websocket_delivery'
                  ? 'audio.websocket_delivery'
                : (metric.type === 'playback_pre_roll' || metric.type === 'playback_refill'
                  ? 'audio.' + metric.type : 'audio.sentence_boundary')))),
          callId: this.call.id, gapMs, bufferedAudioMs,
          deliveryMs: Math.max(0, Number(metric.deliveryMs ?? 0)),
          websocketBufferedBytes: Math.max(0, Number(metric.bufferedAmount ?? 0)),
          waitMs: Math.max(0, Number(metric.waitMs ?? 0)),
          remoteBufferedAudioMs: Math.max(0, Number(metric.remoteBufferedAudioMs ?? 0)),
          sentenceBoundary: metric.sentenceBoundary === true,
          carriedFrameBytes: Number(metric.carriedFrameBytes ?? 0),
        };
        if (metric.type === 'underrun') {
          this.log.warn(logData, 'Voice playback buffer became empty during an assistant turn');
        } else if (metric.type === 'playback_deadline_miss') {
          this.log.warn(logData, 'Audio packet scheduler missed its delivery deadline');
        } else if (metric.type === 'websocket_delivery') {
          if (metric.slow || metric.backpressured) {
            this.log.warn(logData, 'Plivo WebSocket audio delivery was slow or backpressured');
          }
        } else this.log.debug(logData, 'Voice sentence boundary playback measured');
      },
    });
    this.unsubscribeStt = this.adapters.stt.onEvent((event) => (
      void this.#guard('stt_event', () => this.#handleSttEvent(event))
    ));
    try {
      await this.adapters.stt.connect();
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'stt', this.runtimeProfile.providers.stt, 'success');
    } catch (error) {
      this.#recordProviderFailure('stt', error, 'stt.connect');
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
      ambience: this.runtimeAmbience?.name ?? 'silent',
      ambienceCacheHit: this.runtimeAmbience?.cacheHit ?? false,
    }, '✅ Real-time voice pipeline initialized');
    return this;
  }

  async #loadConversationMemory() {
    this.previousConversationMemory = null;
    const metrics = {
      ...publicContextCacheMetadata(this.contextCachePolicy),
      hit: false,
      source: 'none',
    };
    this.runtimeMetrics.contextCache = metrics;
    if (!this.contextCachePolicy.readEnabled) return;

    try {
      const cached = await this.contextStore.get(this.contextCachePolicy);
      if (cached) {
        this.previousConversationMemory = cached;
        metrics.hit = true;
        metrics.source = 'redis';
        this.log.info({
          stage: 'context.memory_loaded', callId: this.call.id, source: 'redis',
        }, 'Previous conversation memory loaded from Redis');
        return;
      }
    } catch (error) {
      this.log.warn({
        err: error, stage: 'context.redis_read_failed', callId: this.call.id,
      }, 'Redis conversation cache read failed; continuing with durable lookup');
    }

    if (!this.contextCachePolicy.crossCall) return;
    try {
      this.conversationMemoryScope = conversationMemoryScope(this.runtimeProfile, this.contextResolution);
      const stored = await this.memoryStore.load(this.conversationMemoryScope);
      if (!stored?.state) return;
      this.previousConversationMemory = stored.state;
      metrics.hit = true;
      metrics.source = 'postgresql';
      await this.contextStore.set(this.contextCachePolicy, stored.state);
      this.log.info({
        stage: 'context.memory_loaded', callId: this.call.id, source: 'postgresql',
        revision: stored.revision,
      }, 'Previous conversation memory loaded from PostgreSQL');
    } catch (error) {
      this.log.warn({
        err: error, stage: 'context.postgresql_read_failed', callId: this.call.id,
      }, 'Durable conversation memory read failed; starting with a clean context');
    }
  }

  async #saveConversationMemory(outcome, reason) {
    if (!this.contextCachePolicy?.crossCall || !this.contextCachePolicy.writeEnabled || !this.controller) return;
    try {
      this.conversationMemoryScope ??= conversationMemoryScope(this.runtimeProfile, this.contextResolution);
      const state = buildConversationMemoryState({
        previous: this.previousConversationMemory,
        history: this.controller.history,
        call: this.call,
        outcome,
        reason,
        callback: this.currentCallbackRequest,
      });
      const stored = await this.memoryStore.save(this.conversationMemoryScope, {
        state,
        callSessionId: this.call.id,
        outcome,
      });
      await this.contextStore.set(this.contextCachePolicy, stored?.state ?? state);
      this.runtimeMetrics.contextCache.persisted = true;
      this.runtimeMetrics.contextCache.revision = stored?.revision ?? null;
      this.log.info({
        stage: 'context.memory_saved', callId: this.call.id,
        revision: stored?.revision ?? null,
      }, 'Conversation memory saved to PostgreSQL and cached in Redis');
    } catch (error) {
      this.runtimeMetrics.contextCache.persisted = false;
      this.log.warn({
        err: error, stage: 'context.memory_save_failed', callId: this.call.id,
      }, 'Conversation memory could not be saved; call completion will continue');
    }
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
    this.log.info({
      stage: 'ambience.lifecycle_started', callId: this.call.id,
      enabled: Boolean(this.runtimeAmbience), ambienceAssetId: this.runtimeAmbience?.id ?? null,
    }, this.runtimeAmbience ? 'Background ambience started with the call media stream' : 'Call media started in Silent mode');
    this.mediaStartedAt = Date.now();
    this.#armCallDuration();
    void this.#guard('audio_input', () => this.#pumpInbound());
    let followUpOpening = null;
    if (this.followUpOpeningRequired) {
      this.currentCallbackRequest = {
        ...this.previousConversationMemory.callback,
        scheduled: false,
        scheduling: 'fulfilled',
        fulfilledAt: new Date().toISOString(),
        fulfilledByCallId: this.call.id,
      };
    }
    if (this.followUpOpeningRequired
      && this.interactionConfiguration.greetingMode === greetingModes.AGENT_INITIATES) {
      try {
        const response = await this.#llm(
          `Open this follow-up call in one short natural spoken sentence. The caller previously requested this callback. Do not repeat the original introduction or invent details. Follow-up instruction: ${this.callbackConfiguration.followUpOpeningInstructions}`,
          [],
          { route: 'none', found: false },
          { continuationOpening: true },
        );
        followUpOpening = response.text ? this.#fitTtsMessage(response.text) : null;
        this.followUpOpeningSources = mergeMessageSources(
          this.#baseLlmSources(),
          response.sources,
        );
        this.runtimeMetrics.contextCache.followUpOpening = Boolean(followUpOpening);
      } catch (error) {
        this.#recordProviderFailure('llm', error, 'llm.follow_up_opening');
        this.log.warn({
          errorCode: error?.code ?? 'CONTINUATION_OPENING_FAILED',
          stage: 'greeting.continuation_failed', callId: this.call.id,
        }, 'Memory-aware follow-up opening failed; using the configured welcome');
      }
    }
    const welcomeSources = followUpOpening
      ? this.followUpOpeningSources
      : mergeMessageSources(
        createMessageSource(messageSourceTypes.WELCOME_CONFIGURATION, {
          id: this.runtimeProfile.agent.id,
          label: 'Welcome Message',
          metadata: { personalized: this.personalizedWelcome },
        }),
        this.personalizedWelcome ? this.#preCallSource() : null,
      );
    const action = await this.controller.initialize(Date.now(), followUpOpening, { sources: welcomeSources });
    if (action.action === 'speak') {
      this.log.info({
        stage: 'greeting.started', callId: this.call.id,
        mode: action.greetingMode, personalized: this.personalizedWelcome,
      }, 'Agent-initiated welcome playback started');
      const epoch = this.epoch;
      void this.#guard('welcome', async () => {
        await this.#synthesizeWelcome(action.text, `welcome-${epoch}`);
        if (epoch === this.epoch && this.controller.state === callStates.GREETING) {
          await this.controller.greetingComplete();
          this.#armInactivity();
        }
      });
    } else {
      if (action.reason === 'user_initiates') {
        this.log.info({
          stage: 'greeting.user_initiates', callId: this.call.id, mode: action.greetingMode,
        }, 'User-Initiates enabled; listening for the caller without welcome playback');
      }
      if (action.reason === 'agent_initiates_without_welcome') {
        this.log.warn({
          stage: 'greeting.missing', callId: this.call.id, mode: action.greetingMode,
        }, 'Agent-Initiates is enabled but no Welcome Message is configured; listening safely');
      }
      this.#armInactivity();
    }
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
      this.audioEngine?.setCallerSpeaking?.(true);
      this.#clearInactivity();
      this.customerUtterance.start();
      this.#recordInterruptionTrace('speech_started', {
        state: this.controller.state,
        epoch: this.epoch,
      });
      if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
        if (this.interruptionCandidate.active && !this.interruptionCandidate.confirmed) this.interruptionCandidate.reset();
        if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
        this.interruptionCandidate.start();
      }
      return;
    }
    if (event.type === 'partial_transcript') {
      const outputWasActive = [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state);
      const agentAudioWasPlaying = [callStates.GREETING, callStates.SPEAKING].includes(this.controller.state);
      const buffered = this.customerUtterance.observePartial(event.text);
      this.runtimeMetrics.interruptions.transcriptFragments += 1;
      let classification = 'listening';
      if (outputWasActive
        || this.interruptionCandidate.active) {
        if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
        const decision = this.interruptionCandidate.observeTranscript(buffered.text);
        classification = decision.classification;
        this.#recordInterruptionTrace('partial_transcript', {
          state: this.controller.state,
          epoch: this.epoch,
          classification: decision.classification,
          wordCount: decision.wordCount,
          elapsedMs: decision.elapsedMs,
          confirmationDelayMs: this.interruptionConfiguration.timeBased.thresholdMs,
          text: buffered.text,
        });
        if (agentAudioWasPlaying && decision.classification === 'acknowledgement') {
          this.log.debug({
            stage: 'interruption.acknowledgement_ignored', callId: this.call.id,
            text: event.text, wordCount: decision.wordCount,
          }, 'Acknowledgement received while agent audio is active; continuing speech');
          this.interruptionCandidate.reset();
        }
      }
      if (classification === 'listening') {
        this.#recordInterruptionTrace('partial_transcript', {
          state: this.controller.state,
          epoch: this.epoch,
          classification,
          text: buffered.text,
        });
      }
      return;
    }
    if (event.type === 'speech_ended') {
      this.audioEngine?.setCallerSpeaking?.(false);
      try { this.adapters.stt.flush(); } catch (error) { this.log.debug({ err: error, callId: this.call.id }, 'STT flush was not required'); }
      const buffered = this.customerUtterance.markSpeechEnded();
      this.#recordInterruptionTrace('speech_ended', {
        state: this.controller.state,
        epoch: this.epoch,
        hasFinal: Boolean(buffered.finalText),
        bufferedText: buffered.text,
      });
      // Some providers deliver final text before speech_ended. Replay the
      // already-buffered final only after this end-of-speech boundary.
      if (buffered.ready) {
        await this.#handleSttEvent({
          type: 'final_transcript', text: buffered.finalText,
          confidence: buffered.finalConfidence, bufferedFinal: true,
        });
      }
      return;
    }
    if (event.type !== 'final_transcript') return;
    this.audioEngine?.setCallerSpeaking?.(false);
    this.#clearInactivity();
    if (!event.bufferedFinal) this.customerUtterance.observeFinal(event.text, event.confidence);
    if (!this.customerUtterance.ready || !this.customerUtterance.markFinalProcessed()) return;
    const completedTurn = this.customerUtterance.text;
    const finalConfidence = this.customerUtterance.finalConfidence;
    this.runtimeMetrics.interruptions.finalTurns += 1;
    this.log.info({
      stage: 'stt.final_turn_assembled', callId: this.call.id,
      epoch: this.epoch, text: completedTurn,
      wordCount: Array.from(completedTurn.matchAll(/[\p{L}\p{N}]+/gu)).length,
      confidence: finalConfidence ?? undefined,
      confirmationDelayMs: this.interruptionConfiguration.timeBased.thresholdMs,
    }, 'STT fragments were assembled into one complete customer turn');
    this.#recordInterruptionTrace('final_turn_assembled', {
      epoch: this.epoch, text: completedTurn, confidence: finalConfidence,
    });
    const outputWasActive = [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state);
    const agentAudioWasPlaying = [callStates.GREETING, callStates.SPEAKING].includes(this.controller.state);
    if (outputWasActive || this.interruptionCandidate.active) {
      if (!this.interruptionCandidate.active) this.runtimeMetrics.interruptions.candidates += 1;
      let decision = this.interruptionCandidate.observeTranscript(completedTurn);
      if (agentAudioWasPlaying && decision.classification === 'acknowledgement') {
        this.log.info({
          stage: 'interruption.acknowledgement_ignored', callId: this.call.id,
          text: event.text, wordCount: decision.wordCount,
        }, 'Acknowledgement received while agent audio is active; continuing speech');
        this.interruptionCandidate.reset();
        this.customerUtterance.reset();
        return;
      }
      decision = await this.#waitForMeaningfulSpeechConfirmation(decision, completedTurn);
      if (decision.confirmed) {
        if (this.interruptionConfirmationPromise) await this.interruptionConfirmationPromise;
        else if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING]
          .includes(this.controller.state)) await this.#confirmInterruption(decision);
      }
      else if (outputWasActive) {
        this.interruptionCandidate.finish('final_transcript_below_threshold');
        this.customerUtterance.reset();
        return;
      }
      if (decision.classification === 'explicit_stop' && decision.stopPhraseOnly) {
        this.log.info({
          stage: 'interruption.explicit_stop_listening', callId: this.call.id,
          phrase: decision.matchedTrigger ?? undefined, text: completedTurn,
        }, 'Caller requested the agent to pause; waiting for the next customer turn');
        this.interruptionCandidate.reset();
        this.customerUtterance.reset();
        return;
      }
    }
    this.interruptionCandidate.reset();
    if (this.controller.state !== callStates.LISTENING || !completedTurn.trim()) {
      this.customerUtterance.reset();
      return;
    }
    const validation = validateFinalCustomerTurn({
      text: completedTurn,
      confidence: finalConfidence,
      minimumWords: this.interruptionConfiguration.wordBased.minimumWords,
      acknowledgementPhrases: this.interruptionConfiguration.acknowledgementPhrases,
      // Backchannels are ignored while agent output is active. A one-word
      // answer received while listening is handled by the configured minimum
      // meaningful-word rule instead of being misclassified as a backchannel.
      rejectAcknowledgement: agentAudioWasPlaying,
      minimumConfidence: Number(this.runtimeProfile.agent.settings?.sttMinimumConfidence ?? 0.55),
    });
    if (!validation.accepted) {
      this.log.info({
        stage: 'stt.final_turn_ignored', callId: this.call.id,
        reason: validation.reason, wordCount: validation.wordCount ?? 0,
        confidence: validation.confidence ?? finalConfidence ?? undefined,
      }, 'Final STT turn was not sent to Knowledge or LLM');
      this.customerUtterance.reset();
      return;
    }
    if (this.#isDuplicateFinalTurn(validation.text)) {
      this.log.info({
        stage: 'stt.final_turn_ignored', callId: this.call.id, reason: 'duplicate',
      }, 'Duplicate final STT turn was not sent to Knowledge or LLM');
      this.customerUtterance.reset();
      return;
    }
    const action = await this.controller.receiveFinalTranscript(validation.text);
    this.customerUtterance.reset();
    const callbackRequest = this.callbackConfiguration.enabled && this.call.direction === 'outbound'
      ? resolveCustomerCallbackRequest(validation.text, this.callbackConfiguration)
      : { detected: false, resolved: false };
    if (callbackRequest.detected) {
      this.currentCallbackRequest = {
        ...callbackRequest,
        scheduling: callbackRequest.resolved ? 'pending' : 'needs_clarification',
      };
      if (callbackRequest.resolved) {
        const scheduleCallback = this.dependencies.scheduleCallback ?? scheduleCustomerCallback;
        try {
          const result = await scheduleCallback({
            callId: this.call.id,
            tenantId: this.runtimeProfile.agent.tenantId,
            requestedFor: callbackRequest.requestedFor,
            requestText: callbackRequest.requestText,
            minimumDelaySeconds: this.callbackConfiguration.minimumDelaySeconds,
            maximumDelayDays: this.callbackConfiguration.maximumDelayDays,
          });
          this.currentCallbackRequest = {
            ...this.currentCallbackRequest,
            scheduling: result.scheduled ? 'scheduled' : 'not_scheduled',
            scheduled: result.scheduled === true,
            reason: result.reason ?? null,
            retryCount: result.retryCount ?? null,
            requestedFor: result.requestedFor ?? callbackRequest.requestedFor,
          };
          this.runtimeMetrics.callback = {
            detected: true,
            resolved: true,
            scheduled: result.scheduled === true,
            reason: result.reason ?? null,
          };
        } catch (error) {
          this.currentCallbackRequest = {
            ...this.currentCallbackRequest,
            scheduling: 'not_scheduled', scheduled: false, reason: 'scheduling_failed',
          };
          this.runtimeMetrics.callback = {
            detected: true, resolved: true, scheduled: false, reason: 'scheduling_failed',
          };
          this.log.warn({
            errorCode: error?.code ?? 'CALLBACK_SCHEDULING_FAILED',
            stage: 'callback.schedule_failed', callId: this.call.id,
          }, 'Callback request was understood but could not be scheduled');
        }
      } else {
        this.runtimeMetrics.callback = {
          detected: true, resolved: false, scheduled: false, reason: callbackRequest.reason,
        };
      }
    }
    if (this.currentCallbackRequest?.scheduled && this.callbackConfiguration.closeAfterScheduling) {
      await this.#close('customer_callback_scheduled');
      return;
    }
    const taskCompletion = captureTaskCompletionInput(this.taskCompletionState, validation.text, action.history);
    this.taskCompletionState = taskCompletion.state;
    this.runtimeMetrics.taskCompletion = publicTaskCompletionState(this.taskCompletionState);
    if (taskCompletion.captured.length) {
      this.log.info({
        stage: 'task_completion.fields_captured', callId: this.call.id,
        intent: this.taskCompletionState.configuration.intent,
        capturedFields: taskCompletion.captured,
        missingFields: taskCompletion.missing,
      }, 'Configured task completion information captured from caller');
    }
    if (taskCompletion.complete) {
      await this.#confirmTaskCompletion();
      return;
    }
    const callEndTrigger = findCallEndTriggerPhrase(validation.text, this.runtimeProfile.agent.settings);
    if (callEndTrigger && !callbackRequest.detected) {
      this.log.info({
        stage: 'postcall.end_trigger_detected', callId: this.call.id,
        source: callEndTrigger.source, phrase: callEndTrigger.phrase,
      }, 'Caller requested call end through configured trigger phrase');
      await this.#close(this.currentCallbackRequest?.scheduled
        ? 'customer_callback_scheduled'
        : 'caller_requested_hangup');
      return;
    }
    const epoch = ++this.epoch;
    void this.#guard('turn', () => this.#runTurn(validation.text, action.history, epoch));
  }

  async #confirmTaskCompletion() {
    const completion = publicTaskCompletionState(this.taskCompletionState);
    if (!completion.completed || this.finalized) return;
    const confirmation = this.#fitTtsMessage(renderTaskCompletionConfirmation(this.taskCompletionState));
    if (!confirmation) {
      this.log.warn({
        stage: 'task_completion.confirmation_missing', callId: this.call.id,
        intent: completion.intent,
      }, 'Task completion was ready but no confirmation message could be rendered');
      return;
    }
    const source = createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
      id: this.runtimeProfile.agent.id,
      label: 'Task completion confirmation',
      metadata: { intent: completion.intent, fields: completion.requiredFields.join(',') },
    });
    this.log.info({
      stage: 'task_completion.completed', callId: this.call.id,
      intent: completion.intent,
      collectedFields: Object.keys(completion.collectedData),
    }, 'All configured task completion information was collected; confirming and closing call');
    await this.controller.setAssistantResponse(confirmation, Date.now(), { sources: [source] });
    const epoch = ++this.epoch;
    await this.#synthesize(confirmation, `task-completion-${epoch}`);
    await this.audioEngine.drainOutput();
    await this.#close('task_completion_completed');
  }

  #isDuplicateFinalTurn(text) {
    const now = Date.now();
    const duplicateWindowMs = 10_000;
    for (const [value, at] of this.recentFinalTurns) {
      if (now - at > duplicateWindowMs) this.recentFinalTurns.delete(value);
    }
    const normalized = String(text).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
    if (!normalized) return true;
    if (this.recentFinalTurns.has(normalized)) return true;
    this.recentFinalTurns.set(normalized, now);
    return false;
  }

  #isStaleGeneration(epoch) {
    return this.finalized
      || (Number.isInteger(epoch) && (epoch !== this.epoch || this.cancelledEpochs.has(epoch)));
  }

  #recordInterruptionTrace(type, details = {}) {
    const samples = this.runtimeMetrics.interruptions.samples;
    if (samples.length >= 100) return;
    samples.push({ type, at: Date.now(), ...details });
  }

  #rejectLateGenerationEvent(stage, epoch, details = {}) {
    this.runtimeMetrics.interruptions.lateGenerationEventsRejected += 1;
    this.log.debug({
      stage, callId: this.call.id, epoch, currentEpoch: this.epoch, ...details,
    }, 'Late output from a cancelled voice generation was rejected');
    this.#recordInterruptionTrace('late_generation_rejected', {
      stage, epoch, currentEpoch: this.epoch, ...details,
    });
  }

  async #waitForMeaningfulSpeechConfirmation(decision, transcript) {
    if (decision.confirmed || decision.classification !== 'meaningful') return decision;
    if (decision.wordCount < this.interruptionConfiguration.wordBased.minimumWords) return decision;
    if (!this.interruptionConfiguration.timeBased.enabled || !this.interruptionCandidate.active) return decision;

    const remainingMs = Math.max(0, this.interruptionConfiguration.timeBased.thresholdMs - decision.elapsedMs);
    if (remainingMs > 0) {
      this.log.debug({
        stage: 'interruption.confirmation_wait', callId: this.call.id,
        remainingMs, elapsedMs: decision.elapsedMs,
        confirmationDelayMs: this.interruptionConfiguration.timeBased.thresholdMs,
        wordCount: decision.wordCount,
      }, 'Waiting for configured speech confirmation delay');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remainingMs);
        timer.unref?.();
      });
    }
    // Re-observe the complete assembled turn after the configured delay. The
    // candidate timer may already have confirmed it; this call is safe in
    // both cases and never introduces sound-only interruption.
    return this.interruptionCandidate.observeTranscript(transcript);
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
      classification: details.classification ?? 'meaningful',
      stopPhraseOnly: details.stopPhraseOnly === true,
    }, 'Caller interruption confirmed');
    this.#recordInterruptionTrace('interruption_confirmed', {
      epoch: this.epoch, method, classification: details.classification,
      wordCount: details.wordCount, elapsedMs: details.elapsedMs,
      matchedTrigger: details.matchedTrigger ?? null,
    });
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

  #preCallSource() {
    const keys = Object.keys(this.preCallContext ?? {});
    if (!keys.length) return null;
    return createMessageSource(messageSourceTypes.PRE_CALL_CONTEXT, {
      label: this.runtimeProfile.integrations?.preCall?.provider ?? 'Pre-Call API',
      metadata: { mappedKeys: keys.sort().join(',') },
    });
  }

  #memorySource() {
    if (!this.previousConversationMemory) return null;
    return createMessageSource(messageSourceTypes.CONVERSATION_MEMORY, {
      label: this.runtimeMetrics.contextCache?.source ?? 'conversation_memory',
      metadata: {
        policy: this.contextCachePolicy.policy,
        scope: this.contextCachePolicy.scope,
        source: this.runtimeMetrics.contextCache?.source,
      },
    });
  }

  #baseLlmSources() {
    return mergeMessageSources(
      createMessageSource(messageSourceTypes.SYSTEM_PROMPT, {
        id: this.runtimeProfile.agent.id,
        label: 'Agent Instructions',
        metadata: { configured: Boolean(String(this.runtimeProfile.agent.prompt ?? '').trim()) },
      }),
      this.#memorySource(),
      this.#preCallSource(),
    );
  }

  #fitTtsMessage(text) {
    const originalText = String(text ?? '').trim();
    if (!originalText) return '';
    const prepared = this.ttsTextProcessor?.process(text)
      ?? { text: originalText, changed: false, resolvedVariables: [], unresolvedVariables: [] };
    if (prepared.changed) {
      this.log.info({
        stage: 'tts.text_prepared', callId: this.call.id,
        resolvedVariables: prepared.resolvedVariables,
        unresolvedVariables: prepared.unresolvedVariables,
      }, 'TTS text was safely prepared before synthesis');
    }
    if (prepared.unresolvedVariables.length) {
      this.log.warn({
        stage: 'tts.unresolved_variables_removed', callId: this.call.id,
        variables: prepared.unresolvedVariables,
      }, 'Unresolved TTS variables were blocked from provider audio');
    }
    const configuredLimits = [
      Number(this.runtimeProfile.limits?.ttsMaxCharactersPerResponse ?? 0),
      Number(this.runtimeProfile.limits?.ttsMaxCharactersPerMinute ?? 0),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const maximumCharacters = configuredLimits.length ? Math.min(...configuredLimits) : 0;
    const configuredFallback = String(
      this.runtimeProfile.limits?.ttsLimitFallbackMessage
      ?? this.runtimeProfile.agent.settings?.ttsLimitFallbackMessage
      ?? '',
    ).trim();
    const defaultFallback = languageCode(this.runtimeProfile.agent.language) === 'ta'
      ? 'இந்த தகவலை சுருக்கமாகச் சொல்றேன். மீண்டும் கேட்க முடியுமா?'
      : 'Please ask me again and I will answer briefly.';
    const fitted = this.ttsCharacterBudget.fitMessage(
      prepared.text || configuredFallback || defaultFallback,
      configuredFallback || defaultFallback,
      { maximumCharacters, locale: languageCode(this.runtimeProfile.agent.language) },
    );
    if (fitted !== prepared.text) {
      this.log.warn({
        stage: 'tts.character_limit_message_fitted',
        callId: this.call.id,
        configuredMaximum: maximumCharacters,
      }, 'Spoken message was reduced at a complete sentence boundary');
    }
    return fitted;
  }

  async #reserveTtsCharacters(text, generationId) {
    if (!this.ttsCharacterBudget.enabled) return true;
    const epoch = this.epoch;
    while (!this.finalized && epoch === this.epoch) {
      const decision = this.ttsCharacterBudget.inspect(text);
      if (decision.impossible) {
        throw new AppError(409, 'TTS message exceeds the configured per-minute character limit',
          'VOICE_TTS_MESSAGE_LIMIT_EXCEEDED', {
            characters: decision.characters,
            maximumCharactersPerMinute: this.ttsCharacterBudget.maximum,
          });
      }
      if (decision.allowed) {
        const reservation = this.ttsCharacterBudget.consume(text);
        this.runtimeMetrics.ttsLimits.charactersSynthesized += reservation.characters;
        this.runtimeMetrics.ttsLimits.currentWindowUsed = reservation.used;
        return true;
      }
      this.runtimeMetrics.ttsLimits.throttleWaitMs += decision.waitMs;
      this.log.info({
        stage: 'tts.character_limit_wait', callId: this.call.id, generationId,
        waitMs: decision.waitMs, characters: decision.characters,
      }, 'Waiting for rolling TTS character capacity');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, decision.waitMs);
        timer.unref?.();
      });
    }
    return false;
  }

  async #llmAttempt(query, history, knowledge, context = {}, streaming = {}) {
    const session = await createSelectedLlmStream(this.runtimeProfile, {
      callId: this.call.id,
      query,
      history: [
        ...(this.previousConversationMemory?.recentMessages ?? []),
        ...(history ?? []),
      ].slice(-env.LLM_MAX_HISTORY_MESSAGES),
      knowledge,
      context: {
        callId: this.call.id,
        direction: this.call.direction,
        conversationMemory: {
          policy: this.contextCachePolicy.policy,
          scope: this.contextCachePolicy.scope,
          previousSummary: this.previousConversationMemory?.summary || undefined,
          collectedData: this.previousConversationMemory?.collectedData,
          completedQuestions: this.previousConversationMemory?.completedQuestions,
          pendingQuestions: this.previousConversationMemory?.pendingQuestions,
          callback: this.previousConversationMemory?.callback,
          currentCallbackRequest: this.currentCallbackRequest,
          lastCall: this.previousConversationMemory?.lastCall,
        },
        preCall: this.preCallContext,
        ...context,
        ttsResponseCharacterLimit: (() => {
          const limits = [
            Number(this.runtimeProfile.limits?.ttsMaxCharactersPerResponse ?? 0),
            Number(this.runtimeProfile.limits?.ttsMaxCharactersPerMinute ?? 0),
          ].filter((value) => Number.isFinite(value) && value > 0);
          return limits.length ? Math.min(...limits) : undefined;
        })(),
      },
      usageDirection: this.call.direction,
    }, { registry: this.registry, adapter: this.adapters.llm, skipDefaultRegistration: true });
    this.activeLlm = session;
    let text = '';
    let toolCalls = [];
    let completion = {};
    const sentenceBuffer = createStreamingSentenceBuffer();
    try {
      for await (const event of session.events) {
        if (streaming.isCurrent && !streaming.isCurrent()) {
          this.#rejectLateGenerationEvent('llm.late_event_rejected', streaming.epoch, {
            eventType: event.type,
          });
          try { await session.cancel?.('stale_generation'); } catch { /* already cancelled */ }
          return { cancelled: true, text: '', toolCalls: [], sources: [] };
        }
        if (event.type === 'text_delta') {
          text += event.delta;
          for (const sentence of sentenceBuffer.push(event.delta)) streaming.onSentence?.(sentence);
        }
        else if (event.type === 'tool_call') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        else if (event.type === 'usage') this.usageTracker.record('llm', event.usage);
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
        else if (event.type === 'response_started') completion.providerRequestId = event.providerRequestId ?? completion.providerRequestId;
        else if (event.type === 'cancelled') return { cancelled: true, text: '', toolCalls: [], sources: [] };
        else if (event.type === 'completed') {
          completion = { ...completion, ...event };
          toolCalls = event.toolCalls?.length ? event.toolCalls : toolCalls;
          if (event.durationMs) this.usageTracker.record('llm', { requests: 0, durationMs: event.durationMs });
          this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'success', {
            latencyMs: event.durationMs,
          });
        }
      }
      for (const sentence of sentenceBuffer.flush()) streaming.onSentence?.(sentence);
      streaming.flush?.();
      return {
        cancelled: false,
        text: text.trim(),
        toolCalls,
        sources: [llmMessageSource(this.runtimeProfile.providers.llm, completion)],
      };
    } catch (error) {
      sentenceBuffer.clear();
      streaming.flush?.();
      error.partialText = text.trim();
      error.streamedSentenceCount = streaming.sentenceCount?.() ?? 0;
      throw error;
    } finally {
      if (this.activeLlm === session) this.activeLlm = null;
      await session.close();
    }
  }

  async #llm(query, history, knowledge, context = {}, streaming = {}) {
    let lastError;
    for (let attempt = 0; attempt <= env.VOICE_PROVIDER_MAX_RETRIES; attempt += 1) {
      try {
        return await this.#llmAttempt(query, history, knowledge, context, streaming);
      } catch (error) {
        lastError = error;
        if (streaming.sentenceCount?.() > 0
          || error?.retryable !== true || attempt >= env.VOICE_PROVIDER_MAX_RETRIES) throw error;
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

  #createSentenceTtsPipeline(epoch, turnStartedAt) {
    let chain = Promise.resolve();
    let beginPromise = null;
    let failure = null;
    let sentenceNumber = 0;
    let spokenCharacters = 0;
    let pendingShortSentence = '';
    let groupingTimer = null;
    let activeLookaheadJobs = 0;
    let schedulerCancelled = false;
    const pendingLookaheadJobs = [];
    const spokenSentences = [];
    const completedSentences = [];
    const playbackGroupId = `turn-${epoch}`;
    const maximumResponseCharacters = Number(
      this.runtimeProfile.limits?.ttsMaxCharactersPerResponse ?? 0,
    );

    const pumpLookaheadJobs = () => {
      while (!schedulerCancelled
        && activeLookaheadJobs < env.VOICE_TTS_LOOKAHEAD_CONCURRENCY
        && pendingLookaheadJobs.length) {
        const job = pendingLookaheadJobs.shift();
        if (this.finalized || epoch !== this.epoch) {
          this.runtimeMetrics.ttsLookahead.cancelled += 1;
          job.resolve({ value: { cancelled: true, chunks: [], bytes: 0 } });
          continue;
        }
        activeLookaheadJobs += 1;
        this.runtimeMetrics.ttsLookahead.started += 1;
        Promise.resolve().then(job.task).then((value) => {
          if (value?.cancelled) this.runtimeMetrics.ttsLookahead.cancelled += 1;
          else {
            this.runtimeMetrics.ttsLookahead.completed += 1;
            this.runtimeMetrics.ttsLookahead.bufferedBytes += Number(value?.bytes ?? 0);
            this.runtimeMetrics.ttsLookahead.maximumSegmentBytes = Math.max(
              this.runtimeMetrics.ttsLookahead.maximumSegmentBytes,
              Number(value?.bytes ?? 0),
            );
          }
          job.resolve({ value });
        }, (error) => {
          this.runtimeMetrics.ttsLookahead.failed += 1;
          job.resolve({ error });
        }).finally(() => {
          activeLookaheadJobs -= 1;
          pumpLookaheadJobs();
        });
      }
    };
    const scheduleLookahead = (task) => {
      this.runtimeMetrics.ttsLookahead.scheduled += 1;
      if (schedulerCancelled || this.finalized || epoch !== this.epoch) {
        this.runtimeMetrics.ttsLookahead.cancelled += 1;
        return Promise.resolve({ value: { cancelled: true, chunks: [], bytes: 0 } });
      }
      return new Promise((resolve) => {
        pendingLookaheadJobs.push({ task, resolve });
        pumpLookaheadJobs();
      });
    };
    const cancelScheduler = () => {
      if (schedulerCancelled) return 0;
      schedulerCancelled = true;
      this.activeLookaheadSchedulers.delete(cancelScheduler);
      clearGroupingTimer();
      pendingShortSentence = '';
      const cancelled = pendingLookaheadJobs.splice(0);
      this.runtimeMetrics.ttsLookahead.cancelled += cancelled.length;
      for (const job of cancelled) {
        job.resolve({ value: { cancelled: true, chunks: [], bytes: 0 } });
      }
      return cancelled.length;
    };
    this.activeLookaheadSchedulers.add(cancelScheduler);

    const enqueueNow = (rawSentence, groupedSentenceCount = 1) => {
      if (this.finalized || epoch !== this.epoch || failure) return false;
      const sentence = this.#fitTtsMessage(rawSentence);
      if (!sentence) return false;
      const sentenceCharacters = Array.from(sentence).length;
      if (maximumResponseCharacters > 0
        && spokenCharacters + sentenceCharacters > maximumResponseCharacters) {
        this.log.warn({
          stage: 'llm.sentence_stream_response_limit', callId: this.call.id,
          maximumCharacters: maximumResponseCharacters, spokenCharacters,
        }, 'Remaining LLM sentences were not sent to TTS because the response limit was reached');
        return false;
      }
      sentenceNumber += 1;
      const currentSentenceNumber = sentenceNumber;
      spokenCharacters += sentenceCharacters;
      spokenSentences.push(sentence);
      this.runtimeMetrics.sentenceGrouping.groupsQueued += 1;
      this.runtimeMetrics.sentenceGrouping.sentencesGrouped += groupedSentenceCount;
      if (groupedSentenceCount > 1) this.runtimeMetrics.sentenceGrouping.multiSentenceGroups += 1;
      beginPromise ??= this.controller.beginAssistantResponse();
      const generationId = `turn-${epoch}-sentence-${currentSentenceNumber}`;
      const kind = currentSentenceNumber === 1 ? 'response' : 'response_sentence';
      const useLookahead = env.VOICE_TTS_LOOKAHEAD_ENABLED && currentSentenceNumber > 1;
      let lookaheadReady = false;
      const lookahead = useLookahead
        ? scheduleLookahead(() => this.#prefetchTts(sentence, generationId, { epoch }))
          .then((result) => { lookaheadReady = true; return result; })
        : null;
      chain = chain.then(async () => {
        await beginPromise;
        if (this.finalized || epoch !== this.epoch || failure) return false;
        this.log.info({
          stage: 'llm.sentence_ready_for_tts', callId: this.call.id,
          generationId, sentenceNumber: currentSentenceNumber, characters: sentenceCharacters,
        }, 'Complete LLM sentence queued for immediate TTS');
        if (lookahead) {
          const waitedForHandoff = !lookaheadReady;
          if (!waitedForHandoff) this.runtimeMetrics.ttsLookahead.readyBeforePlayback += 1;
          else this.runtimeMetrics.ttsLookahead.waitedAtPlayback += 1;
          const handoffWaitStartedAt = Date.now();
          const prepared = await lookahead;
          const handoffWaitMs = waitedForHandoff
            ? Math.max(0, Date.now() - handoffWaitStartedAt) : 0;
          if (waitedForHandoff) {
            const generationMetrics = this.runtimeMetrics.ttsGeneration;
            generationMetrics.sentenceHandoffWaits += 1;
            generationMetrics.totalSentenceHandoffWaitMs += handoffWaitMs;
            generationMetrics.maximumSentenceHandoffWaitMs = Math.max(
              generationMetrics.maximumSentenceHandoffWaitMs, handoffWaitMs,
            );
          }
          let played;
          if (prepared.error) {
            this.runtimeMetrics.ttsLookahead.sequentialFallbacks += 1;
            this.log.warn({
              err: prepared.error, stage: 'tts.lookahead_sequential_fallback',
              callId: this.call.id, generationId, sentenceNumber: currentSentenceNumber,
            }, 'Look-ahead TTS failed; retrying this sentence through the ordered primary adapter');
            played = await this.#synthesize(sentence, generationId, {
              kind, startedAt: turnStartedAt, deferDrain: true,
              playbackGroupId, deferBoundaryFlush: true,
              charactersReserved: true, epoch,
            });
          } else {
            played = await this.#playPrefetchedTts(prepared.value, generationId, {
              epoch, playbackGroupId, deferBoundaryFlush: true,
            });
          }
          if (played) {
            completedSentences.push(sentence);
            this.runtimeMetrics.ttsLookahead.successfulHandoffs += 1;
          }
          return played;
        }
        const played = await this.#synthesize(sentence, generationId, {
          kind, startedAt: turnStartedAt, deferDrain: true,
          playbackGroupId, deferBoundaryFlush: true, epoch,
        });
        if (played) completedSentences.push(sentence);
        return played;
      }).catch((error) => {
        failure ??= error;
        this.runtimeMetrics.ttsLookahead.isolatedFailures += 1;
        this.log.error({
          err: error, stage: 'tts.sentence_failure_isolated', callId: this.call.id,
          generationId, sentenceNumber: currentSentenceNumber,
          completedSentences: completedSentences.length,
        }, 'Failed TTS sentence was isolated from audio already queued for playback');
        return false;
      });
      return true;
    };
    const clearGroupingTimer = () => {
      if (groupingTimer) clearTimeout(groupingTimer);
      groupingTimer = null;
    };
    const flushGrouping = () => {
      clearGroupingTimer();
      if (!pendingShortSentence) return false;
      const pending = pendingShortSentence;
      pendingShortSentence = '';
      return enqueueNow(pending, 1);
    };
    const armGroupingTimer = () => {
      clearGroupingTimer();
      groupingTimer = setTimeout(flushGrouping, env.VOICE_TTS_GROUP_WAIT_MS);
      groupingTimer.unref?.();
    };
    const enqueue = (rawSentence) => {
      const sentence = String(rawSentence ?? '').trim();
      if (!sentence) return false;
      if (!env.VOICE_TTS_SENTENCE_GROUPING_ENABLED || sentenceNumber === 0) {
        flushGrouping();
        return enqueueNow(sentence, 1);
      }
      const sentenceCharacters = Array.from(sentence).length;
      if (sentenceCharacters > env.VOICE_TTS_SHORT_SENTENCE_CHARACTERS) {
        flushGrouping();
        return enqueueNow(sentence, 1);
      }
      if (pendingShortSentence) {
        const combined = `${pendingShortSentence} ${sentence}`;
        if (Array.from(combined).length <= env.VOICE_TTS_GROUP_MAX_CHARACTERS) {
          clearGroupingTimer();
          pendingShortSentence = '';
          return enqueueNow(combined, 2);
        }
        flushGrouping();
      }
      pendingShortSentence = sentence;
      armGroupingTimer();
      return true;
    };

    return {
      enqueue,
      flushGrouping,
      cancel: cancelScheduler,
      sentenceCount: () => spokenSentences.length,
      spokenText: () => spokenSentences.join(' ').trim(),
      completedText: () => completedSentences.join(' ').trim(),
      waitUntilStarted: async () => beginPromise ? beginPromise : undefined,
      finish: async () => {
        try {
          flushGrouping();
          await chain;
          if (epoch === this.epoch && !this.finalized) {
            await this.audioEngine.flushOutputGroup?.(playbackGroupId);
            await this.audioEngine.drainOutput();
          }
          if (failure && completedSentences.length === 0) throw failure;
          if (failure) {
            this.runtimeMetrics.ttsLookahead.partialTurnsPreserved += 1;
            this.log.warn({
              stage: 'tts.partial_turn_preserved', callId: this.call.id,
              completedSentences: completedSentences.length,
              failedCode: failure.code ?? 'TTS_SENTENCE_FAILED',
            }, 'Completed sentence audio was preserved after a later TTS failure');
          }
          return {
            active: epoch === this.epoch && !this.finalized,
            partial: Boolean(failure),
            failure,
            completedSentences: completedSentences.length,
            spokenText: completedSentences.join(' ').trim(),
          };
        } finally {
          clearGroupingTimer();
          this.activeLookaheadSchedulers.delete(cancelScheduler);
        }
      },
    };
  }

  async #runTurn(query, history, epoch) {
    const turnStartedAt = Date.now();
    const knowledge = await this.#knowledge(query);
    const sourceTrace = new MessageSourceTrace(
      this.#baseLlmSources(),
      knowledgeMessageSources(knowledge),
    );
    if (epoch !== this.epoch || this.finalized) return;
    const sentencePipeline = this.#createSentenceTtsPipeline(epoch, turnStartedAt);
    const streaming = {
      onSentence: sentencePipeline.enqueue,
      flush: sentencePipeline.flushGrouping,
      sentenceCount: sentencePipeline.sentenceCount,
      epoch,
      isCurrent: () => !this.#isStaleGeneration(epoch),
    };
    let response;
    try {
      response = await this.#llm(query, history, knowledge, {}, streaming);
    } catch (error) {
      this.#recordProviderFailure('llm', error, 'llm.response');
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'failure', {
        code: error.code,
      });
      if (sentencePipeline.sentenceCount() > 0) {
        this.log.warn({
          stage: 'llm.partial_stream_retained', code: error.code,
          sentenceCount: sentencePipeline.sentenceCount(),
        }, 'LLM failed after speech started; retaining only complete sentences already queued');
        response = {
          cancelled: false,
          text: String(error.partialText ?? sentencePipeline.spokenText()).trim(),
          toolCalls: [],
          sources: [createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
            label: 'Partial streamed response', metadata: { reason: error.code },
          })],
        };
      } else if (!knowledge.found || !String(knowledge.content ?? '').trim()) throw error;
      else {
      this.log.warn({
        stage: 'llm.verified_knowledge_fallback', code: error.code,
        providerId: this.runtimeProfile.providers.llm.providerId,
      }, 'Selected LLM failed; using verified knowledge response for this call');
      response = {
        cancelled: false,
        text: String(knowledge.content).trim(),
        toolCalls: [],
        sources: [createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
          label: 'Verified knowledge fallback', metadata: { reason: error.code },
        })],
      };
      }
    }
    sourceTrace.add(response.sources);
    if (response.cancelled || epoch !== this.epoch) {
      sentencePipeline.cancel();
      return;
    }
    if (response.toolCalls.length) {
      const toolResults = await (this.dependencies.executeTools ?? executeAgentTools)(
        this.runtimeProfile, this.call, response.toolCalls, { fetchImpl: this.dependencies.fetchImpl },
      );
      this.runtimeMetrics.tools.push(...toolResults.map((result) => ({
        name: result.name, success: result.success, durationMs: Number(result.durationMs ?? 0),
      })));
      sourceTrace.add(toolMessageSources(toolResults));
      if (epoch !== this.epoch) return;
      response = await this.#llm(query, history, knowledge, {
        toolResults,
        instruction: 'Use these tool results to answer the caller. Never claim an unsuccessful tool completed.',
      }, streaming);
      sourceTrace.add(response.sources);
    }
    if (response.cancelled || epoch !== this.epoch || this.finalized) {
      sentencePipeline.cancel();
      return;
    }
    const generatedAnswer = String(response.text ?? '').trim();
    const unconstrainedAnswer = generatedAnswer
      || String(this.runtimeProfile.agent.settings?.noResponseMessage ?? 'Sorry, I could not form a response.');
    if (sentencePipeline.sentenceCount() === 0) sentencePipeline.enqueue(unconstrainedAnswer);
    if (!generatedAnswer) {
      sourceTrace.add(createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
        label: 'No-response fallback',
      }));
    }
    await sentencePipeline.waitUntilStarted();
    const playback = await sentencePipeline.finish();
    const answer = playback.spokenText
      || sentencePipeline.completedText()
      || this.#fitTtsMessage(unconstrainedAnswer);
    await this.controller.setAssistantResponse(answer, Date.now(), { sources: sourceTrace.snapshot() });
    if (epoch !== this.epoch || this.finalized || this.controller.state !== callStates.SPEAKING) return;
    await this.controller.playbackComplete();
    this.errorCount = 0;
    this.#armInactivity();
  }

  async #synthesizeWelcome(text, generationId) {
    const cached = await this.cachedWelcomePromise;
    if (cached?.length) {
      if (!await this.#reserveTtsCharacters(text, generationId)) return false;
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

  #recordProviderFailure(kind, error, stage) {
    if (error && typeof error === 'object') {
      if (this.recordedProviderFailures.has(error)) return;
      this.recordedProviderFailures.add(error);
    }
    const failures = this.runtimeMetrics.providerFailures;
    const normalizedKind = Object.hasOwn(failures, kind) ? kind : 'tts';
    failures.total += 1;
    failures[normalizedKind] += 1;
    if (failures.samples.length < 100) failures.samples.push({
      kind: normalizedKind,
      stage,
      code: String(error?.code ?? 'PROVIDER_FAILURE').slice(0, 120),
      retryable: error?.retryable === true,
      at: Date.now(),
    });
  }

  #recordTtsGeneration(input) {
    const metrics = this.runtimeMetrics.ttsGeneration;
    const generationMs = Math.max(0, Number(input.generationMs ?? 0));
    const firstAudioLatencyMs = Number.isFinite(Number(input.firstAudioLatencyMs))
      ? Math.max(0, Number(input.firstAudioLatencyMs)) : null;
    if (input.outcome === 'completed') metrics.completed += 1;
    else if (input.outcome === 'cancelled') metrics.cancelled += 1;
    else metrics.failed += 1;
    metrics.totalGenerationMs += generationMs;
    metrics.maximumGenerationMs = Math.max(metrics.maximumGenerationMs, generationMs);
    if (firstAudioLatencyMs !== null) {
      metrics.firstAudioSamples += 1;
      metrics.totalFirstAudioLatencyMs += firstAudioLatencyMs;
      metrics.maximumFirstAudioLatencyMs = Math.max(
        metrics.maximumFirstAudioLatencyMs, firstAudioLatencyMs,
      );
    }
    if (metrics.samples.length < 100) metrics.samples.push({
      generationId: input.generationId,
      attempt: Number(input.attempt ?? 0) + 1,
      bufferedLookahead: input.bufferedLookahead === true,
      outcome: input.outcome,
      generationMs,
      firstAudioLatencyMs,
      code: input.error?.code ?? null,
    });
  }

  #recordTtsSpeed(text, generationId, usage, options = {}) {
    const speed = this.ttsSpeedMonitor.inspect({
      text,
      characters: usage?.characters,
      audioOutputMs: usage?.audioOutputMs,
    });
    const sample = {
      generationId,
      attempt: Number(options.attempt ?? 0) + 1,
      classification: speed.classification,
      measured: speed.measured,
      characters: speed.characters,
      audioOutputMs: speed.audioOutputMs,
      charactersPerSecond: speed.charactersPerSecond,
      audioStarted: options.audioStarted === true,
      bufferedLookahead: options.bufferedLookahead === true,
      requestDurationMs: Math.max(0, Date.now() - Number(options.requestStartedAt ?? Date.now())),
    };
    if (this.runtimeMetrics.ttsSpeed.samples.length < 100) {
      this.runtimeMetrics.ttsSpeed.samples.push(sample);
    }
    if (speed.measured) {
      this.runtimeMetrics.ttsSpeed.measured += 1;
      if (speed.abnormal) this.runtimeMetrics.ttsSpeed.abnormal += 1;
      else this.runtimeMetrics.ttsSpeed.normal += 1;
      if (speed.classification === 'too_fast') this.runtimeMetrics.ttsSpeed.tooFast += 1;
      if (speed.classification === 'too_slow') this.runtimeMetrics.ttsSpeed.tooSlow += 1;
    }
    if (speed.abnormal) {
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'tts', this.runtimeProfile.providers.tts, 'failure', {
        code: 'TTS_ABNORMAL_SPEED', latencyMs: usage?.firstAudioLatencyMs,
      });
      this.log.warn({
        stage: 'tts.abnormal_speed', callId: this.call.id, ...sample,
        expectedMinimum: speed.expectedMinimum, expectedMaximum: speed.expectedMaximum,
      }, 'TTS audio speed was outside the safe speaking range');
    } else {
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'tts', this.runtimeProfile.providers.tts, 'success', {
        latencyMs: usage?.firstAudioLatencyMs,
      });
    }
    return { speed, sample };
  }

  async #synthesizeAttempt(text, generationId, options = {}) {
    if (this.#isStaleGeneration(options.epoch)) {
      this.#rejectLateGenerationEvent('tts.generation_start_rejected', options.epoch, { generationId });
      return false;
    }
    this.audioEngine.beginOutputGeneration(generationId, options.playbackGroupId ?? generationId);
    const requestStartedAt = Date.now();
    this.runtimeMetrics.ttsGeneration.requests += 1;
    let completed = false;
    let firstAudio = true;
    let firstAudioLatencyMs = null;
    let generationRecorded = false;
    try {
      for await (const event of this.adapters.tts.synthesizeStream({ text, generationId })) {
        if (this.#isStaleGeneration(options.epoch)) {
          this.#rejectLateGenerationEvent('tts.late_event_rejected', options.epoch, {
            generationId, eventType: event.type,
          });
          this.#recordTtsGeneration({
            generationId, attempt: options.attempt,
            bufferedLookahead: false, outcome: 'cancelled',
            generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
          });
          generationRecorded = true;
          return false;
        }
        if (event.type === 'audio_chunk') {
          if (firstAudio) {
            firstAudio = false;
            firstAudioLatencyMs = Math.max(0, Date.now() - requestStartedAt);
            const latencyMs = Math.max(0, Date.now() - (options.startedAt ?? Date.now()));
            if (options.kind === 'welcome') this.runtimeMetrics.latency.welcomeAudioStartMs = latencyMs;
            if (options.kind === 'response') {
              this.runtimeMetrics.latency.firstResponseAudioMs ??= [];
              this.runtimeMetrics.latency.firstResponseAudioMs.push(latencyMs);
              this.log.info({
                stage: 'voice.first_response_audio', callId: this.call.id,
                epoch: options.epoch ?? this.epoch, generationId, latencyMs,
              }, 'First response audio is ready for Plivo playback');
            }
          }
          if (options.capture) options.capture.push(Buffer.from(event.audio));
          if (!await this.audioEngine.enqueueSynthesized(event.audio, generationId)) {
            this.#recordTtsGeneration({
              generationId, attempt: options.attempt,
              bufferedLookahead: false, outcome: 'cancelled',
              generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
            });
            generationRecorded = true;
            return false;
          }
        } else if (event.type === 'usage') this.usageTracker.record('tts', event.usage);
        else if (event.type === 'completed') {
          completed = true;
          const { speed, sample } = this.#recordTtsSpeed(text, generationId, event.usage, {
            ...options, audioStarted: !firstAudio, requestStartedAt,
          });
          if (speed.abnormal) {
            if (firstAudio) {
              throw Object.assign(new AppError(502,
                'TTS provider generated audio at an abnormal speed', 'TTS_ABNORMAL_SPEED', sample),
              { retryable: true });
            }
            this.runtimeMetrics.ttsSpeed.retriesSuppressedAfterAudio += 1;
          }
        }
        else if (event.type === 'cancelled') {
          this.#recordTtsGeneration({
            generationId, attempt: options.attempt,
            bufferedLookahead: false, outcome: 'cancelled',
            generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
          });
          generationRecorded = true;
          return false;
        }
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
      }
    } catch (error) {
      error.audioStarted = !firstAudio;
      this.#recordTtsGeneration({
        generationId, attempt: options.attempt,
        bufferedLookahead: false, outcome: 'failed',
        generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs, error,
      });
      generationRecorded = true;
      this.#recordProviderFailure('tts', error, 'tts.direct');
      throw error;
    }
    if (this.#isStaleGeneration(options.epoch)) {
      this.#rejectLateGenerationEvent('tts.generation_complete_rejected', options.epoch, { generationId });
      return false;
    }
    if (!completed) {
      const error = new AppError(502, 'TTS stream ended without completion', 'TTS_STREAM_INCOMPLETE');
      if (!generationRecorded) this.#recordTtsGeneration({
        generationId, attempt: options.attempt,
        bufferedLookahead: false, outcome: 'failed',
        generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs, error,
      });
      this.#recordProviderFailure('tts', error, 'tts.direct');
      throw error;
    }
    this.#recordTtsGeneration({
      generationId, attempt: options.attempt,
      bufferedLookahead: false, outcome: 'completed',
      generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
    });
    await this.audioEngine.flushSynthesized(generationId, {
      finalizeGroup: options.deferBoundaryFlush !== true,
    });
    if (!options.deferDrain && !this.#isStaleGeneration(options.epoch)) await this.audioEngine.drainOutput();
    return true;
  }

  async #createLookaheadTtsAdapter(generationId) {
    const factory = this.dependencies.createLookaheadTtsAdapter;
    if (factory) return factory({
      generationId,
      runtimeProfile: this.runtimeProfile,
      runtimeContext: this.ttsRuntimeContext,
    });
    return this.registry.create('tts', this.runtimeProfile.providers.tts, {
      ...this.ttsRuntimeContext,
      callId: `${this.call.id}:${generationId}`,
    });
  }

  async #prefetchTtsAttempt(text, generationId, options = {}) {
    const requestStartedAt = Date.now();
    this.runtimeMetrics.ttsGeneration.requests += 1;
    let adapter = null;
    const chunks = [];
    let bytes = 0;
    let completed = false;
    let firstAudioLatencyMs = null;
    let generationRecorded = false;
    try {
      adapter = await this.#createLookaheadTtsAdapter(generationId);
      this.activeLookaheadTtsAdapters.add(adapter);
      await adapter.connect();
      for await (const event of adapter.synthesizeStream({ text, generationId })) {
        if (this.finalized || options.epoch !== this.epoch) {
          adapter.cancel('stale_lookahead_turn');
          this.#recordTtsGeneration({
            generationId, attempt: options.attempt,
            bufferedLookahead: true, outcome: 'cancelled',
            generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
          });
          generationRecorded = true;
          return { cancelled: true, chunks: [], bytes: 0 };
        }
        if (event.type === 'audio_chunk') {
          firstAudioLatencyMs ??= Math.max(0, Date.now() - requestStartedAt);
          bytes += event.audio.length;
          if (bytes > env.VOICE_TTS_LOOKAHEAD_MAX_BYTES_PER_SEGMENT) {
            throw Object.assign(new AppError(413,
              'Look-ahead TTS audio exceeded the per-segment memory limit',
              'TTS_LOOKAHEAD_BUFFER_LIMIT_EXCEEDED', {
                generationId, maximumBytes: env.VOICE_TTS_LOOKAHEAD_MAX_BYTES_PER_SEGMENT,
              }), { retryable: false });
          }
          chunks.push(Buffer.from(event.audio));
        } else if (event.type === 'usage') this.usageTracker.record('tts', event.usage);
        else if (event.type === 'completed') {
          completed = true;
          const { speed, sample } = this.#recordTtsSpeed(text, generationId, event.usage, {
            ...options, audioStarted: false, bufferedLookahead: true, requestStartedAt,
          });
          if (speed.abnormal) {
            throw Object.assign(new AppError(502,
              'Look-ahead TTS provider generated audio at an abnormal speed',
              'TTS_ABNORMAL_SPEED', sample), { retryable: true, audioStarted: false });
          }
        } else if (event.type === 'cancelled') {
          this.#recordTtsGeneration({
            generationId, attempt: options.attempt,
            bufferedLookahead: true, outcome: 'cancelled',
            generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
          });
          generationRecorded = true;
          return { cancelled: true, chunks: [], bytes: 0 };
        }
        else if (event.type === 'error') {
          throw Object.assign(new Error(event.message), {
            code: event.code, retryable: event.retryable, audioStarted: false,
          });
        }
      }
      if (!completed || !chunks.length) {
        throw Object.assign(new AppError(502,
          'Look-ahead TTS stream ended without complete audio', 'TTS_LOOKAHEAD_STREAM_INCOMPLETE'),
        { retryable: true, audioStarted: false });
      }
      this.#recordTtsGeneration({
        generationId, attempt: options.attempt,
        bufferedLookahead: true, outcome: 'completed',
        generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs,
      });
      generationRecorded = true;
      return {
        cancelled: false,
        chunks,
        bytes,
        audio: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
        preparedAt: Date.now(),
      };
    } catch (error) {
      if (!generationRecorded) this.#recordTtsGeneration({
        generationId, attempt: options.attempt,
        bufferedLookahead: true, outcome: 'failed',
        generationMs: Date.now() - requestStartedAt, firstAudioLatencyMs, error,
      });
      this.#recordProviderFailure('tts', error, 'tts.lookahead');
      throw error;
    } finally {
      if (adapter) this.activeLookaheadTtsAdapters.delete(adapter);
      try {
        await adapter?.close();
      } catch (closeError) {
        this.log.warn({
          err: closeError, stage: 'tts.lookahead_adapter_close_failed',
          callId: this.call.id, generationId,
        }, 'Isolated look-ahead TTS adapter did not close cleanly');
      }
    }
  }

  async #prefetchTts(text, generationId, options = {}) {
    const pronunciation = this.pronunciationProcessor?.process(text)
      ?? { text, changed: false, replacementCount: 0, appliedRuleIds: [] };
    if (!await this.#reserveTtsCharacters(pronunciation.text, generationId)) {
      return { cancelled: true, chunks: [], bytes: 0 };
    }
    let lastError;
    const maximumAttempts = Math.max(env.VOICE_PROVIDER_MAX_RETRIES, env.TTS_SPEED_MAX_RETRIES);
    for (let attempt = 0; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#prefetchTtsAttempt(pronunciation.text, generationId, {
          ...options, attempt,
        });
      } catch (error) {
        lastError = error;
        const retryLimit = error?.code === 'TTS_ABNORMAL_SPEED'
          ? env.TTS_SPEED_MAX_RETRIES : env.VOICE_PROVIDER_MAX_RETRIES;
        const canRetry = error?.retryable === true && attempt < retryLimit
          && !this.finalized && options.epoch === this.epoch;
        if (!canRetry) throw error;
        if (error?.code === 'TTS_ABNORMAL_SPEED') this.runtimeMetrics.ttsSpeed.retries += 1;
        const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async #playPrefetchedTts(prepared, generationId, options = {}) {
    if (prepared?.cancelled || this.finalized || options.epoch !== this.epoch) return false;
    this.audioEngine.beginOutputGeneration(generationId, options.playbackGroupId ?? generationId);
    const audio = prepared.audio ?? (prepared.chunks?.length === 1
      ? prepared.chunks[0] : Buffer.concat(prepared.chunks ?? []));
    if (!audio.length || this.finalized || options.epoch !== this.epoch) return false;
    if (!await this.audioEngine.enqueueSynthesized(audio, generationId)) return false;
    await this.audioEngine.flushSynthesized(generationId, {
      finalizeGroup: options.deferBoundaryFlush !== true,
    });
    return true;
  }

  async #synthesize(text, generationId, options = {}) {
    const pronunciation = this.pronunciationProcessor?.process(text)
      ?? { text, changed: false, replacementCount: 0, appliedRuleIds: [] };
    if (pronunciation.changed) {
      this.log.debug({
        stage: 'tts.pronunciation_applied',
        callId: this.call.id,
        replacementCount: pronunciation.replacementCount,
        appliedRuleIds: pronunciation.appliedRuleIds,
      }, 'Selected pronunciation rules applied to TTS audio text');
    }
    if (!options.charactersReserved
      && !await this.#reserveTtsCharacters(pronunciation.text, generationId)) return false;
    let lastError;
    const maximumAttempts = Math.max(env.VOICE_PROVIDER_MAX_RETRIES, env.TTS_SPEED_MAX_RETRIES);
    for (let attempt = 0; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#synthesizeAttempt(pronunciation.text, generationId, { ...options, attempt });
      } catch (error) {
        lastError = error;
        const retryLimit = error?.code === 'TTS_ABNORMAL_SPEED'
          ? env.TTS_SPEED_MAX_RETRIES : env.VOICE_PROVIDER_MAX_RETRIES;
        const canRetry = error?.retryable === true && error.audioStarted !== true
          && attempt < retryLimit;
        if (!canRetry) throw error;
        if (error?.code === 'TTS_ABNORMAL_SPEED') this.runtimeMetrics.ttsSpeed.retries += 1;
        if (options.capture) options.capture.length = 0;
        const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
        this.log.warn({
          stage: 'tts.retry', attempt: attempt + 1, delayMs,
          reason: error?.code ?? 'TTS_PROVIDER_ERROR',
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
    if (this.activeCancellationPromise) return this.activeCancellationPromise;
    const operation = (async () => {
      const cancelledEpoch = this.epoch;
      this.epoch += 1;
      this.runtimeMetrics.interruptions.cancellationEpochs += 1;
      this.runtimeMetrics.interruptions.cancellationCalls += 1;
      this.cancelledEpochs.add(cancelledEpoch);
      // Keep a small bounded history for explicit late-event diagnostics.
      while (this.cancelledEpochs.size > 32) this.cancelledEpochs.delete(this.cancelledEpochs.values().next().value);

      // Clear queued and already-dequeued Plivo audio first. Provider shutdown
      // can take time and must never allow stale speech to continue meanwhile.
      const audioCancellation = this.audioEngine?.cancelStaleAudio?.(reason);
      this.runtimeMetrics.interruptions.clearedAudioFrames += Number(audioCancellation?.removedFrames ?? 0);
      let cancelledLookaheadJobs = 0;
      for (const cancelScheduler of this.activeLookaheadSchedulers) {
        cancelledLookaheadJobs += Number(cancelScheduler(reason) ?? 0);
      }

      const cancellables = new Set([
        this.activeLlm,
        this.adapters?.llm,
        this.adapters?.tts,
        ...this.activeLookaheadTtsAdapters,
      ].filter((candidate) => typeof candidate?.cancel === 'function'));
      await Promise.allSettled([...cancellables].map((candidate) => (
        Promise.resolve().then(() => candidate.cancel(reason))
      )));

      this.log.info({
        stage: 'audio.turn_cancelled', callId: this.call.id, reason,
        cancelledEpoch, epoch: this.epoch, removedFrames: audioCancellation?.removedFrames ?? 0,
        cancellationVersion: audioCancellation?.cancellationVersion ?? null,
        cancelledLookaheadJobs,
      }, 'Cancelled active voice turn and cleared all stale Plivo audio');
      this.#recordInterruptionTrace('generation_cancelled', {
        reason, cancelledEpoch, nextEpoch: this.epoch,
        removedFrames: audioCancellation?.removedFrames ?? 0,
        cancellationVersion: audioCancellation?.cancellationVersion ?? null,
        cancelledLookaheadJobs,
      });
      if (transition && this.controller
        && [callStates.GREETING, callStates.THINKING, callStates.SPEAKING]
          .includes(this.controller.state)) await this.controller.interrupt(reason);
    })();
    this.activeCancellationPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.activeCancellationPromise === operation) this.activeCancellationPromise = null;
    }
  }

  #clearInactivity() {
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  #clearCallDuration() {
    const clearTimer = this.dependencies.clearCallDurationTimer ?? clearTimeout;
    clearTimer(this.callDurationTimer);
    this.callDurationTimer = null;
  }

  #armCallDuration() {
    this.#clearCallDuration();
    const minutes = Number(this.runtimeProfile.limits?.maxCallDurationMinutes ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const durationMs = minutes * 60_000;
    const setTimer = this.dependencies.setCallDurationTimer ?? setTimeout;
    this.callDurationTimer = setTimer(() => void this.#guard('maximum_call_duration', async () => {
      if (this.finalized) return;
      this.runtimeMetrics.ttsLimits.durationLimitReached = true;
      this.log.info({
        stage: 'call.maximum_duration_reached', callId: this.call.id, maximumCallDurationMinutes: minutes,
      }, 'Maximum configured call duration reached');
      await this.#close('maximum_duration_reached', { speakClosing: false });
    }), durationMs);
    this.callDurationTimer?.unref?.();
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
    const message = this.#fitTtsMessage(action.text);
    await this.controller.setAssistantResponse(message, Date.now(), {
      sources: [createMessageSource(messageSourceTypes.SILENT_MESSAGE, {
        id: this.runtimeProfile.agent.id,
        label: 'Silent Message',
      })],
    });
    const epoch = ++this.epoch;
    await this.#synthesize(message, `silence-${epoch}`);
    if (epoch === this.epoch && this.controller.state === callStates.SPEAKING) {
      await this.controller.playbackComplete();
      this.#armInactivity();
    }
  }

  async #closingMessage(reason) {
    const closing = resolvePostCallClosingConfiguration({
      ...this.runtimeProfile.agent.settings,
      ...this.runtimeProfile.integrations?.postCall,
    });
    if (closing.messageType === 'None') return { text: '', sources: [] };
    const closingSource = createMessageSource(messageSourceTypes.POST_CALL_CLOSING, {
      id: this.runtimeProfile.agent.id,
      label: `${closing.messageType} closing`,
      metadata: { reason },
    });
    if (closing.messageType === 'Static') return { text: closing.staticMessage, sources: [closingSource] };
    try {
      const response = await this.#llm(
        `End the call now. Reason: ${reason}. Generate exactly one brief natural closing sentence. Closing instruction: ${closing.prompt}`,
        this.controller.history,
        { route: 'none', found: false },
        { closingReason: reason },
      );
      return {
        text: response.text || fallbackClosing(this.runtimeProfile),
        sources: mergeMessageSources(closingSource, this.#baseLlmSources(), response.sources),
      };
    } catch {
      return {
        text: fallbackClosing(this.runtimeProfile),
        sources: mergeMessageSources(closingSource, createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
          label: 'Closing fallback',
        })),
      };
    }
  }

  async #close(reason, options = {}) {
    if (this.closing || this.finalized) return;
    this.closing = true;
    this.#clearInactivity();
    await this.#cancelActive(reason);
    await this.controller.requestClose(reason);
    const closing = options.speakClosing === false
      ? { text: '', sources: [] }
      : await this.#closingMessage(reason);
    const closingText = closing.text ? this.#fitTtsMessage(closing.text) : '';
    if (closingText && !this.mediaSession.closed) {
      await this.controller.recordAssistantMessage(closingText, Date.now(), { sources: closing.sources });
      try {
        await this.#synthesize(closingText, `closing-${this.epoch}`);
        await this.audioEngine.drainOutput();
      } catch (error) {
        this.log.warn({ err: error, callId: this.call.id }, 'Post-Call closing audio failed');
      }
    }
    await this.#finalize('completed', reason);
    if (!this.mediaSession.closed) this.mediaSession.close(1000, reason);
  }

  async #recover(error, stage) {
    if (this.finalized) return;
    this.errorCount += 1;
    const kind = stage === 'stt' ? 'stt' : (stage.startsWith('tts') || stage === 'audio_output' ? 'tts' : (stage.startsWith('llm') || stage === 'turn' ? 'llm' : null));
    this.#recordProviderFailure(
      stage === 'audio_output' ? 'audioTransport' : (kind ?? 'tts'),
      error,
      stage,
    );
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
        const message = this.#fitTtsMessage(fallbackRecovery(this.runtimeProfile));
        await this.controller.beginSystemResponse('error_recovery');
        await this.controller.setAssistantResponse(message, Date.now(), {
          sources: [createMessageSource(messageSourceTypes.RUNTIME_FALLBACK, {
            label: 'Error recovery message', metadata: { stage, errorCode: error?.code },
          })],
        });
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
    const callbackNeedsManualFollowUp = this.call.direction === 'outbound'
      && this.currentCallbackRequest?.detected === true
      && this.currentCallbackRequest?.resolved === false
      && this.currentCallbackRequest?.scheduled !== true;
    const finalOutcome = callbackNeedsManualFollowUp ? 'manual_follow_up_required' : outcome;
    const finalReason = callbackNeedsManualFollowUp ? 'callback_time_not_provided' : reason;
    this.finalized = true;
    this.#clearInactivity();
    this.#clearCallDuration();
    this.interruptionCandidate?.reset();
    this.epoch += 1;
    for (const cancelScheduler of this.activeLookaheadSchedulers) cancelScheduler(finalReason);
    this.activeLlm?.cancel(finalReason);
    this.adapters?.llm?.cancel?.(finalReason);
    this.adapters?.tts?.cancel?.(finalReason);
    for (const adapter of this.activeLookaheadTtsAdapters) adapter.cancel?.(finalReason);
    this.unsubscribeStt?.();
    this.runtimeMetrics.ambience = {
      enabled: Boolean(this.runtimeAmbience),
      assetId: this.runtimeAmbience?.id ?? null,
      cacheHit: this.runtimeAmbience?.cacheHit ?? false,
      ...(this.audioEngine?.ambienceMetrics?.() ?? {}),
    };
    await this.audioEngine?.close?.();
    const transcriptPersistence = await this.transcriptPersistence?.flush?.();
    if (transcriptPersistence) {
      this.runtimeMetrics.transcriptPersistence = transcriptPersistence;
    }
    await this.#saveConversationMemory(finalOutcome, finalReason);
    if (this.contextCachePolicy?.deleteOnCallEnd && this.contextStore?.delete) {
      try {
        await this.contextStore.delete(this.contextCachePolicy.key);
      } catch (error) {
        this.log.warn({
          err: error, stage: 'context.session_cleanup', callId: this.call.id,
        }, 'Session-only conversation context cleanup failed');
      }
    }
    if (!this.controller || !this.runtimeProfile || !this.usageTracker) {
      try {
        await (this.dependencies.completeCallWithoutRuntime ?? completeVoiceCallWithoutRuntime)({
          callId: this.call.id,
          outcome: finalOutcome,
          reason: finalReason,
        }, this.dependencies.completionDependencies ?? {});
      } catch (error) {
        this.log.error({ err: error, callId: this.call.id },
          'Pre-runtime voice call finalization failed');
      }
      return;
    }
    this.log.info({
      stage: 'tts.speed_summary', callId: this.call.id,
      measured: this.runtimeMetrics.ttsSpeed?.measured ?? 0,
      normal: this.runtimeMetrics.ttsSpeed?.normal ?? 0,
      abnormal: this.runtimeMetrics.ttsSpeed?.abnormal ?? 0,
      tooFast: this.runtimeMetrics.ttsSpeed?.tooFast ?? 0,
      tooSlow: this.runtimeMetrics.ttsSpeed?.tooSlow ?? 0,
      retries: this.runtimeMetrics.ttsSpeed?.retries ?? 0,
      retriesSuppressedAfterAudio: this.runtimeMetrics.ttsSpeed?.retriesSuppressedAfterAudio ?? 0,
    }, 'TTS speed monitoring summary');
    this.log.info({
      stage: 'audio.continuity_summary', callId: this.call.id,
      underruns: this.runtimeMetrics.audioContinuity?.underruns ?? 0,
      totalUnderrunMs: this.runtimeMetrics.audioContinuity?.totalUnderrunMs ?? 0,
      maximumGapMs: this.runtimeMetrics.audioContinuity?.maximumGapMs ?? 0,
      playbackDeadlineMisses: this.runtimeMetrics.audioContinuity?.playbackDeadlineMisses ?? 0,
      maximumSchedulingDelayMs: this.runtimeMetrics.audioContinuity?.maximumSchedulingDelayMs ?? 0,
      websocketDeliveries: this.runtimeMetrics.audioContinuity?.websocketDeliveries ?? 0,
      averageWebsocketDeliveryMs: this.runtimeMetrics.audioContinuity?.websocketDeliveries
        ? Math.round((this.runtimeMetrics.audioContinuity.totalWebsocketDeliveryMs
          / this.runtimeMetrics.audioContinuity.websocketDeliveries) * 100) / 100 : 0,
      maximumWebsocketDeliveryMs: this.runtimeMetrics.audioContinuity?.maximumWebsocketDeliveryMs ?? 0,
      slowWebsocketDeliveries: this.runtimeMetrics.audioContinuity?.slowWebsocketDeliveries ?? 0,
      websocketBackpressureEvents: this.runtimeMetrics.audioContinuity?.websocketBackpressureEvents ?? 0,
      maximumWebsocketBufferedBytes: this.runtimeMetrics.audioContinuity?.maximumWebsocketBufferedBytes ?? 0,
      sentenceBoundaries: this.runtimeMetrics.audioContinuity?.sentenceBoundaries ?? 0,
      smoothedBoundaries: this.runtimeMetrics.audioContinuity?.smoothedBoundaries ?? 0,
      minimumBufferedAudioMs: this.runtimeMetrics.audioContinuity?.minimumBufferedAudioMs ?? null,
      groupedTtsRequests: this.runtimeMetrics.sentenceGrouping?.multiSentenceGroups ?? 0,
    }, 'Voice playback continuity summary');
    this.log.info({
      stage: 'tts.lookahead_summary', callId: this.call.id,
      enabled: this.runtimeMetrics.ttsLookahead?.enabled ?? false,
      concurrency: this.runtimeMetrics.ttsLookahead?.concurrency ?? 0,
      scheduled: this.runtimeMetrics.ttsLookahead?.scheduled ?? 0,
      completed: this.runtimeMetrics.ttsLookahead?.completed ?? 0,
      cancelled: this.runtimeMetrics.ttsLookahead?.cancelled ?? 0,
      failed: this.runtimeMetrics.ttsLookahead?.failed ?? 0,
      readyBeforePlayback: this.runtimeMetrics.ttsLookahead?.readyBeforePlayback ?? 0,
      waitedAtPlayback: this.runtimeMetrics.ttsLookahead?.waitedAtPlayback ?? 0,
      successfulHandoffs: this.runtimeMetrics.ttsLookahead?.successfulHandoffs ?? 0,
      sequentialFallbacks: this.runtimeMetrics.ttsLookahead?.sequentialFallbacks ?? 0,
      isolatedFailures: this.runtimeMetrics.ttsLookahead?.isolatedFailures ?? 0,
      partialTurnsPreserved: this.runtimeMetrics.ttsLookahead?.partialTurnsPreserved ?? 0,
      bufferedBytes: this.runtimeMetrics.ttsLookahead?.bufferedBytes ?? 0,
      maximumSegmentBytes: this.runtimeMetrics.ttsLookahead?.maximumSegmentBytes ?? 0,
    }, 'Ordered TTS look-ahead summary');
    this.log.info({
      stage: 'tts.generation_summary', callId: this.call.id,
      requests: this.runtimeMetrics.ttsGeneration?.requests ?? 0,
      completed: this.runtimeMetrics.ttsGeneration?.completed ?? 0,
      failed: this.runtimeMetrics.ttsGeneration?.failed ?? 0,
      cancelled: this.runtimeMetrics.ttsGeneration?.cancelled ?? 0,
      averageFirstAudioLatencyMs: this.runtimeMetrics.ttsGeneration?.firstAudioSamples
        ? Math.round((this.runtimeMetrics.ttsGeneration.totalFirstAudioLatencyMs
          / this.runtimeMetrics.ttsGeneration.firstAudioSamples) * 100) / 100 : 0,
      maximumFirstAudioLatencyMs: this.runtimeMetrics.ttsGeneration?.maximumFirstAudioLatencyMs ?? 0,
      averageGenerationMs: this.runtimeMetrics.ttsGeneration?.requests
        ? Math.round((this.runtimeMetrics.ttsGeneration.totalGenerationMs
          / this.runtimeMetrics.ttsGeneration.requests) * 100) / 100 : 0,
      maximumGenerationMs: this.runtimeMetrics.ttsGeneration?.maximumGenerationMs ?? 0,
      sentenceHandoffWaits: this.runtimeMetrics.ttsGeneration?.sentenceHandoffWaits ?? 0,
      maximumSentenceHandoffWaitMs: this.runtimeMetrics.ttsGeneration?.maximumSentenceHandoffWaitMs ?? 0,
    }, 'TTS generation and sentence handoff summary');
    this.log.info({
      stage: 'provider.failure_summary', callId: this.call.id,
      total: this.runtimeMetrics.providerFailures?.total ?? 0,
      stt: this.runtimeMetrics.providerFailures?.stt ?? 0,
      llm: this.runtimeMetrics.providerFailures?.llm ?? 0,
      tts: this.runtimeMetrics.providerFailures?.tts ?? 0,
      audioTransport: this.runtimeMetrics.providerFailures?.audioTransport ?? 0,
    }, 'Voice provider failure summary');
    try {
      await (this.dependencies.completeCall ?? completeVoiceCall)({
        controller: this.controller,
        runtimeProfile: this.runtimeProfile,
        usageTracker: this.usageTracker,
        adapters: this.adapters ?? {},
        outcome: finalOutcome,
        reason: finalReason,
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
