import { spawn } from 'node:child_process';
import { AppError } from '../middleware/errors.js';

export const AMBIENCE_RUNTIME_FORMAT = Object.freeze({
  encoding: 'mulaw',
  sampleRate: 8000,
  channels: 1,
  frameDurationMs: 20,
});

export function ambienceNormalizedObjectKey({ tenantId, workspaceId, assetId, checksumSha256 }) {
  return `ambience/${tenantId}/${workspaceId}/${assetId}/normalized/mulaw-8000-mono/${checksumSha256}.ulaw`;
}

export function normalizeAmbienceAudio(source, options = {}) {
  if (!Buffer.isBuffer(source) || !source.length) throw new TypeError('Ambience source audio must be a non-empty Buffer');
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 3_000_000;
  return new Promise((resolve, reject) => {
    const process = spawnProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-map_metadata', '-1', '-vn',
      '-ac', '1', '-ar', '8000', '-f', 'mulaw', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    const errors = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => {
      process.kill('SIGKILL');
      finish(new AppError(504, 'Ambience audio preprocessing timed out', 'AMBIENCE_PREPROCESS_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    process.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        process.kill('SIGKILL');
        finish(new AppError(413, 'Normalized ambience audio exceeds the runtime limit', 'AMBIENCE_NORMALIZED_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    process.stderr.on('data', (chunk) => {
      if (Buffer.concat(errors).length < 4096) errors.push(chunk);
    });
    process.on('error', (error) => {
      finish(new AppError(
        503,
        error.code === 'ENOENT'
          ? 'FFmpeg is unavailable for ambience audio preprocessing'
          : 'Ambience audio preprocessing could not start',
        'AMBIENCE_PREPROCESSOR_UNAVAILABLE',
      ));
    });
    process.on('close', (code) => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      if (code !== 0 || !output.length) {
        finish(new AppError(400, `Ambience audio could not be decoded${errors.length ? `: ${Buffer.concat(errors).toString('utf8').trim().slice(0, 300)}` : ''}`, 'AMBIENCE_AUDIO_DECODE_FAILED'));
        return;
      }
      finish(null, output);
    });
    process.stdin.on('error', () => {});
    process.stdin.end(source);
  });
}
