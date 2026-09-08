import { readFileSync } from 'node:fs';
import { evaluateFirstAudioSlo } from '../src/voice/interaction/voice-latency-slo.js';

const inputPath = process.argv.slice(2).find((value) => !value.startsWith('--'));
const enforce = process.argv.includes('--enforce');
if (!inputPath) {
  console.error('Usage: npm run report:production-latency -- <json-lines-server-log>');
  process.exit(2);
}

const samples = [];
const actualAnswerSamples = [];
const completedTurns = [];
for (const line of readFileSync(inputPath, 'utf8').split(/\r?\n/u)) {
  if (!line.includes('voice.turn_latency') && !line.includes('template_engine.turn_completed')) continue;
  let entry;
  try { entry = JSON.parse(line); } catch {
    const readNumber = (key) => Number(new RegExp(`${key}[=:]\\s*([0-9.]+)`, 'iu').exec(line)?.[1]);
    const firstAudioMs = readNumber('totalFirstAudioMs');
    if (Number.isFinite(firstAudioMs) && firstAudioMs >= 0) {
      samples.push({
        firstAudioMs,
        retrievalMs: readNumber('retrievalMs'),
        rankingMs: readNumber('rankingMs'),
        responseClass: /responseClass[=:]\s*([^\s|]+)/iu.exec(line)?.[1] ?? null,
      });
    }
    continue;
  }
  const source = entry.stage ? entry : (entry.data?.stage ? entry.data : entry.log);
  if (source?.stage === 'template_engine.turn_completed') {
    const actualAnswerFirstAudioMs = Number(source.finalAnswerFirstAudioMs
      ?? source.actualAnswerBaseline?.actualAnswerFirstAudioMs);
    const normalVerifiedRequest = source.normalVerifiedRequest === true
      || source.actualAnswerBaseline?.normalVerifiedRequest === true;
    completedTurns.push(source);
    if (normalVerifiedRequest === true
      && Number.isFinite(actualAnswerFirstAudioMs) && actualAnswerFirstAudioMs >= 0) {
      actualAnswerSamples.push(actualAnswerFirstAudioMs);
    }
    continue;
  }
  if (source?.stage !== 'voice.turn_latency') continue;
  const firstAudioMs = Number(source.totalFirstAudioMs);
  if (!Number.isFinite(firstAudioMs) || firstAudioMs < 0) continue;
  samples.push({
    firstAudioMs,
    retrievalMs: Number(source.retrievalMs),
    rankingMs: Number(source.rankingMs),
    responseClass: source.responseClass ?? null,
  });
}

const actualAnswerP95 = actualAnswerSamples.length
  ? [...actualAnswerSamples].sort((left, right) => left - right)[
    Math.ceil(actualAnswerSamples.length * 0.95) - 1
  ] : null;
const actualAnswerAverage = actualAnswerSamples.length
  ? Math.round((actualAnswerSamples.reduce((total, value) => total + value, 0)
    / actualAnswerSamples.length) * 100) / 100 : null;
const actualAnswerMaximum = actualAnswerSamples.length ? Math.max(...actualAnswerSamples) : null;
const sufficientSamples = actualAnswerSamples.length >= 20;
const averagePassed = sufficientSamples && actualAnswerAverage < 3_000;
const maximumPassed = sufficientSamples && actualAnswerMaximum <= 4_000;
const incompleteTelemetryTurns = completedTurns.filter((turn) => (
  !String(turn.initialDecision ?? '').trim()
  || !String(turn.finalDecision ?? turn.decision ?? '').trim()
  || typeof turn.searchPerformed !== 'boolean'
  || !String(turn.validationResult ?? '').trim()
  || !Number.isFinite(Number(turn.evidenceCount))
  || typeof turn.configuredFallbackApplied !== 'boolean'
  || typeof turn.entityCoverageComplete !== 'boolean'
));
const recoveryTurns = completedTurns.filter((turn) => Boolean(
  turn.recoveryKind || turn.operationalFailure || turn.validationFailure || turn.unexpectedFailure,
));
const configuredFallbackTurns = completedTurns.filter((turn) => (
  turn.configuredFallbackApplied === true
));
const bookingFieldSearchTurns = completedTurns.filter((turn) => (
  ['AWAITING_FIELD', 'AWAITING_CONFIRMATION'].includes(String(turn.workflowStatus ?? '').toUpperCase())
  && turn.searchPerformed === true
));
const ungroundedSearchResponses = completedTurns.filter((turn) => (
  String(turn.initialDecision ?? '').toUpperCase() === 'SEARCH'
  && String(turn.finalDecision ?? turn.decision ?? '').toUpperCase() === 'RESPONSE'
  && Number(turn.evidenceCount ?? turn.evidenceIds?.length ?? 0) < 1
));
const incorrectEntityResponses = completedTurns.filter((turn) => (
  String(turn.initialDecision ?? '').toUpperCase() === 'SEARCH'
  && String(turn.finalDecision ?? turn.decision ?? '').toUpperCase() === 'RESPONSE'
  && turn.entityCoverageComplete === false
));
const correctnessPassed = completedTurns.length > 0
  && incompleteTelemetryTurns.length === 0
  && recoveryTurns.length === 0
  && configuredFallbackTurns.length === 0
  && bookingFieldSearchTurns.length === 0
  && ungroundedSearchResponses.length === 0
  && incorrectEntityResponses.length === 0;
const report = {
  generatedAt: new Date().toISOString(),
  samples,
  firstAudioSlo: evaluateFirstAudioSlo(samples),
  actualAnswerSlo: {
    targetAverageMs: 3_000,
    maximumNormalRequestMs: 4_000,
    targetP95Ms: 3_000,
    minimumSamples: 20,
    count: actualAnswerSamples.length,
    p95Ms: actualAnswerP95,
    averageMs: actualAnswerAverage,
    maximumMs: actualAnswerMaximum,
    averagePassed,
    maximumPassed,
    averageReason: !sufficientSamples ? 'insufficient_live_samples'
      : actualAnswerAverage < 3_000 ? null : 'actual_answer_average_breached',
    maximumReason: !sufficientSamples ? 'insufficient_live_samples'
      : actualAnswerMaximum <= 4_000 ? null : 'actual_answer_maximum_breached',
    passed: averagePassed && maximumPassed,
    reason: !sufficientSamples ? 'insufficient_live_samples'
      : !averagePassed ? 'actual_answer_average_breached'
        : !maximumPassed ? 'actual_answer_maximum_breached' : null,
  },
  liveCorrectness: {
    completedTurns: completedTurns.length,
    incompleteTelemetryTurns: incompleteTelemetryTurns.length,
    recoveryTurns: recoveryTurns.length,
    configuredFallbackTurns: configuredFallbackTurns.length,
    bookingFieldKnowledgeSearches: bookingFieldSearchTurns.length,
    ungroundedSearchResponses: ungroundedSearchResponses.length,
    incorrectEntityResponses: incorrectEntityResponses.length,
    passed: correctnessPassed,
    reason: !completedTurns.length ? 'no_completed_live_turns'
      : incompleteTelemetryTurns.length ? 'incomplete_live_correctness_telemetry'
        : recoveryTurns.length ? 'recovery_delivered_during_controlled_replay'
        : configuredFallbackTurns.length ? 'fallback_delivered_during_controlled_replay'
          : bookingFieldSearchTurns.length ? 'booking_field_knowledge_search_detected'
            : ungroundedSearchResponses.length ? 'ungrounded_search_response_detected'
              : incorrectEntityResponses.length ? 'incorrect_entity_response_detected' : null,
  },
};
report.releaseGate = {
  passed: report.actualAnswerSlo.passed && report.liveCorrectness.passed,
  reason: !report.actualAnswerSlo.passed
    ? report.actualAnswerSlo.reason : report.liveCorrectness.reason,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (enforce && !report.releaseGate.passed) process.exitCode = 1;
