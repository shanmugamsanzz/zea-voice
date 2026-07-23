import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../config/logger.js';

const requestPerformance = new AsyncLocalStorage();

function round(value) {
  return Math.round(value * 100) / 100;
}

function safeDuration(startedAt) {
  return round(Math.max(0, performance.now() - startedAt));
}

export function runWithPerformanceContext(request, operation) {
  return requestPerformance.run({
    requestId: request.id,
    method: request.method,
    path: request.originalUrl?.split('?')[0] ?? request.path,
    startedAt: performance.now(),
    sqlDurationMs: 0,
    sqlQueryCount: 0,
    externalDurationMs: 0,
    externalCallCount: 0,
  }, operation);
}

export async function measureSql(operation, queryName = 'query') {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const durationMs = safeDuration(startedAt);
    const context = requestPerformance.getStore();
    if (context) {
      context.sqlDurationMs += durationMs;
      context.sqlQueryCount += 1;
    }
    logger.debug({ requestId: context?.requestId, queryName, durationMs }, 'SQL performance');
  }
}

export async function measureExternalProvider(provider, operationName, operation) {
  const startedAt = performance.now();
  let outcome = 'success';
  try {
    return await operation();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = safeDuration(startedAt);
    const context = requestPerformance.getStore();
    if (context) {
      context.externalDurationMs += durationMs;
      context.externalCallCount += 1;
    }
    const log = context?.path === '/health' ? logger.debug.bind(logger) : logger.info.bind(logger);
    log({
      requestId: context?.requestId,
      provider,
      operation: operationName,
      durationMs,
      outcome,
    }, 'External provider performance');
  }
}

export function getPerformanceSummary() {
  const context = requestPerformance.getStore();
  if (!context) return null;
  return {
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    durationMs: safeDuration(context.startedAt),
    sqlDurationMs: round(context.sqlDurationMs),
    sqlQueryCount: context.sqlQueryCount,
    externalDurationMs: round(context.externalDurationMs),
    externalCallCount: context.externalCallCount,
  };
}

export function performanceHeaders(summary) {
  return {
    'x-response-time-ms': String(summary.durationMs),
    'x-sql-time-ms': String(summary.sqlDurationMs),
    'x-sql-query-count': String(summary.sqlQueryCount),
    'x-external-time-ms': String(summary.externalDurationMs),
    'x-external-call-count': String(summary.externalCallCount),
    'server-timing': [
      `app;dur=${summary.durationMs}`,
      `sql;dur=${summary.sqlDurationMs};desc="${summary.sqlQueryCount} queries"`,
      `external;dur=${summary.externalDurationMs};desc="${summary.externalCallCount} calls"`,
    ].join(', '),
  };
}
