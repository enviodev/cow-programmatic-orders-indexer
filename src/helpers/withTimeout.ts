/**
 * Bound external I/O inside handlers and effects.
 *
 * Wrap every external call with `withTimeout` (or use `fetchWithTimeout` for
 * HTTP). On `TimeoutError`, log + return without writes — handlers are
 * idempotent, so the next block retries naturally.
 *
 * Ported 1:1 from the upstream ponder indexer.
 */

export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`[COW:timeout] ${label} exceeded ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race `promise` against a `timeoutMs` timer. If the timer wins, reject with a
 * `TimeoutError`. Clears the timer on either resolution.
 *
 * Note: this does NOT cancel the underlying work — for `fetch` use
 * `fetchWithTimeout` below, which threads an `AbortSignal` to close the socket.
 * For viem `multicall` there is no `signal` option; the HTTP request may still
 * resolve in the background and its result will be dropped.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  // Attach a no-op rejection handler before the race so that if the timeout
  // wins and the underlying call later rejects, it doesn't become an unhandled
  // rejection.
  promise.catch(() => {});
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * `fetch` with a hard wall-clock timeout that cancels the underlying socket via
 * `AbortSignal.timeout`. Re-maps the `AbortError` / `TimeoutError` DOMException
 * into our own `TimeoutError` so callers can `instanceof`-check once.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new TimeoutError(label, timeoutMs);
    }
    throw err;
  }
}
