/** Selecting entries of the activity: what the arrow keys do once they are the activity's. */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/domain/store.js';
import { ActivityView } from '../../src/tui/activity-view.js';
import { event, SECOND } from '../helpers/events.js';
import { plain } from '../helpers/rows.js';
import { listing } from '../helpers/sessions.js';

const T0 = 1_800_000_000_000;
const WIDTH = 60;
const ROOM = 16;

/** A session whose main agent said a short thing, a long one of 20 lines, and a short one. */
function setup() {
  const store = new Store();
  const long = Array.from({ length: 20 }, (_, index) => `long line ${index + 1}`).join('\n');

  store.syncListing([listing('S')], T0);
  store.apply(event('narration', T0 + SECOND, { text: 'before the long one' }));
  store.apply(event('narration', T0 + 2 * SECOND, { text: long }));
  store.apply(event('narration', T0 + 3 * SECOND, { text: 'after the long one' }));

  const view = new ActivityView(store, () => T0 + 60 * SECOND);
  const selection = { session: store.session('S'), agent: null };

  const draw = (): string[] =>
    plain(
      view.rows(selection, {
        now: T0 + 60 * SECOND,
        frame: 0,
        width: WIDTH,
        room: ROOM,
        pausedAt: 0,
      }).rows,
      WIDTH,
    );

  /** The rows that carry the mark of the selected entry, without the mark. */
  const marked = (): string[] =>
    draw()
      .filter((line) => line.startsWith('▌'))
      .map((line) =>
        line
          .slice(1)
          .replace(/^\d\d:\d\d:\d\d\s+/, '')
          .trim(),
      );

  return { view, draw, marked };
}

describe('the activity, once the arrow keys are its own', () => {
  it('has no entry selected until then, and its newest entry selected from then on', () => {
    const { view, marked } = setup();

    expect(marked()).toEqual([]);

    view.selecting(true);
    expect(marked()).toEqual(['after the long one']);
    expect(view.selection).toHaveLength(1);

    view.selecting(false);
    expect(marked()).toEqual([]);
  });

  it('reads an entry taller than the pane a row at a time, then moves on to the next', () => {
    const { view, draw, marked } = setup();

    view.selecting(true);
    draw();

    // Up from the newest: the long entry is selected, its last rows in view.
    view.step(-1);
    expect(marked().at(-1)).toBe('long line 20');
    expect(marked()).not.toContain('long line 1');

    // Further presses bring its earlier rows into view, one at a time, before moving on.
    let presses = 0;

    while (!marked().includes('long line 1') && presses < 40) {
      view.step(-1);
      presses++;
    }

    expect(presses).toBeGreaterThan(3);
    expect(presses).toBeLessThan(25);
    expect(marked()[0]).toBe('long line 1');

    // All of it has been seen: the next press selects the entry before it.
    view.step(-1);
    expect(marked()).toEqual(['before the long one']);

    // And back down through it the same way, to the newest.
    for (let i = 0; i < 40; i++) {
      view.step(1);
    }

    expect(marked()).toEqual(['after the long one']);
    expect(view.isScrolledBack).toBe(false);
  });

  it('keeps something in view selected when the view is scrolled away from the selection', () => {
    const { view, draw, marked } = setup();

    view.selecting(true);
    draw();
    view.scrollToOldest();
    expect(marked()).toEqual(['before the long one']);

    view.scrollToNewest();
    expect(marked()).toEqual(['after the long one']);
  });

  it('selects the entry under a click, and says when it was the selected one already', () => {
    const { view, draw, marked } = setup();

    view.selecting(true);

    const rows = draw();
    const longRow = rows.findIndex((line) => line.includes('long line 12'));

    expect(view.selectAt(longRow)).toBe('selected');
    expect(marked()).toContain('long line 12');
    expect(view.selectAt(longRow)).toBe('again');

    // The rows that stay put above the activity are no entry's.
    expect(view.selectAt(0)).toBe('nothing');
  });
});
