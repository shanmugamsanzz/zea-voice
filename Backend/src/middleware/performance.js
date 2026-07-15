import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  getPerformanceSummary,
  performanceHeaders,
  runWithPerformanceContext,
} from '../performance/performance-context.js';

export function performanceMiddleware(request, response, next) {
  if (!env.PERFORMANCE_MEASUREMENT_ENABLED) return next();

  return runWithPerformanceContext(request, () => {
    const originalEnd = response.end;
    response.end = function measuredEnd(...args) {
      const summary = getPerformanceSummary();
      if (summary && !response.headersSent) {
        for (const [name, value] of Object.entries(performanceHeaders(summary))) {
          response.setHeader(name, value);
        }
      }
      return originalEnd.apply(this, args);
    };

    response.once('finish', () => {
      const summary = getPerformanceSummary();
      if (!summary) return;
      const log = summary.durationMs >= env.PERFORMANCE_SLOW_REQUEST_MS ? logger.warn.bind(logger) : logger.info.bind(logger);
      log({ ...summary, statusCode: response.statusCode }, 'API performance');
    });

    next();
  });
}
