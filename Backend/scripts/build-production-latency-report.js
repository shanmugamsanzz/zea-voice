import { readFileSync } from 'node:fs';
import { evaluateFirstAudioSlo } from '../src/voice/interaction/voice-latency-slo.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run report:production-latency -- <json-lines-server-log>');
  process.exit(2);
}

const samples = [];
for (const line of readFileSync(inputPath, 'utf8').split(/\r?\n/u)) {
  if (!line.includes('voice.turn_latency')) continue;
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
  const source = entry.stage === 'voice.turn_latency' ? entry
    : (entry.data?.stage === 'voice.turn_latency' ? entry.data : entry.log);
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

process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  samples,
  firstAudioSlo: evaluateFirstAudioSlo(samples),
}, null, 2)}\n`);
