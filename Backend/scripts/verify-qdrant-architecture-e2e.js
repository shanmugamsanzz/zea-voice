import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

const backendDirectory = fileURLToPath(new URL('../', import.meta.url));
const argumentsList = process.argv.slice(2);
const enforceLive = argumentsList.includes('--enforce-live');
const liveLogPath = argumentsList.find((argument) => !argument.startsWith('--')) ?? null;

const checks = [
  ['retrieval contract', 'verify-qdrant-retrieval-contract.js'],
  ['plain-text document contract', 'verify-agent-text-document-contract.js'],
  ['chunking and overlap', 'verify-agent-text-document-chunker.js'],
  ['multilingual E5 embeddings', 'verify-agent-document-embeddings.js'],
  ['multiple-document lifecycle', 'verify-agent-qdrant-documents.js'],
  ['contextual tenant-agent search', 'verify-agent-qdrant-contextual-search.js'],
  ['one universal LLM turn', 'verify-agent-qdrant-grounded-turn.js'],
  ['production runtime', 'verify-template-engine-production-runtime.js'],
  ['configured workflow actions', 'verify-agent-qdrant-grounded-turn.js'],
  ['interruption audio isolation', 'verify-interruption-audio-isolation.js'],
  ['existing TTS', 'verify-voice-tts.js'],
  ['retrieval dependency cutover', 'verify-retrieval-dependency-repair.js'],
];

function runNodeScript(label, script, extraArguments = []) {
  const result = spawnSync(process.execPath, [`scripts/${script}`, ...extraArguments], {
    cwd: backendDirectory,
    encoding: 'utf8',
    timeout: 120_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${label} failed${details ? `:\n${details}` : ''}`, {
      cause: result.error,
    });
  }
  return { label, passed: true };
}

async function verifyBackendHttpStartup() {
  const server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      service: 'zea-voice-api',
      version: '0.1.0',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  return { label: 'backend HTTP startup', passed: true };
}

async function verifyNoPostgresKnowledgeRetrieval() {
  const relativePaths = [
    'src/voice/interaction/agent-qdrant-retrieval.js',
    'src/voice/interaction/agent-qdrant-grounded-turn.js',
    'src/voice/interaction/qdrant-retrieval-contract.js',
    'src/agents/agent-qdrant-document.service.js',
  ];
  const sources = await Promise.all(relativePaths.map(async (relativePath) => ({
    relativePath,
    source: await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  })));
  const forbidden = /\b(?:knowledge_documents|knowledge_document_versions|knowledge_chunks|knowledge_processing_jobs)\b|database-context|\.query\s*\(/u;
  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(source, forbidden,
      `${relativePath} must not query PostgreSQL document or chunk storage`);
  }
  return { label: 'zero PostgreSQL document/chunk queries', passed: true };
}

async function verifyLiveOrchestratorRetrievalWiring() {
  const source = await readFile(new URL(
    '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
  ), 'utf8');
  assert.match(source,
    /retrieveQdrantKnowledge:\s*this\.dependencies\.retrieveQdrantKnowledge\s*\?\?\s*retrieveAgentQdrantKnowledge/u,
    'Live orchestrator must wire the Qdrant retrieval implementation');
  assert.match(source,
    /runQdrantUniversalTurn:\s*this\.dependencies\.runQdrantUniversalTurn\s*\?\?\s*runAgentQdrantUniversalTurn/u,
    'Live orchestrator must wire the single-LLM grounded-turn implementation');
  assert.doesNotMatch(source, /^\s*(?:retrieveQdrantKnowledge|runQdrantUniversalTurn),\s*$/gmu,
    'Live orchestrator must not reference undefined shorthand dependencies');
  return { label: 'live orchestrator Qdrant dependency wiring', passed: true };
}

function liveLatencyReport() {
  if (!liveLogPath) {
    if (enforceLive) {
      throw new Error('A JSON-lines production log is required with --enforce-live');
    }
    return {
      measured: false,
      targetFirstAudioMs: 1_000,
      reason: 'live_log_not_supplied',
      command: 'npm run verify:qdrant-architecture-live -- <json-lines-server-log>',
    };
  }
  const result = spawnSync(process.execPath, [
    'scripts/build-production-latency-report.js', liveLogPath,
    ...(enforceLive ? ['--enforce'] : []),
  ], {
    cwd: backendDirectory,
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Live latency verification failed${details ? `:\n${details}` : ''}`, {
      cause: result.error,
    });
  }
  const report = JSON.parse(result.stdout);
  return {
    measured: true,
    targetFirstAudioMs: 1_000,
    firstAudioSlo: report.firstAudioSlo,
    actualAnswerSlo: report.actualAnswerSlo,
    liveCorrectness: report.liveCorrectness,
    releaseGate: report.releaseGate,
  };
}

const results = [];
for (const [label, script] of checks) results.push(runNodeScript(label, script));
results.push(await verifyBackendHttpStartup());
results.push(await verifyNoPostgresKnowledgeRetrieval());
results.push(await verifyLiveOrchestratorRetrievalWiring());

console.log(JSON.stringify({
  architecture: [
    'documents_chunk_embed_qdrant',
    'bounded_context_query_embedding',
    'tenant_agent_filtered_qdrant_search',
    'top_two_or_three_chunks',
    'one_universal_llm_call',
    'deterministic_validation',
    'existing_tts',
  ],
  passed: true,
  checks: results,
  guarantees: {
    maximumLlmCallsPerUserTurn: 1,
    queryEmbeddingsPerFactualTurn: 1,
    qdrantSearchesPerFactualTurn: 1,
    maximumRetrievedChunks: 3,
    postgresDocumentChunkQueries: 0,
  },
  latency: liveLatencyReport(),
}, null, 2));
