import { describe, expect, it } from 'vitest';
import { ActivityBuckets } from '../../src/domain/activity-buckets.js';
import { Timeline } from '../../src/domain/timeline.js';

const item = (at: number, seq: number) => ({ at, seq });

describe('a timeline', () => {
  it('keeps entries in time order however they arrive', () => {
    const timeline = new Timeline<{ at: number; seq: number }>(100);

    for (const [at, seq] of [
      [5, 1],
      [1, 2],
      [3, 3],
      [9, 4],
      [3, 5],
      [0, 6],
    ] as const) {
      timeline.insert(item(at, seq));
    }

    expect([...timeline].map((entry) => entry.at)).toEqual([0, 1, 3, 3, 5, 9]);

    expect([...timeline].filter((entry) => entry.at === 3).map((entry) => entry.seq)).toEqual([
      3, 5,
    ]);
  });

  it('returns the newest entries that match, oldest first, and can skip the newest ones', () => {
    const timeline = new Timeline<{ at: number; seq: number }>(100);

    for (let i = 1; i <= 10; i++) {
      timeline.insert(item(i, i));
    }

    expect(timeline.latest(3).map((entry) => entry.at)).toEqual([8, 9, 10]);

    expect(timeline.latest(3, (entry) => entry.at % 2 === 0).map((entry) => entry.at)).toEqual([
      6, 8, 10,
    ]);

    expect(timeline.latest(2, undefined, 3).map((entry) => entry.at)).toEqual([6, 7]);
  });

  it('never grows past its capacity by more than its trim batch, and keeps the newest', () => {
    const timeline = new Timeline<{ at: number; seq: number }>(100);

    for (let i = 1; i <= 2000; i++) {
      timeline.insert(item(i, i));
    }

    expect(timeline.size).toBeLessThanOrEqual(100 + 256);
    expect(timeline.latest(1)[0]!.at).toBe(2000);
  });
});

describe('activity buckets', () => {
  it('count events per minute and roll the window forward', () => {
    const buckets = new ActivityBuckets(3, 60_000);
    const t0 = 10 * 60_000;

    buckets.add(t0);
    buckets.add(t0 + 1000);
    buckets.add(t0 + 60_000);
    expect(buckets.series(t0 + 60_000)).toEqual([0, 2, 1]);
    buckets.add(t0 + 4 * 60_000);
    expect(buckets.series(t0 + 4 * 60_000)).toEqual([0, 0, 1]);
    buckets.add(t0); // older than the window
    expect(buckets.series(t0 + 4 * 60_000)).toEqual([0, 0, 1]);
  });
});
