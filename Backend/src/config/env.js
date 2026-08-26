import 'dotenv/config';
import { z } from 'zod';

const emptyToUndefined = (value) => value === '' ? undefined : value;
const booleanFromString = z.preprocess(
  (value) => typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  z.boolean(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['human', 'json']).default('human'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  PERFORMANCE_MEASUREMENT_ENABLED: booleanFromString.default(true),
  PERFORMANCE_SLOW_REQUEST_MS: z.coerce.number().int().min(100).max(120000).default(2000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AUTO_MIGRATE: booleanFromString.default(true),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(50).default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),

  REDIS_HOST: z.string().min(1, 'REDIS_HOST is required'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  REDIS_DB: z.coerce.number().int().min(0).default(0),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  REDIS_MAX_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  QUEUE_PREFIX: z.string().min(1).default('zea-voice'),
  QUEUE_CONGESTED_WAITING: z.coerce.number().int().min(1).default(20),
  QUEUE_CRITICAL_WAITING: z.coerce.number().int().min(2).default(100),
  QUEUE_CONGESTED_WAIT_SECONDS: z.coerce.number().int().min(1).default(60),
  QUEUE_CRITICAL_WAIT_SECONDS: z.coerce.number().int().min(2).default(180),
  WORKER_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  DASHBOARD_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1000),

  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PASSWORD_BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_COOKIE_NAME: z.string().min(1).default('zea_refresh_token'),
  AUTH_COOKIE_SECURE: booleanFromString.default(false),
  CREDENTIAL_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  PLIVO_API_BASE_URL: z.string().url().default('https://api.plivo.com/v1'),
  PLIVO_CREDIT_USD_TO_INR_RATE: z.coerce.number().positive().max(1000).default(80),
  PROVIDER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  PLIVO_BALANCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(6000),
  PROVIDER_BALANCE_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  PROVIDER_BALANCE_CACHE_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(500),
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  VOICE_MEDIA_SIGNING_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  VOICE_MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  BROWSER_TEST_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  BROWSER_TEST_SESSION_MAX_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  BROWSER_TEST_MAX_CONCURRENT_PER_TENANT: z.coerce.number().int().min(1).max(100).default(3),
  VOICE_CALL_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  VOICE_CONTEXT_CACHE_TTL_SECONDS: z.coerce.number().int().min(3600).max(604800).default(86400),
  VOICE_CONTEXT_CACHE_TIMEOUT_MS: z.coerce.number().int().min(5).max(2000).default(50),
  VOICE_CONTEXT_CACHE_MAX_BYTES: z.coerce.number().int().min(4096).max(1048576).default(131072),
  VOICE_MEDIA_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
  VOICE_MEDIA_MAX_PENDING_MESSAGES: z.coerce.number().int().min(10).max(10000).default(250),
  VOICE_MEDIA_IDLE_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(45000),
  VOICE_COMPANY_DEFAULT_CONCURRENCY: z.coerce.number().int().min(1).max(10000).default(20),
  VOICE_CALL_OWNERSHIP_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  VOICE_CALL_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  VOICE_CALL_RECONCILIATION_ENABLED: booleanFromString.default(true),
  VOICE_CALL_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10000).max(300000).default(30000),
  VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  VOICE_CALL_RECONCILIATION_FALLBACK_SECONDS: z.coerce.number().int().min(300).max(86400).default(900),
  VOICE_CALL_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  VOICE_RUNTIME_INSTANCE_ID: z.preprocess(emptyToUndefined, z.string().min(1).max(160).optional()),
  VOICE_SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  VOICE_AUDIO_FRAME_MS: z.coerce.number().int().min(10).max(100).default(20),
  VOICE_AUDIO_INPUT_MAX_BUFFER_MS: z.coerce.number().int().min(100).max(10000).default(1000),
  VOICE_AUDIO_OUTPUT_MAX_BUFFER_MS: z.coerce.number().int().min(100).max(10000).default(2000),
  VOICE_AUDIO_UNDERRUN_THRESHOLD_MS: z.coerce.number().int().min(10).max(2000).default(40),
  VOICE_AUDIO_PACKET_MS: z.coerce.number().int().min(20).max(200).default(80),
  VOICE_AUDIO_PRE_ROLL_MS: z.coerce.number().int().min(0).max(1000).default(120),
  VOICE_AUDIO_PRE_ROLL_MAX_WAIT_MS: z.coerce.number().int().min(0).max(500).default(80),
  VOICE_AUDIO_LOW_WATER_MS: z.coerce.number().int().min(0).max(1000).default(60),
  VOICE_AUDIO_DELIVERY_LEAD_MS: z.coerce.number().int().min(20).max(1000).default(160),
  VOICE_AUDIO_WEBSOCKET_WARN_MS: z.coerce.number().int().min(5).max(5000).default(40),
  VOICE_AUDIO_WEBSOCKET_BUFFER_WARN_BYTES: z.coerce.number().int().min(1024).max(16777216).default(262144),
  VOICE_FIRST_AUDIO_TARGET_MS: z.coerce.number().int().min(100).max(10000).default(1000),
  // Hard live-turn budgets keep a slow Knowledge/LLM/TTS provider from
  // holding the caller in silence.  The complete first-audio deadline is
  // intentionally two seconds; individual stages receive smaller budgets.
  VOICE_TURN_FIRST_AUDIO_DEADLINE_MS: z.coerce.number().int().min(1000).max(10000).default(2000),
  VOICE_ROUTING_TURN_TIMEOUT_MS: z.coerce.number().int().min(20).max(1000).default(100),
  VOICE_RETRIEVAL_TURN_TIMEOUT_MS: z.coerce.number().int().min(50).max(2000).default(300),
  VOICE_HYDRATION_TURN_TIMEOUT_MS: z.coerce.number().int().min(50).max(2000).default(150),
  VOICE_KNOWLEDGE_TURN_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(500),
  VOICE_LLM_TURN_TIMEOUT_MS: z.coerce.number().int().min(250).max(10000).default(900),
  // First audio still uses VOICE_LLM_TURN_TIMEOUT_MS. Once a short
  // acknowledgement is audible, allow the measured production structured
  // completion enough time to finish and validate, with a bounded maximum.
  VOICE_LLM_POST_ACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(15000).default(4000),
  VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS: z.coerce.number().int().min(250).max(5000).default(600),
  VOICE_TTS_MAX_RESPONSE_CHARACTERS: z.coerce.number().int().min(100).max(2000).default(600),
  VOICE_TTS_SENTENCE_GROUPING_ENABLED: booleanFromString.default(true),
  VOICE_TTS_SHORT_SENTENCE_CHARACTERS: z.coerce.number().int().min(20).max(500).default(100),
  VOICE_TTS_GROUP_MAX_CHARACTERS: z.coerce.number().int().min(40).max(1000).default(220),
  VOICE_TTS_GROUP_WAIT_MS: z.coerce.number().int().min(10).max(500).default(80),
  VOICE_TTS_LOOKAHEAD_ENABLED: booleanFromString.default(true),
  VOICE_TTS_LOOKAHEAD_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  VOICE_TTS_LOOKAHEAD_MAX_BYTES_PER_SEGMENT: z.coerce.number().int().min(65536).max(10485760).default(2097152),
  VOICE_TTS_SMOOTH_SENTENCE_BOUNDARIES: booleanFromString.default(true),
  VOICE_WELCOME_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
  VOICE_WELCOME_CACHE_MAX_BYTES: z.coerce.number().int().min(1024).max(10485760).default(2097152),
  VOICE_WELCOME_CACHE_TIMEOUT_MS: z.coerce.number().int().min(5).max(1000).default(50),
  VOICE_POSTCALL_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(5000),
  VOICE_POSTCALL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
  POSTCALL_SUMMARY_WORKERS_ENABLED: booleanFromString.default(true),
  POSTCALL_SUMMARY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  POSTCALL_SUMMARY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  POSTCALL_SUMMARY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  POSTCALL_SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(8192).default(800),
  POSTCALL_SUMMARY_TRANSCRIPT_MAX_CHARS: z.coerce.number().int().min(1000).max(500000).default(120000),
  VOICE_PRECALL_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(5000),
  VOICE_PRECALL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
  VOICE_RECORDING_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(1_073_741_824).default(104_857_600),
  VOICE_RECORDING_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
  CAMPAIGN_WORKERS_ENABLED: booleanFromString.default(false),
  CAMPAIGN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
  CONCURRENCY_RETRY_DELAY_MS: z.coerce.number().int().min(1000).max(60000).default(5000),

  B2_S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  B2_REGION: z.preprocess(emptyToUndefined, z.string().optional()),
  B2_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  B2_BUCKET_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  B2_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  B2_APPLICATION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  B2_SKIP_STARTUP_CHECK: booleanFromString.default(true),
  AMBIENCE_AUDIO_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(104_857_600).default(20_971_520),
  AMBIENCE_AUDIO_MIN_DURATION_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  AMBIENCE_AUDIO_MAX_DURATION_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  AMBIENCE_PREPROCESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  AMBIENCE_RUNTIME_CACHE_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(536_870_912).default(67_108_864),
  KNOWLEDGE_PDF_MAX_BYTES: z.coerce.number().int().min(1024).max(104_857_600).default(26_214_400),
  KNOWLEDGE_PDF_MAX_PAGES: z.coerce.number().int().min(1).max(5000).default(500),
  KNOWLEDGE_EXTRACTED_TEXT_MAX_CHARS: z.coerce.number().int().min(10000).max(20_000_000).default(2_000_000),
  KNOWLEDGE_WORKERS_ENABLED: booleanFromString.default(false),
  KNOWLEDGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  RAG_CHUNK_SIZE_TOKENS: z.coerce.number().int().min(50).max(2000).default(300),
  RAG_CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(500).default(50),
  RAG_EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(128).default(16),
  RAG_EMBEDDING_MAX_CHARS: z.coerce.number().int().min(200).max(10000).default(1800),
  QDRANT_UPSERT_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(64),
  RAG_RUNTIME_CACHE_TIMEOUT_MS: z.coerce.number().int().min(5).max(1000).default(50),
  KNOWLEDGE_ARTIFACT_READINESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  KNOWLEDGE_ARTIFACT_READINESS_POLL_MS: z.coerce.number().int().min(25).max(5000).default(250),
  RAG_RUNTIME_SEMANTIC_DEADLINE_MS: z.coerce.number().int().min(100).max(1000).default(300),
  RAG_RUNTIME_CHANNEL_DEADLINE_MS: z.coerce.number().int().min(100).max(500).default(150),
  RAG_RUNTIME_TOP_K: z.coerce.number().int().min(1).max(10).default(3),
  RAG_RUNTIME_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.72),

  RAG_ENABLED: booleanFromString.default(false),
  RAG_STARTUP_CHECK_ENABLED: booleanFromString.default(true),
  RAG_HEALTH_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  EMBEDDING_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  EMBEDDING_API_KEY: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  EMBEDDING_MODEL: z.string().min(1).default('intfloat/multilingual-e5-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
  EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  EMBEDDING_BENCHMARK_ITERATIONS: z.coerce.number().int().min(3).max(100).default(10),
  EMBEDDING_BENCHMARK_TARGET_P95_MS: z.coerce.number().int().min(10).max(10000).default(250),
  QDRANT_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  QDRANT_API_KEY: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  QDRANT_COLLECTION_PREFIX: z.string().regex(/^[a-z0-9_]+$/).default('zea_voice_company'),
  QDRANT_VECTOR_SIZE: z.coerce.number().int().positive().default(384),
  QDRANT_DISTANCE: z.enum(['Cosine', 'Dot', 'Euclid', 'Manhattan']).default('Cosine'),
  QDRANT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(250).max(120000).default(15000),
  LLM_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(5),
  LLM_CIRCUIT_RESET_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(8192).default(300),
  VOICE_GROUNDED_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4096).default(384),
  LLM_MAX_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(50).default(12),
  LLM_SYSTEM_PROMPT_MAX_CHARS: z.coerce.number().int().min(2000).max(100000).default(40000),
  // Unified voice turns reserve the structured contract and cap composition
  // at 12k; legacy/non-voice callers may still explicitly configure more.
  VOICE_LLM_PROMPT_BUDGET_CHARS: z.coerce.number().int().min(4000).max(40000).default(8000),
  VOICE_LLM_MAX_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(4),
  // Used only when a streaming STT provider does not send its own speech-end
  // event.  It finalizes a complete caller turn after genuine quiet, never
  // from sound alone.
  VOICE_STT_FINALIZATION_SILENCE_MS: z.coerce.number().int().min(500).max(1500).default(600),
  LLM_KNOWLEDGE_CONTEXT_MAX_CHARS: z.coerce.number().int().min(500).max(50000).default(12000),
  TTS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  TTS_SPEED_MONITOR_ENABLED: booleanFromString.default(true),
  TTS_SPEED_MIN_CHARACTERS_PER_SECOND: z.coerce.number().min(0.1).max(100).default(3),
  TTS_SPEED_MAX_CHARACTERS_PER_SECOND: z.coerce.number().min(1).max(200).default(28),
  TTS_SPEED_MIN_SAMPLE_CHARACTERS: z.coerce.number().int().min(1).max(1000).default(24),
  TTS_SPEED_MIN_AUDIO_MS: z.coerce.number().int().min(100).max(10000).default(500),
  TTS_SPEED_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  VOICE_TOOL_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(5000),
  VOICE_TOOL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
  VOICE_RUNTIME_MAX_RECOVERABLE_ERRORS: z.coerce.number().int().min(0).max(10).default(2),
  VOICE_PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  VOICE_PROVIDER_RETRY_BASE_MS: z.coerce.number().int().min(10).max(5000).default(100),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

if (parsed.data.DATABASE_POOL_MIN > parsed.data.DATABASE_POOL_MAX) {
  throw new Error('Invalid environment configuration: DATABASE_POOL_MIN cannot exceed DATABASE_POOL_MAX');
}

if (parsed.data.RAG_CHUNK_OVERLAP_TOKENS >= parsed.data.RAG_CHUNK_SIZE_TOKENS) {
  throw new Error('Invalid environment configuration: RAG_CHUNK_OVERLAP_TOKENS must be smaller than RAG_CHUNK_SIZE_TOKENS');
}

if (parsed.data.VOICE_CALL_HEARTBEAT_INTERVAL_MS >= parsed.data.VOICE_CALL_OWNERSHIP_TTL_SECONDS * 1000) {
  throw new Error('Invalid environment configuration: VOICE_CALL_HEARTBEAT_INTERVAL_MS must be shorter than VOICE_CALL_OWNERSHIP_TTL_SECONDS');
}

if (parsed.data.TTS_SPEED_MIN_CHARACTERS_PER_SECOND >= parsed.data.TTS_SPEED_MAX_CHARACTERS_PER_SECOND) {
  throw new Error('Invalid environment configuration: TTS_SPEED_MIN_CHARACTERS_PER_SECOND must be lower than TTS_SPEED_MAX_CHARACTERS_PER_SECOND');
}

if (parsed.data.VOICE_TTS_SHORT_SENTENCE_CHARACTERS > parsed.data.VOICE_TTS_GROUP_MAX_CHARACTERS) {
  throw new Error('Invalid environment configuration: VOICE_TTS_SHORT_SENTENCE_CHARACTERS cannot exceed VOICE_TTS_GROUP_MAX_CHARACTERS');
}

if (parsed.data.VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS <= parsed.data.VOICE_CALL_OWNERSHIP_TTL_SECONDS) {
  throw new Error('Invalid environment configuration: VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS must exceed VOICE_CALL_OWNERSHIP_TTL_SECONDS');
}

if (parsed.data.VOICE_CALL_RECONCILIATION_FALLBACK_SECONDS <= parsed.data.VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS) {
  throw new Error('Invalid environment configuration: VOICE_CALL_RECONCILIATION_FALLBACK_SECONDS must exceed VOICE_CALL_RECONCILIATION_MIN_AGE_SECONDS');
}

const frozenEmbeddingModel = 'intfloat/multilingual-e5-small';
const frozenEmbeddingDimensions = 384;

if (parsed.data.RAG_ENABLED) {
  const missingRagVariables = [
    'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'QDRANT_URL', 'QDRANT_API_KEY',
    'B2_S3_ENDPOINT', 'B2_BUCKET', 'B2_BUCKET_ID', 'B2_KEY_ID', 'B2_APPLICATION_KEY',
  ].filter((name) => !parsed.data[name]);

  if (missingRagVariables.length > 0) {
    throw new Error(`Invalid environment configuration: RAG requires ${missingRagVariables.join(', ')}`);
  }

  if (parsed.data.EMBEDDING_MODEL !== frozenEmbeddingModel) {
    throw new Error(`Invalid environment configuration: Phase 1 embedding model is frozen to ${frozenEmbeddingModel}`);
  }

  if (parsed.data.EMBEDDING_DIMENSIONS !== frozenEmbeddingDimensions) {
    throw new Error(`Invalid environment configuration: ${frozenEmbeddingModel} requires ${frozenEmbeddingDimensions} dimensions`);
  }

  if (parsed.data.QDRANT_VECTOR_SIZE !== parsed.data.EMBEDDING_DIMENSIONS) {
    throw new Error('Invalid environment configuration: QDRANT_VECTOR_SIZE must match EMBEDDING_DIMENSIONS');
  }
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};
