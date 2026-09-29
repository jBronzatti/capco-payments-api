/** Caps work in flight. A slot is held until the work really ends, not merely until its caller stops waiting. */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly capacity: number) {}

  /** Runs the work if a slot is free; returns null, without running it, when none is. */
  run<T>(work: () => Promise<T>): Promise<T> | null {
    if (this.active >= this.capacity) return null;
    this.active += 1;
    return Promise.resolve()
      .then(work)
      .finally(() => {
        this.active -= 1;
      });
  }
}
