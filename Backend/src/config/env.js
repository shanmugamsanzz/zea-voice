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
  PLIVO_ANSWER_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
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

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};
