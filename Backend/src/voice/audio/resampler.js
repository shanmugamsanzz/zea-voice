export class StreamingLinearResampler {
  #buffer = new Int16Array(0);
  #position = 0;

  constructor(inputRate, outputRate) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new TypeError('Resampler rates must be positive integers');
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;
  }

  push(samples) {
    if (!(samples instanceof Int16Array)) throw new TypeError('Resampler input must be an Int16Array');
    if (!samples.length) return new Int16Array(0);
    if (this.inputRate === this.outputRate) return samples;
    const combined = new Int16Array(this.#buffer.length + samples.length);
    combined.set(this.#buffer);
    combined.set(samples, this.#buffer.length);
    const output = [];
    while (this.#position < combined.length - 1) {
      const left = Math.floor(this.#position);
      const fraction = this.#position - left;
      output.push(Math.round(combined[left] + (combined[left + 1] - combined[left]) * fraction));
      this.#position += this.step;
    }
    const consumed = Math.floor(this.#position);
    this.#buffer = combined.slice(Math.min(consumed, combined.length));
    this.#position -= consumed;
    return Int16Array.from(output);
  }

  flush() {
    if (this.inputRate === this.outputRate || !this.#buffer.length) return new Int16Array(0);
    const output = [];
    while (this.#position < this.#buffer.length) {
      const left = Math.floor(this.#position);
      const right = Math.min(left + 1, this.#buffer.length - 1);
      const fraction = this.#position - left;
      output.push(Math.round(this.#buffer[left] + (this.#buffer[right] - this.#buffer[left]) * fraction));
      this.#position += this.step;
    }
    this.reset();
    return Int16Array.from(output);
  }

  reset() {
    this.#buffer = new Int16Array(0);
    this.#position = 0;
  }
}

export function resamplePcm16(samples, inputRate, outputRate) {
  const resampler = new StreamingLinearResampler(inputRate, outputRate);
  const first = resampler.push(samples);
  const final = resampler.flush();
  const output = new Int16Array(first.length + final.length);
  output.set(first);
  output.set(final, first.length);
  return output;
}
