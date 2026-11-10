/**
 * Event counts per minute over a sliding window, for the activity sparkline. O(1) per event and
 * fixed memory, however long an agent runs.
 */
export class ActivityBuckets {
  private readonly counts: Uint32Array;
  private newest = -1;

  constructor(
    private readonly size = 30,
    private readonly bucketMs = 60_000,
  ) {
    this.counts = new Uint32Array(size);
  }

  add(at: number): void {
    const bucket = Math.floor(at / this.bucketMs);

    if (this.newest < 0) {
      this.newest = bucket;
    }

    if (bucket > this.newest) {
      const advance = Math.min(bucket - this.newest, this.size);

      for (let i = 1; i <= advance; i++) {
        this.counts[(this.newest + i) % this.size] = 0;
      }

      this.newest = bucket;
    }

    if (bucket <= this.newest - this.size) {
      return; // older than the window
    }

    this.counts[bucket % this.size] = (this.counts[bucket % this.size] ?? 0) + 1;
  }

  /** Oldest to newest, ending at the bucket that contains `now`. */
  series(now: number): number[] {
    const current = Math.floor(now / this.bucketMs);
    const out: number[] = [];

    for (let bucket = current - this.size + 1; bucket <= current; bucket++) {
      const inWindow =
        this.newest >= 0 && bucket <= this.newest && bucket > this.newest - this.size;

      out.push(inWindow ? (this.counts[bucket % this.size] ?? 0) : 0);
    }

    return out;
  }
}
