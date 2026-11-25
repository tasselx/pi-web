interface CacheState<T> {
  value?: T;
  expiresAt: number;
  inFlight?: Promise<T>;
}

/**
 * A value fetched by `load` and kept for `ttlMs`. Callers that ask while a
 * fetch is on its way share it; a failed fetch answers with the last value
 * when there is one. The state lives on `globalThis` under `key`, so a dev
 * server's hot reload keeps it.
 *
 * `read(true)` is a forced refresh: it skips the cached value and reports a
 * failure instead of answering with a stale one, for a user asking now.
 */
export function createRefreshingCache<T>(key: string, ttlMs: number, load: () => Promise<T>): (refresh?: boolean) => Promise<T> {
  const slot = Symbol.for(key);
  const state = (): CacheState<T> => {
    const global = globalThis as Record<symbol, CacheState<T> | undefined>;
    return global[slot] ??= { expiresAt: 0 };
  };

  return async (refresh = false) => {
    const cache = state();
    if (!refresh && cache.value !== undefined && cache.expiresAt > Date.now()) return cache.value;
    cache.inFlight ??= load().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + ttlMs;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });

    try {
      return await cache.inFlight;
    } catch (error) {
      if (!refresh && cache.value !== undefined) return cache.value;
      throw error;
    }
  };
}
