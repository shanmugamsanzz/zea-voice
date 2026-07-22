import pino from 'pino';
import { env } from './env.js';

export const loggerRedactPaths = [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.query.token',
      'headers.authorization',
      '*.headers.authorization',
      '*.headers.Authorization',
      '*.password',
      '*.token',
      '*.authToken',
      '*.applicationKey',
      '*.apiKey',
      '*.embeddingApiKey',
      '*.qdrantApiKey',
      '*.secret',
      '*.clientSecret',
      '*.secretConfiguration',
      '*.encryptedValue',
      '*.auth_token',
      '*.auth_token_encrypted',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: loggerRedactPaths,
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});
