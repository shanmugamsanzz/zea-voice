import { AppError } from '../middleware/errors.js';

export const callStates = Object.freeze({
  INITIALIZING: 'initializing',
  GREETING: 'greeting',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  CLOSING: 'closing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const transitions = new Map([
  [callStates.INITIALIZING, new Set([callStates.GREETING, callStates.LISTENING, callStates.CLOSING, callStates.FAILED])],
  [callStates.GREETING, new Set([callStates.LISTENING, callStates.CLOSING, callStates.FAILED])],
  [callStates.LISTENING, new Set([callStates.THINKING, callStates.CLOSING, callStates.FAILED])],
  [callStates.THINKING, new Set([callStates.SPEAKING, callStates.CLOSING, callStates.FAILED])],
  [callStates.SPEAKING, new Set([callStates.LISTENING, callStates.CLOSING, callStates.FAILED])],
  [callStates.CLOSING, new Set([callStates.COMPLETED, callStates.FAILED])],
  [callStates.COMPLETED, new Set()],
  [callStates.FAILED, new Set()],
]);

export class CallStateMachine {
  #state = callStates.INITIALIZING;
  #history = [];

  constructor(options = {}) {
    this.#history.push({ from: null, to: this.#state, reason: 'created', at: options.now ?? Date.now() });
  }

  get state() { return this.#state; }
  get terminal() { return this.#state === callStates.COMPLETED || this.#state === callStates.FAILED; }
  get history() { return this.#history.map((entry) => ({ ...entry })); }

  canTransition(next) {
    return transitions.get(this.#state)?.has(next) ?? false;
  }

  transition(next, reason, options = {}) {
    if (!Object.values(callStates).includes(next)) throw new TypeError(`Unknown call state: ${next}`);
    if (!this.canTransition(next)) {
      throw new AppError(409, `Call cannot transition from ${this.#state} to ${next}`, 'VOICE_CALL_STATE_INVALID', {
        currentState: this.#state, requestedState: next,
      });
    }
    const previous = this.#state;
    this.#state = next;
    this.#history.push({ from: previous, to: next, reason: reason ?? null, at: options.now ?? Date.now() });
    return this.#state;
  }
}
