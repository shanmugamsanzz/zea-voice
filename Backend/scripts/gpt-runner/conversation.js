import { SessionClient } from './session-client.js';
import { MediaClient } from './media-client.js';
import { RunnerError, bounded } from './errors.js';
import { buildReport } from './report.js';
export async function runConversation({ config, scenario, caller, allowSessionRecords = false, signal, mode = 'live', dependencies = {} }) {
  if (mode === 'live' && allowSessionRecords !== true) throw new RunnerError('DATABASE_WRITE_NOT_AUTHORIZED', 'Live sessions create normal database records; explicit permission is required.');
  if (mode === 'simulation' && (!dependencies.sessionClient || !dependencies.mediaFactory)) throw new RunnerError('SIMULATION_DEPENDENCIES', 'Simulation requires explicitly injected test session and media clients.');
  if (!['live', 'simulation'].includes(mode)) throw new RunnerError('EVIDENCE_MODE', 'Conversation mode is invalid.');
  const sessionClient = dependencies.sessionClient ?? new SessionClient(config);
  let media; let session; let failure; let cleanup = 'not-needed';
  const generated = [];
  try {
    const details = await sessionClient.lookup(signal);
    session = await sessionClient.create(details, signal);
    media = dependencies.mediaFactory ? dependencies.mediaFactory(config, session) : new MediaClient(config, session);
    await media.connect(signal);
    let afterSequence = 0;
    // Start with an opening. If the target initiates, consume its actual welcome first.
    if (dependencies.agentInitiates !== false) {
      try { await media.waitForAgentTurn(0, signal, 20000); }
      catch (error) { if (error.code !== 'TURN_TIMEOUT') throw error; }
      afterSequence = Math.max(0, ...media.transcripts.map((line) => line.sequenceNumber));
    }
    for (let turn = 0; turn < config.maxTurns; turn += 1) {
      const decision = await caller.next(media.transcripts, signal);
      if (decision.done) break;
      const audio = await caller.audio(decision.question, signal);
      generated.push({ turn: turn + 1, text: decision.question, afterSequence });
      // Register the waiter before streaming: fast responses cannot race past registration.
      const response = media.waitForAgentTurn(afterSequence, signal);
      response.catch(() => {}); // Observed below; prevents transient unhandled rejection during streaming.
      await media.sendUtterance(audio, signal); await response;
      afterSequence = Math.max(afterSequence, ...media.transcripts.map((line) => line.sequenceNumber));
    }
  } catch (error) { failure = error; }
  finally {
    await media?.close().catch(() => {});
    if (session) {
      try { await sessionClient.end(session.testCallId); cleanup = 'requested'; }
      catch { cleanup = 'failed'; }
    }
    try { await bounded(() => caller.close(), { timeoutMs: 3000 }); } catch { cleanup += '; caller-close-unverified'; }
  }
  return { report: buildReport({ mode, scenario, generated, transcripts: media?.transcripts ?? [],
    diagnostics: media?.diagnostics ?? [], failure, cleanup, expectedFacts: scenario.expectedFacts, secrets: [config.shareToken, session?.token] }),
    incoming: Buffer.concat(media?.outputFrames ?? []), outgoing: Buffer.concat(media?.inputFrames ?? []) };
}


