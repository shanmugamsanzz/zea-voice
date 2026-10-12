export class CallerTurnWait {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.version = 0;
  }
  get pending() { return this.timer !== null; }
  cancel() {
    const pending = this.pending;
    if (pending) this.clearTimer(this.timer);
    this.timer = null;
    this.version += 1;
    return pending;
  }
  schedule(delayMs, callback) {
    this.cancel();
    const version = this.version;
    this.timer = this.setTimer(() => {
      if (version !== this.version) return;
      this.timer = null;
      callback();
    }, delayMs);
  }
}
