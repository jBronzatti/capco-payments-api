export interface FailureLimits {
  /** Failures that block a source until its window ends. */
  limit: number;
  windowMs: number;
  /** Bounds memory: beyond it, the oldest window is dropped. */
  maxSources: number;
}

interface FailureWindow {
  failures: number;
  endsAt: number;
}

/** Fixed-window count of rejected requests per source address. Per instance, in memory. */
export class SourceFailureLimiter {
  private readonly windows = new Map<string, FailureWindow>();

  constructor(
    private readonly limits: FailureLimits,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(source: string): boolean {
    return (this.current(source)?.failures ?? 0) >= this.limits.limit;
  }

  recordFailure(source: string): void {
    const window = this.current(source) ?? this.open(source);
    window.failures += 1;
  }

  private current(source: string): FailureWindow | undefined {
    const window = this.windows.get(source);
    if (window && window.endsAt > this.now()) return window;
    this.windows.delete(source);
    return undefined;
  }

  private open(source: string): FailureWindow {
    if (this.windows.size >= this.limits.maxSources) this.dropOldest();
    const window = { failures: 0, endsAt: this.now() + this.limits.windowMs };
    this.windows.set(source, window);
    return window;
  }

  private dropOldest(): void {
    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value);
  }
}
