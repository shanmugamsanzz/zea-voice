import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrossTabRefreshCoordinator, createRefreshCoordinator } from '../src/lib/authRefreshCoordinator';
import { isAbortError } from '../src/lib/requestCancellation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('ten simultaneous expired requests share one refresh-token rotation', async () => {
  const attempt = deferred<string>();
  let refreshCalls = 0;
  const coordinator = createRefreshCoordinator({
    performRefresh: () => { refreshCalls += 1; return attempt.promise; },
    isTerminalFailure: () => false,
    onTerminalFailure: () => assert.fail('successful refresh must not expire the session'),
  });
  const waiting = Array.from({ length: 10 }, () => coordinator.refresh());
  assert.equal(refreshCalls, 1);
  attempt.resolve('new-access-token');
  assert.deepEqual(await Promise.all(waiting), Array(10).fill('new-access-token'));
  assert.equal(refreshCalls, 1);
});

test('a later expiry starts one new refresh after the previous attempt settles', async () => {
  let refreshCalls = 0;
  const coordinator = createRefreshCoordinator({
    performRefresh: async () => `token-${++refreshCalls}`,
    isTerminalFailure: () => false,
    onTerminalFailure: () => assert.fail('successful refresh must not expire the session'),
  });
  assert.equal(await coordinator.refresh(), 'token-1');
  assert.equal(await coordinator.refresh(), 'token-2');
  assert.equal(refreshCalls, 2);
});

test('concurrent terminal refresh failure emits one session-expired notification', async () => {
  const attempt = deferred<string>();
  let expiryNotifications = 0;
  const terminalError = Object.assign(new Error('invalid refresh token'), { status: 401 });
  const coordinator = createRefreshCoordinator({
    performRefresh: () => attempt.promise,
    isTerminalFailure: (error) => (error as { status?: number }).status === 401,
    onTerminalFailure: () => { expiryNotifications += 1; },
  });
  const waiting = Array.from({ length: 5 }, () => coordinator.refresh().catch((error) => error));
  attempt.reject(terminalError);
  const errors = await Promise.all(waiting);
  assert.ok(errors.every((error) => error === terminalError));
  assert.equal(expiryNotifications, 1);
});

test('transient refresh failure preserves the session and permits recovery', async () => {
  let refreshCalls = 0;
  let expiryNotifications = 0;
  const coordinator = createRefreshCoordinator({
    performRefresh: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) throw new Error('temporary network failure');
      return 'recovered-token';
    },
    isTerminalFailure: (error) => (error as { status?: number }).status === 401,
    onTerminalFailure: () => { expiryNotifications += 1; },
  });
  await assert.rejects(coordinator.refresh(), /temporary network failure/);
  assert.equal(expiryNotifications, 0);
  assert.equal(await coordinator.refresh(), 'recovered-token');
  assert.equal(refreshCalls, 2);
});

test('all supported cancellation shapes are recognized without hiding real errors', () => {
  class CancelledError extends Error {}
  assert.equal(isAbortError(new DOMException('aborted', 'AbortError')), true);
  assert.equal(isAbortError(new CancelledError('query cancelled')), true);
  assert.equal(isAbortError({ name: 'CancelledError' }), true);
  assert.equal(isAbortError({ code: 'ERR_CANCELED' }), true);
  assert.equal(isAbortError({ code: 'ABORT_ERR' }), true);
  assert.equal(isAbortError(new Error('validation failed')), false);
});

test('two browser tabs share one refresh and adopt the same access token', async () => {
  let lockTail = Promise.resolve();
  const runExclusive = <T>(operation: () => Promise<T>) => {
    const result = lockTail.then(operation, operation);
    lockTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const tokens: Array<string | null> = ['expired-token', 'expired-token'];
  let providerRefreshes = 0;
  const makeTab = (index: number) => createCrossTabRefreshCoordinator({
    getCurrentToken: () => tokens[index],
    runExclusive,
    settlePeerUpdates: async () => undefined,
    performRefresh: async () => {
      providerRefreshes += 1;
      const token = `shared-token-${providerRefreshes}`;
      // Simulate the same-origin BroadcastChannel used by the browser runtime.
      tokens[0] = token;
      tokens[1] = token;
      return token;
    },
    isTerminalFailure: () => false,
    onTerminalFailure: () => assert.fail('cross-tab refresh should succeed'),
  });
  const [first, second] = await Promise.all([makeTab(0).refresh(), makeTab(1).refresh()]);
  assert.equal(first, 'shared-token-1');
  assert.equal(second, 'shared-token-1');
  assert.equal(providerRefreshes, 1);
});
