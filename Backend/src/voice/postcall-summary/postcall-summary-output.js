import { AppError } from '../../middleware/errors.js';

const sentiments = new Set(['positive', 'neutral', 'negative', 'mixed', 'unknown']);

function limited(value, max, fallback = null) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, max) : fallback;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    safe[String(key).slice(0, 160)] = item;
  }
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) > 120_000) {
    throw new AppError(502, 'Summary collected_data exceeds the storage limit', 'POSTCALL_SUMMARY_OUTPUT_INVALID');
  }
  return JSON.parse(serialized);
}

function jsonText(value) {
  const raw = String(value ?? '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

export function normalizePostCallSummaryOutput(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(jsonText(value)) : value;
  } catch {
    throw new AppError(502, 'Summary LLM returned invalid JSON', 'POSTCALL_SUMMARY_OUTPUT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(502, 'Summary LLM output must be a JSON object', 'POSTCALL_SUMMARY_OUTPUT_INVALID');
  }
  const summary = limited(parsed.summary, 50_000);
  if (!summary) throw new AppError(502, 'Summary LLM output is missing summary', 'POSTCALL_SUMMARY_OUTPUT_INVALID');
  const sentiment = String(parsed.sentiment ?? 'unknown').trim().toLowerCase();
  const followUpRequired = parsed.follow_up_required === true || parsed.followUpRequired === true;
  return {
    summary,
    outcome: limited(parsed.outcome, 120, 'unknown'),
    customerIntent: limited(parsed.customer_intent ?? parsed.customerIntent, 240),
    sentiment: sentiments.has(sentiment) ? sentiment : 'unknown',
    collectedData: plainObject(parsed.collected_data ?? parsed.collectedData),
    followUpRequired,
    followUpReason: followUpRequired
      ? limited(parsed.follow_up_reason ?? parsed.followUpReason, 2000)
      : null,
  };
}

function transcriptText(transcript, maximumCharacters) {
  const lines = transcript.map((entry) => `${String(entry.role ?? 'user').toUpperCase()}: ${String(entry.content ?? '').trim()}`)
    .filter((line) => !line.endsWith(':'));
  const complete = lines.join('\n');
  if (complete.length <= maximumCharacters) return complete;
  const marker = '[Earlier transcript omitted because of size]\n';
  return marker + complete.slice(-(maximumCharacters - marker.length));
}

export function buildPostCallSummaryMessages(job, options = {}) {
  const maximumCharacters = options.maximumTranscriptCharacters ?? 120_000;
  const transcript = transcriptText(job.transcript ?? [], maximumCharacters);
  const schema = `{
  "summary": "concise factual call summary",
  "outcome": "short outcome label",
  "customer_intent": "customer's main intent or null",
  "sentiment": "positive|neutral|negative|mixed|unknown",
  "collected_data": {"only_facts_explicitly_present_in_the_call": "value"},
  "follow_up_required": true,
  "follow_up_reason": "reason or null"
}`;
  return [
    {
      role: 'system',
      content: `You create a factual post-call record. Return exactly one valid JSON object and no markdown.\nDo not invent facts, names, dates, commitments, outcomes, or sentiment. Use null/unknown when evidence is absent.\nRequired schema:\n${schema}`,
    },
    {
      role: 'user',
      content: `Company-configured summary instructions:\n${job.instructions}\n\nCall metadata:\n${JSON.stringify(job.call ?? {})}\n\nFinal transcript:\n${transcript}`,
    },
  ];
}
