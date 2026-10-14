import { RunnerError, assertActive } from './errors.js';
export async function runBatch(jobs, { concurrency = 1, maximumSessions = 10, run, signal } = {}) {
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > maximumSessions || !Number.isInteger(maximumSessions) || maximumSessions < 1 || maximumSessions > 10
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10 || typeof run !== 'function') {
    throw new RunnerError('BATCH_CONFIG', 'Batch requires bounded jobs and concurrency.');
  }
  const results = Array(jobs.length); let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      assertActive(signal); const index = cursor++;
      try { results[index] = { index, status: 'completed', result: await run(jobs[index], signal) }; }
      catch (error) { results[index] = { index, status: 'failed', code: error instanceof RunnerError ? error.code : 'UNEXPECTED_FAILURE' }; }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  assertActive(signal);
  return results;
}

