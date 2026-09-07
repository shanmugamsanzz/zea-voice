import { readFileSync } from 'node:fs';
import { evaluateFirstAudioSlo } from '../src/voice/interaction/voice-latency-slo.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run report:production-latency -- <json-lines-server-log>');
  process.exit(2);
}

const samples = [];
const actualAnswerSamples = [];
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
    if (Number.isFinite(actualAnswerFirstAudioMs) && actualAnswerFirstAudioMs >= 0) {
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
process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  samples,
  firstAudioSlo: evaluateFirstAudioSlo(samples),
  actualAnswerSlo: {
    targetAverageMs: 3_000,
    targetP95Ms: 3_000,
    minimumSamples: 20,
    count: actualAnswerSamples.length,
    p95Ms: actualAnswerP95,
    averageMs: actualAnswerAverage,
    averagePassed: actualAnswerSamples.length >= 20 && actualAnswerAverage < 3_000,
    averageReason: actualAnswerSamples.length < 20 ? 'insufficient_live_samples'
      : actualAnswerAverage < 3_000 ? null : 'actual_answer_average_breached',
    passed: actualAnswerSamples.length >= 20 && actualAnswerP95 < 3_000,
    reason: actualAnswerSamples.length < 20 ? 'insufficient_live_samples'
      : actualAnswerP95 < 3_000 ? null : 'actual_answer_p95_breached',
  },
}, null, 2)}\n`);
