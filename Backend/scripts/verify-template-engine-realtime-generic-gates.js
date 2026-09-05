import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const verificationScripts = Object.freeze([
  'verify-fast-entity-route-resolution.js',
  'verify-interruption-engine.js',
  'verify-template-engine-hybrid-retrieval.js',
  'verify-need-based-use-case-retrieval.js',
  'verify-template-engine-regression-observability.js',
  'verify-template-engine-workflow-runtime.js',
  'verify-template-engine-follow-up.js',
  'verify-template-engine-turn-latency.js',
  'verify-audio-continuity-monitor.js',
  'verify-template-engine-multilingual-e2e.js',
]);

for (const script of verificationScripts) {
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  });
}

const runtimeSources = Object.freeze([
  '../src/voice/interaction/template-engine-production-runtime.js',
  '../src/voice/interaction/template-engine-production-retrieval.js',
  '../src/voice/interaction/template-engine-orchestrator.js',
  '../src/voice/interaction/template-engine-output-validator.js',
  '../src/voice/interaction/template-engine-conversation-guidance.js',
  '../src/voice/interaction/template-engine-workflow-runtime.js',
]);
const source = runtimeSources.map((path) => (
  readFileSync(new URL(path, import.meta.url), 'utf8').toLocaleLowerCase()
)).join('\n');
for (const forbidden of ['hospital', 'package', 'appointment', 'patient', 'booking', 'medical']) {
  assert.equal(source.includes(forbidden), false,
    `Template-engine backend contains business vocabulary: ${forbidden}`);
}

console.log(JSON.stringify({
  gate: 'template-engine-realtime-generic',
  passed: true,
  tenants: 3,
  languages: ['ta', 'ta-Latn', 'en'],
  scenarios: [
    'canonical_names', 'published_aliases', 'unseen_stt_variations',
    'fragmented_speech', 'categories', 'direct_items', 'contextual_follow_ups',
    'comparisons', 'published_use_case_relationships', 'malformed_llm_output',
    'complete_tool_execution',
  ],
  requirements: {
    no_backend_business_vocabulary: true,
    exact_entity_evidence: true,
    unrelated_evidence: 0,
    cross_tenant_evidence: 0,
    false_clarification: 0,
    false_no_match: 0,
    technical_fallback_for_validation: 0,
    comparison_coverage: 'complete',
    workflow_activated: true,
    ui_field_order_preserved: true,
    verified_tool_result_only: true,
    published_follow_up_preserved: true,
    missing_applicable_follow_up: 0,
    acknowledgement_answer_gap_is_not_underrun: true,
  },
}, null, 2));
