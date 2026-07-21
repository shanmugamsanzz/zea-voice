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
  VOICE_CALL_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  VOICE_POSTCALL_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(5000),
  VOICE_POSTCALL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
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
  RAG_RUNTIME_PROFILE_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  RAG_RUNTIME_CACHE_TIMEOUT_MS: z.coerce.number().int().min(5).max(1000).default(50),
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
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(8192).default(300),
  LLM_MAX_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(50).default(12),
  LLM_SYSTEM_PROMPT_MAX_CHARS: z.coerce.number().int().min(2000).max(100000).default(40000),
  LLM_KNOWLEDGE_CONTEXT_MAX_CHARS: z.coerce.number().int().min(500).max(50000).default(12000),
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
