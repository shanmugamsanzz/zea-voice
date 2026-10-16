import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errors.js';

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new AppError(503, 'Transfer music requires HTTPS', 'TRANSFER_PUBLIC_URL_REQUIRED');
  return url.origin;
}

export function transferMusicUrl(publicBaseUrl) {
  return `${origin(publicBaseUrl)}/webhooks/plivo/transfer-music`;
}

export function buildTransferMusicXml(publicBaseUrl) {
  // Existing original 8 kHz mono clip: no external asset, tenant data or credentials.
  return `<Response><Play loop="0">${origin(publicBaseUrl)}/webhooks/plivo/hold-music.wav?seconds=4</Play></Response>`;
}

export function waitForTransferPlayback(mediaSession, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const name = `transfer-announcement-${randomUUID()}`;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      for (const [event, handler] of listeners) mediaSession.off(event, handler);
    };
    const done = error => { cleanup(); error ? reject(error) : resolve({ name, confirmed: true }); };
    const stopped = () => done(new AppError(409, 'Call ended before announcement playback completed', 'TRANSFER_ANNOUNCEMENT_INTERRUPTED'));
    const played = event => { if (event.name === name) done(); };
    const listeners = [['playedStream', played], ['closed', stopped], ['stop', stopped], ['clearedAudio', stopped]];
    if (mediaSession.closed || typeof mediaSession.checkpoint !== 'function') {
      return done(new AppError(409, 'Transfer playback confirmation is unavailable', 'TRANSFER_ANNOUNCEMENT_UNAVAILABLE'));
    }
    for (const [event, handler] of listeners) mediaSession.on(event, handler);
    timer = setTimeout(() => done(new AppError(504, 'Transfer announcement playback was not confirmed', 'TRANSFER_ANNOUNCEMENT_TIMEOUT')), timeoutMs);
    try { mediaSession.checkpoint(name); } catch (error) { done(error); }
  });
}
