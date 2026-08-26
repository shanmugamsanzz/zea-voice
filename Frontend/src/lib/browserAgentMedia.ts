export interface BrowserTestSessionContract {
  testCallId: string;
  callId: string;
  token: string;
  mediaPath: string;
  protocol: string;
  expiresAt: string;
}

export type BrowserAgentMediaState =
  | 'idle' | 'requesting_microphone' | 'connecting' | 'connected' | 'closed' | 'failed';

const targetSampleRate = 8000;
const runtimeEnvironment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const defaultApiBaseUrl = (runtimeEnvironment?.VITE_API_BASE_URL
  || (typeof window === 'undefined' ? 'http://localhost:1112' : window.location.origin)).replace(/\/$/, '');

function bytesToBase64(bytes: Uint8Array) {
  let value = '';
  for (let index = 0; index < bytes.length; index += 1) value += String.fromCharCode(bytes[index]);
  return btoa(value);
}

function base64ToBytes(value: string) {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function linearToMuLaw(sample: number) {
  const bias = 0x84;
  const clip = 32635;
  let pcm = Math.max(-1, Math.min(1, sample));
  let integer = Math.round(pcm * 32767);
  const sign = integer < 0 ? 0x80 : 0;
  if (integer < 0) integer = -integer;
  integer = Math.min(clip, integer) + bias;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (integer & mask) === 0; exponent -= 1, mask >>= 1) {}
  const mantissa = (integer >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function muLawToLinear(value: number) {
  const decoded = (~value) & 0xff;
  const sign = decoded & 0x80;
  const exponent = (decoded >> 4) & 0x07;
  const mantissa = decoded & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return (sign ? -sample : sample) / 32768;
}

export function resampleToMuLaw(input: Float32Array, sourceRate: number) {
  if (!input.length || sourceRate <= 0) return new Uint8Array();
  const length = Math.max(1, Math.floor(input.length * targetSampleRate / sourceRate));
  const output = new Uint8Array(length);
  const ratio = sourceRate / targetSampleRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = linearToMuLaw(input[left] + (input[right] - input[left]) * fraction);
  }
  return output;
}

function websocketUrl(baseUrl: string, session: BrowserTestSessionContract) {
  const url = new URL(session.mediaPath, baseUrl || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('call_id', session.callId);
  url.searchParams.set('token', session.token);
  return url.toString();
}

export class BrowserAgentMediaClient extends EventTarget {
  state: BrowserAgentMediaState = 'idle';
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private microphone: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private playbackCursor = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private closedByClient = false;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private recordingBlob: Blob | null = null;
  private recordingPromise: Promise<Blob | null> | null = null;

  private setState(state: BrowserAgentMediaState, detail: Record<string, unknown> = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  async connect(session: BrowserTestSessionContract, apiBaseUrl = defaultApiBaseUrl) {
    if (this.state !== 'idle' && this.state !== 'closed' && this.state !== 'failed') {
      throw new Error('Browser agent media is already active');
    }
    this.closedByClient = false;
    this.setState('requesting_microphone');
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, video: false });
      this.context = new AudioContext({ latencyHint: 'interactive' });
      await this.context.resume();
      this.setState('connecting');
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(websocketUrl(apiBaseUrl, session), session.protocol);
        let settled = false;
        this.socket = socket;
        socket.onmessage = (message) => this.handleMessage(String(message.data));
        socket.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('Browser test media connection failed'));
          }
        };
        socket.onclose = (event) => {
          void this.finishSocketClose(event);
          if (!settled) {
            settled = true;
            reject(new Error(event.reason || 'Browser test media connection closed before ready'));
          }
        };
        const ready = (event: Event) => {
          this.removeEventListener('ready', ready);
          if (settled) return;
          settled = true;
          this.startMicrophoneCapture();
          this.setState('connected');
          resolve();
        };
        this.addEventListener('ready', ready);
      });
    } catch (error) {
      this.releaseMedia();
      this.setState('failed', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private send(event: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(event));
  }

  private startMicrophoneCapture() {
    if (!this.context || !this.microphone) return;
    this.source = this.context.createMediaStreamSource(this.microphone);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const encoded = resampleToMuLaw(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate);
      if (encoded.length) this.send({ event: 'media', media: {
        contentType: 'audio/x-mulaw', sampleRate: targetSampleRate,
        timestamp: performance.now(), payload: bytesToBase64(encoded),
      } });
    };
    this.source.connect(this.processor);
    this.startRecording();
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  private handleMessage(serialized: string) {
    let event: { event?: string; name?: string; media?: { payload?: string };
      diagnostic?: { type?: string; [key: string]: unknown } };
    try { event = JSON.parse(serialized); } catch { return; }
    if (event.event === 'ready') {
      this.dispatchEvent(new CustomEvent('ready', { detail: event }));
      return;
    }
    if (event.event === 'audio' && event.media?.payload) {
      this.playAudio(event.media.payload);
      return;
    }
    if (event.event === 'clearAudio') {
      this.clearPlayback();
      this.send({ event: 'clearedAudio' });
      return;
    }
    if (event.event === 'checkpoint') this.acknowledgeCheckpoint(event.name ?? null);
    if (event.event === 'diagnostic' && event.diagnostic?.type) {
      this.dispatchEvent(new CustomEvent('diagnostic', { detail: event.diagnostic }));
    }
  }

  private playAudio(payload: string) {
    if (!this.context) return;
    const encoded = base64ToBytes(payload);
    const buffer = this.context.createBuffer(1, encoded.length, targetSampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < encoded.length; index += 1) channel[index] = muLawToLinear(encoded[index]);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    if (this.recordingDestination) source.connect(this.recordingDestination);
    const startAt = Math.max(this.context.currentTime + 0.01, this.playbackCursor);
    this.playbackCursor = startAt + buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
    source.start(startAt);
    this.dispatchEvent(new CustomEvent('audio', { detail: { durationMs: buffer.duration * 1000 } }));
  }

  private acknowledgeCheckpoint(name: string | null) {
    if (!this.context) return;
    const waitMs = Math.max(0, (this.playbackCursor - this.context.currentTime) * 1000);
    window.setTimeout(() => this.send({ event: 'playedStream', name }), waitMs);
  }

  clearPlayback() {
    for (const source of this.playbackSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playbackSources.clear();
    if (this.context) this.playbackCursor = this.context.currentTime;
  }

  sendDtmf(digit: string) {
    this.send({ event: 'dtmf', dtmf: { digit } });
  }

  setMuted(muted: boolean) {
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
    this.dispatchEvent(new CustomEvent('mute', { detail: { muted } }));
  }

  private startRecording() {
    if (!this.context || !this.source || typeof MediaRecorder === 'undefined') return;
    this.recordingDestination = this.context.createMediaStreamDestination();
    this.source.connect(this.recordingDestination);
    const supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported(type));
    try {
      this.recorder = new MediaRecorder(this.recordingDestination.stream,
        supported ? { mimeType: supported } : undefined);
      this.recordingChunks = [];
      this.recordingBlob = null;
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.recordingChunks.push(event.data);
      };
      this.recorder.start(1000);
    } catch {
      this.recorder = null;
      this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
        type: 'recording_warning', message: 'This browser could not start test-call recording.',
      } }));
    }
  }

  private stopRecording() {
    if (this.recordingPromise) return this.recordingPromise;
    if (!this.recorder || this.recorder.state === 'inactive') return Promise.resolve(this.recordingBlob);
    this.recordingPromise = new Promise<Blob | null>((resolve) => {
      const recorder = this.recorder!;
      recorder.addEventListener('stop', () => {
        this.recordingBlob = this.recordingChunks.length
          ? new Blob(this.recordingChunks, { type: recorder.mimeType || 'audio/webm' }) : null;
        this.dispatchEvent(new CustomEvent('recording', { detail: { blob: this.recordingBlob } }));
        resolve(this.recordingBlob);
      }, { once: true });
      recorder.stop();
    });
    return this.recordingPromise;
  }

  private async finishSocketClose(event: CloseEvent) {
    await this.stopRecording();
    this.releaseMedia();
    if (this.closedByClient || event.code === 1000) this.setState('closed', { code: event.code });
    else this.setState('failed', { code: event.code, reason: event.reason });
  }

  async disconnect() {
    this.closedByClient = true;
    this.send({ event: 'stop' });
    this.socket?.close(1000, 'browser test ended');
    const recording = await this.stopRecording();
    this.releaseMedia();
    this.setState('closed');
    return recording;
  }

  private releaseMedia() {
    this.clearPlayback();
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch { /* disconnected */ }
    try { this.processor?.disconnect(); } catch { /* disconnected */ }
    try { this.silentGain?.disconnect(); } catch { /* disconnected */ }
    try { this.recordingDestination?.disconnect(); } catch { /* disconnected */ }
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.microphone = null;
    this.context = null;
    this.socket = null;
    this.recordingDestination = null;
  }
}
