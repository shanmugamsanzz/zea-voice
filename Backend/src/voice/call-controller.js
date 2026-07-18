import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { CallStateMachine, callStates } from './call-state-machine.js';

const noOp = async () => {};

export class CallController {
  #profile;
  #hooks;
  #history = [];
  #transcriptSequence = 0;
  #silenceCount = 0;
  #lastActivityAt;
  #closed = false;

  constructor({ callSession, runtimeProfile, hooks = {}, now = Date.now() }) {
    if (!callSession?.id || !runtimeProfile?.agent?.id) throw new TypeError('Call session and runtime profile are required');
    this.callSession = { ...callSession };
    this.#profile = runtimeProfile;
    this.#hooks = {
      onStateChange: hooks.onStateChange ?? noOp,
      onTranscript: hooks.onTranscript ?? noOp,
      onInterrupt: hooks.onInterrupt ?? noOp,
      onCleanup: hooks.onCleanup ?? noOp,
    };
    this.stateMachine = new CallStateMachine({ now });
    this.#lastActivityAt = now;
  }

  get state() { return this.stateMachine.state; }
  get terminal() { return this.stateMachine.terminal; }
  get history() { return this.#history.map((message) => ({ ...message })); }
  get lastActivityAt() { return this.#lastActivityAt; }

  snapshot() {
    return {
      callId: this.callSession.id,
      providerCallId: this.callSession.providerCallId,
      agentId: this.#profile.agent.id,
      state: this.state,
      terminal: this.terminal,
      silenceCount: this.#silenceCount,
      transcriptSequence: this.#transcriptSequence,
      history: this.history,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  async #transition(next, reason, now = Date.now()) {
    const previous = this.state;
    this.stateMachine.transition(next, reason, { now });
    this.#lastActivityAt = now;
    await this.#hooks.onStateChange({ callId: this.callSession.id, previous, current: next, reason, at: now });
  }

  async #append(role, text, now = Date.now()) {
    const normalized = String(text ?? '').trim();
    if (!normalized) throw new AppError(400, 'Conversation message cannot be empty', 'VOICE_MESSAGE_EMPTY');
    this.#transcriptSequence += 1;
    const speaker = role === 'assistant' ? 'agent' : 'user';
    const entry = { sequenceNumber: this.#transcriptSequence, speaker, text: normalized, isFinal: true, at: now };
    this.#history.push({ role, content: normalized });
    this.#history = this.#history.slice(-env.LLM_MAX_HISTORY_MESSAGES);
    this.#lastActivityAt = now;
    await this.#hooks.onTranscript({ callId: this.callSession.id, ...entry });
    return entry;
  }

  async initialize(now = Date.now()) {
    const welcome = String(this.#profile.agent.welcomeMessage ?? '').trim();
    if (welcome) {
      await this.#transition(callStates.GREETING, 'welcome_message', now);
      const transcript = await this.#append('assistant', welcome, now);
      return { action: 'speak', text: welcome, transcript };
    }
    await this.#transition(callStates.LISTENING, 'ready_without_greeting', now);
    return { action: 'listen' };
  }

  async greetingComplete(now = Date.now()) {
    await this.#transition(callStates.LISTENING, 'greeting_completed', now);
    return { action: 'listen' };
  }

  async receiveFinalTranscript(text, now = Date.now()) {
    if (this.state === callStates.SPEAKING) await this.interrupt('caller_barge_in', now);
    if (this.state !== callStates.LISTENING) {
      throw new AppError(409, 'Call is not ready for a caller transcript', 'VOICE_CALL_NOT_LISTENING');
    }
    this.#silenceCount = 0;
    const transcript = await this.#append('user', text, now);
    await this.#transition(callStates.THINKING, 'caller_transcript_final', now);
    return { action: 'generate_response', transcript, history: this.history };
  }

  async setAssistantResponse(text, now = Date.now()) {
    if (this.state !== callStates.THINKING) {
      throw new AppError(409, 'Call is not waiting for an assistant response', 'VOICE_CALL_NOT_THINKING');
    }
    const transcript = await this.#append('assistant', text, now);
    await this.#transition(callStates.SPEAKING, 'assistant_response_ready', now);
    return { action: 'speak', text: transcript.text, transcript };
  }

  async playbackComplete(now = Date.now()) {
    await this.#transition(callStates.LISTENING, 'playback_completed', now);
    return { action: 'listen' };
  }

  async interrupt(reason = 'caller_barge_in', now = Date.now()) {
    if (this.state !== callStates.SPEAKING) return { action: 'none' };
    await this.#hooks.onInterrupt({ callId: this.callSession.id, reason, at: now });
    await this.#transition(callStates.LISTENING, reason, now);
    return { action: 'cancel_playback' };
  }

  async handleSilence(now = Date.now()) {
    if (this.state !== callStates.LISTENING) return { action: 'none' };
    this.#silenceCount += 1;
    const maxPrompts = Number(this.#profile.agent.settings?.maxInactivityPrompts ?? 1);
    const message = String(this.#profile.agent.settings?.silentMessage ?? '').trim();
    if (this.#silenceCount <= maxPrompts && message) {
      await this.#transition(callStates.THINKING, 'inactivity_prompt', now);
      return { action: 'inactivity_response', text: message, silenceCount: this.#silenceCount };
    }
    await this.#transition(callStates.CLOSING, 'inactivity_limit_reached', now);
    return { action: 'close', reason: 'inactivity_limit_reached' };
  }

  async requestClose(reason = 'requested', now = Date.now()) {
    if (this.terminal || this.state === callStates.CLOSING) return { action: 'none' };
    await this.#transition(callStates.CLOSING, reason, now);
    return { action: 'close', reason };
  }

  async complete(reason = 'completed', now = Date.now()) {
    if (this.state !== callStates.CLOSING) await this.requestClose(reason, now);
    await this.#transition(callStates.COMPLETED, reason, now);
    await this.#cleanup(reason, now);
    return this.snapshot();
  }

  async fail(reason = 'failed', now = Date.now()) {
    if (this.terminal) return this.snapshot();
    await this.#transition(callStates.FAILED, reason, now);
    await this.#cleanup(reason, now);
    return this.snapshot();
  }

  async #cleanup(reason, now) {
    if (this.#closed) return;
    this.#closed = true;
    await this.#hooks.onCleanup({ callId: this.callSession.id, state: this.state, reason, at: now });
  }
}
