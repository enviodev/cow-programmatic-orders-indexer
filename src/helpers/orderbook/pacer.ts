/**
 * Request pacing for api.cow.fi, shared by every chain.
 *
 * The API allows ~100 requests/minute per IP per read endpoint and answers a
 * burst with 429 and a 30s Retry-After. Envio's effect rateLimit can't enforce
 * that: with disable_default_cross_chain it counts effect calls per chain, and
 * one call can send several requests (by_uids sends one per 100 UIDs). So the
 * requests themselves are paced here, one lane per endpoint.
 *
 * A request that can't start within maxWaitMs is refused rather than queued.
 * Block handlers await these calls, and envio commits no chain's batch until
 * they return, so a long queue stalls indexing everywhere. Callers already
 * treat a refused request as a partial result and retry on a later block.
 */
export class RequestPacer {
  private nextAt = 0;
  private blockedUntil = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly maxWaitMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserve the next request slot. Returns how long to wait before sending,
   *  or null if that wait would exceed maxWaitMs (nothing is reserved). */
  reserve(): number | null {
    const now = this.now();
    const start = Math.max(now, this.nextAt, this.blockedUntil);
    const wait = start - now;
    if (wait > this.maxWaitMs) return null;
    this.nextAt = start + this.intervalMs;
    return wait;
  }

  /** The API sent 429: hold every request on this lane until the penalty ends. */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}
