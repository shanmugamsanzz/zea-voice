import pino from 'pino';
import { env } from './env.js';
import { createHumanLogStream } from './human-log-stream.js';

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

const options = {
  level: env.LOG_LEVEL,
  redact: {
    paths: loggerRedactPaths,
    censor: '[REDACTED]',
  },
};

export const logger = env.LOG_FORMAT === 'human'
  ? pino(options, createHumanLogStream())
  : pino(options);
