export interface RefreshCoordinatorOptions<T> {
  performRefresh: () => Promise<T>;
  isTerminalFailure: (error: unknown) => boolean;
  onTerminalFailure: (error: unknown) => void;
}

export interface CrossTabRefreshCoordinatorOptions<T> extends RefreshCoordinatorOptions<T> {
  getCurrentToken: () => T | null;
  runExclusive: (operation: () => Promise<T>) => Promise<T>;
  settlePeerUpdates?: () => Promise<void>;
}

/**
 * Deduplicates refresh-token rotation within one browser tab. A terminal
 * failure is reported exactly once for the shared attempt, while transient
 * failures leave the coordinator ready for a later retry.
 */
export function createRefreshCoordinator<T>(options: RefreshCoordinatorOptions<T>) {
  let inFlight: Promise<T> | null = null;

  return {
    refresh() {
      if (!inFlight) {
        inFlight = options.performRefresh()
          .catch((error) => {
            if (options.isTerminalFailure(error)) options.onTerminalFailure(error);
            throw error;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}

/**
 * Adds a browser-wide exclusive section around the per-tab single-flight
 * coordinator. A tab that receives a peer's refreshed token while waiting for
 * the lock reuses it and does not rotate the shared refresh cookie again.
 */
export function createCrossTabRefreshCoordinator<T>(options: CrossTabRefreshCoordinatorOptions<T>) {
  return createRefreshCoordinator({
    ...options,
    performRefresh: () => {
      const tokenBeforeWaiting = options.getCurrentToken();
      return options.runExclusive(async () => {
        await options.settlePeerUpdates?.();
        const peerToken = options.getCurrentToken();
        if (peerToken !== null && peerToken !== tokenBeforeWaiting) return peerToken;
        return options.performRefresh();
      });
    },
  });
}
