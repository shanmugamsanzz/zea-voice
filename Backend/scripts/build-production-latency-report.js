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
const measurement = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : Number.NaN;
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
    const actualAnswerFirstAudioMs = measurement(source.finalAnswerFirstAudioMs
      ?? source.actualAnswerFirstAudioMs
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
  const firstAudioMs = measurement(source.totalFirstAudioMs);
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
  || typeof turn.technicalRecoveryApplied !== 'boolean'
  || !Number.isFinite(Number(turn.llmInvocationCount))
));
const recoveryTurns = completedTurns.filter((turn) => Boolean(
  turn.recoveryKind || turn.operationalFailure || turn.unexpectedFailure,
));
const technicalRecoveryTurns = completedTurns.filter((turn) => turn.technicalRecoveryApplied === true);
const multipleLlmInvocationTurns = completedTurns.filter((turn) => (
  Number(turn.llmInvocationCount) > 1
));
const ordinaryStaticFallbackTurns = completedTurns.filter((turn) => (
  turn.technicalRecoveryApplied === true
  && !turn.recoveryKind
  && !turn.operationalFailure
  && !turn.unexpectedFailure
));
const correctnessPassed = completedTurns.length > 0
  && incompleteTelemetryTurns.length === 0
  && recoveryTurns.length === 0
  && technicalRecoveryTurns.length === 0
  && multipleLlmInvocationTurns.length === 0
  && ordinaryStaticFallbackTurns.length === 0;
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
    atOrAboveThreeSeconds: actualAnswerSamples.filter((value) => value >= 3000).length,
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
    technicalSafeguardsMeasured: true,
    completedTurns: completedTurns.length,
    incompleteTelemetryTurns: incompleteTelemetryTurns.length,
    recoveryTurns: recoveryTurns.length,
    technicalRecoveryTurns: technicalRecoveryTurns.length,
    multipleLlmInvocationTurns: multipleLlmInvocationTurns.length,
    ordinaryStaticFallbackTurns: ordinaryStaticFallbackTurns.length,
    passed: correctnessPassed,
    reason: !completedTurns.length ? 'no_completed_live_turns'
      : incompleteTelemetryTurns.length ? 'incomplete_live_correctness_telemetry'
        : recoveryTurns.length ? 'recovery_delivered_during_controlled_replay'
        : technicalRecoveryTurns.length ? 'technical_recovery_during_controlled_replay'
          : multipleLlmInvocationTurns.length ? 'multiple_llm_invocations_detected'
            : ordinaryStaticFallbackTurns.length ? 'ordinary_static_fallback_detected' : null,
  },
};
report.releaseGate = {
  passed: report.actualAnswerSlo.passed && report.liveCorrectness.passed,
  reason: !report.actualAnswerSlo.passed
    ? report.actualAnswerSlo.reason : !report.liveCorrectness.passed
      ? report.liveCorrectness.reason : null,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (enforce && !report.releaseGate.passed) process.exitCode = 1;
