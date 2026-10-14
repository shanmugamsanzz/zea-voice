import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pcmWavFromMuLaw } from './audio.js';
import { RunnerError } from './errors.js';
export function sanitize(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter((item) => typeof item === 'string' && item.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/https?:\/\/\S+/gu, '[URL REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,}\b/gu, '[TOKEN REDACTED]')
    .replace(/\b(?:\+?\d[\s-]?){10,15}\b/gu, '[PHONE REDACTED]');
}
export function buildReport({ mode, scenario, generated = [], transcripts = [], diagnostics = [], failure, cleanup, expectedFacts = [], secrets = [] }) {
  if (!['live', 'simulation'].includes(mode)) throw new RunnerError('REPORT_MODE', 'Report requires explicit evidence mode.');
  const agentLines = transcripts.filter((line) => line.speaker === 'agent');
  const findings = [];
  for (const turn of generated) {
    const reply = agentLines.find((line) => line.sequenceNumber > (turn.afterSequence ?? 0));
    if (!reply) findings.push({ category: 'conversation', certainty: 'observed', turn: turn.turn, issue: 'No corresponding agent transcript observed.' });
  }
  for (const diagnostic of diagnostics.filter((item) => item.type === 'error')) findings.push({
    category: 'runtime', certainty: 'observed', issue: sanitize(diagnostic.message ?? 'Runtime error observed.', secrets),
  });
  // Deterministic presence checks are evidence checks, not semantic truth validation.
  for (const fact of expectedFacts) {
    if (typeof fact !== 'string' || !fact.trim()) continue;
    if (!agentLines.some((line) => line.text.toLocaleLowerCase().includes(fact.toLocaleLowerCase()))) findings.push({
      category: 'expected-evidence', certainty: 'needs-review', issue: 'An expected fixture phrase was not observed.',
    });
  }
  const latencies = diagnostics.filter((item) => item.type === 'latency' && Number.isFinite(item.totalFirstAudioMs)).map((item) => item.totalFirstAudioMs).sort((a,b) => a-b);
  return {
    mode, liveTestVerified: mode === 'live' && !failure && cleanup === 'requested' && generated.length > 0
      && transcripts.some((line) => line.speaker === 'user')
      && agentLines.some((line) => line.sequenceNumber > (generated[0]?.afterSequence ?? 0)),
    scenarioId: scenario.id, language: scenario.language, generatedTurns: generated.length,
    failure: failure ? { code: failure.code ?? 'UNEXPECTED_FAILURE', message: sanitize(failure instanceof RunnerError ? failure.message : 'Operation failed; private details omitted.', secrets) } : null,
    cleanup: cleanup ?? 'not-applicable',
    runtimeEvents: diagnostics.filter((event) => ['state', 'barge_in', 'error'].includes(event.type)).map((event) => ({ type: event.type, previous: event.previous, current: event.current, reason: sanitize(event.reason, secrets), message: sanitize(event.message, secrets) })),
    transcripts: transcripts.map(({ speaker, text, sequenceNumber, offsetMs }) => ({ speaker, text: sanitize(text, secrets), sequenceNumber, offsetMs })),
    callerQuestions: generated.map(({ turn, text }) => ({ turn, text: sanitize(text, secrets) })),
    findings,
    latency: { samples: latencies.length, medianMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
      p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null },
    toolVerification: 'unverified; spoken confirmation is not execution evidence',
    answerAccuracy: 'requires comparison to approved knowledge and workflow; not certified',
    pronunciation: 'not automatically certified; review recorded audio',
    limitations: mode === 'simulation' ? ['Simulated audio and replies; no real agent, provider, database, or live acceptance tested.'] : ['Transcript is target-generated, not independent audio recognition.', 'Report findings do not prove every factual claim is supported.'],
  };
}
export async function writeReport(outputDirectory, report, { incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0), recordAudio = false } = {}) {
  // A fresh child prevents overwrite of existing evidence and keeps generated files together.
  const directory = path.join(path.resolve(outputDirectory), 'run-' + randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const lines = ['# GPT Runner report', '', 'Evidence mode: **' + report.mode + '**',
    'Live test verified: ' + report.liveTestVerified, 'Language: ' + report.language, '',
    '## Findings', '', ...(report.findings.length ? report.findings.map((item) => '- ' + item.category + ': ' + item.issue) : ['No issues detected by the limited automated checks. This is not a correctness certificate.']),
    '', '## Limitations', '', ...report.limitations.map((value) => '- ' + value),
    '- ' + report.toolVerification, '- ' + report.answerAccuracy, '- ' + report.pronunciation];
  await writeFile(path.join(directory, 'report.md'), lines.join('\n') + '\n', { flag: 'wx' });
  // Audio may contain unredactable sensitive speech; recording is separately explicit.
  if (recordAudio) {
    await writeFile(path.join(directory, 'agent.wav'), pcmWavFromMuLaw(incoming), { flag: 'wx' });
    await writeFile(path.join(directory, 'caller.wav'), pcmWavFromMuLaw(outgoing), { flag: 'wx' });
  }
  return directory;
}


