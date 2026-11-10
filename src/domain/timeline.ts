export interface Timed {
  readonly at: number;
  /** Arrival order; breaks ties between entries with the same time. */
  readonly seq: number;
}

/**
 * A bounded log kept in time order. Live events arrive in order and append in O(1); history
 * arrives file by file, out of order, and is inserted by binary search, so "the newest" always
 * means the newest by time and never the last to arrive.
 */
export class Timeline<T extends Timed> implements Iterable<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  insert(item: T): void {
    const last = this.items[this.items.length - 1];

    if (!last || !isBefore(item, last)) {
      this.items.push(item);
    } else {
      let lo = 0;
      let hi = this.items.length;

      while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (isBefore(item, this.items[mid]!)) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }

      this.items.splice(lo, 0, item);
    }

    // Trimmed in batches so a full log does not shift on every insert.
    if (this.items.length > this.capacity + TRIM_SLACK) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** Up to `count` of the newest items that pass `accept`, oldest first, after skipping `skip`. */
  latest(count: number, accept?: (item: T) => boolean, skip = 0): T[] {
    const out: T[] = [];
    let toSkip = skip;

    for (let i = this.items.length - 1; i >= 0 && out.length < count; i--) {
      const item = this.items[i]!;

      if (accept && !accept(item)) {
        continue;
      }

      if (toSkip > 0) {
        toSkip--;
        continue;
      }

      out.push(item);
    }

    return out.reverse();
  }

  /** How many items pass `accept`. */
  count(accept: (item: T) => boolean): number {
    let n = 0;

    for (const item of this.items) {
      if (accept(item)) {
        n++;
      }
    }

    return n;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }
}

const TRIM_SLACK = 256;

function isBefore(a: Timed, b: Timed): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}
