/** What the panes say: the list, a session's activity, an agent's detail, and the key hints. */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/domain/store.js';
import type { Focus } from '../../src/tui/layout.js';
import { type ActivityBlock, agentDetail } from '../../src/tui/views/agent-detail.js';
import { agentListItems } from '../../src/tui/views/agent-list.js';
import { keyHints, titleBar } from '../../src/tui/views/chrome.js';
import { helpPanel, taskPanel } from '../../src/tui/views/panels.js';
import { sessionActivity } from '../../src/tui/views/session-activity.js';
import { entryRows } from '../../src/tui/views/timeline-entry.js';
import { event, MINUTE, SECOND } from '../helpers/events.js';
import { plain, words } from '../helpers/rows.js';
import { call, listing, outboxMessage, startAgent } from '../helpers/sessions.js';

const T0 = 1_800_000_000_000;
const WIDTH = 60;

/** The rows of the scrolling part, whichever entries they stand for. */
const rowsOf = (blocks: readonly ActivityBlock[]) => blocks.flatMap((block) => block.rows);

function activity(store: Store, now = T0 + MINUTE, width = WIDTH): string[] {
  const session = store.session('S');
  const content = sessionActivity(store, session, { now, frame: 0, width, heldAt: 0 });

  return plain([...content.header, ...rowsOf(content.body(100))], width);
}

function listed(store: Store, now = T0 + MINUTE): string[] {
  const items = agentListItems(store, { now, frame: 0, recentMs: 10 * MINUTE, showFinished: true });

  return plain(
    items.flatMap((item) => item.rows),
    WIDTH,
  );
}

describe("a session's activity", () => {
  it("puts each agent's entries under its own name", () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    startAgent(store, 'A', T0, { description: 'Review: security' });
    startAgent(store, 'B', T0, { description: 'Review: data path' });
    call(store, T0 + SECOND, { agentId: 'A', id: 'a1', tool: 'Bash', summary: 'npm audit' });
    call(store, T0 + 2 * SECOND, { agentId: 'B', id: 'b1', tool: 'Bash', summary: 'npm test' });

    call(store, T0 + 3 * SECOND, {
      agentId: 'B',
      id: 'b2',
      tool: 'Bash',
      summary: 'npm run build',
    });

    const rows = activity(store);
    const security = rows.indexOf('● security');
    const dataPath = rows.lastIndexOf('● data path');

    expect(security).toBeGreaterThan(-1);
    expect(dataPath).toBeGreaterThan(security);
    expect(rows[dataPath + 1]).toContain('npm test');
    expect(rows[dataPath + 2]).toContain('npm run build'); // same agent: its name is not repeated
  });

  it('wraps long text instead of cutting it', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    const command = Array.from({ length: 40 }, (_, i) => `--flag-number-${i}`).join(' ');

    call(store, T0, { agentId: null, id: 'c1', tool: 'Bash', summary: command, result: 'done' });

    const content = sessionActivity(store, store.session('S'), {
      now: T0 + MINUTE,
      frame: 0,
      width: WIDTH,
      heldAt: 0,
    });

    const body = rowsOf(content.body(100));
    const text = words(body, WIDTH);

    expect(body.length).toBeGreaterThan(10);

    for (let i = 0; i < 40; i++) {
      expect(text).toContain(`--flag-number-${i} `);
    }

    expect(text).not.toContain('…');
  });

  it('shows three or more lookups in a row as one line, and fewer as they are', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    for (const [index, file] of ['a.ts', 'b.ts', 'c.ts', 'd.ts'].entries()) {
      call(store, T0 + index * SECOND, {
        agentId: null,
        id: `r${index}`,
        tool: 'Read',
        summary: file,
      });
    }

    call(store, T0 + 10 * SECOND, { agentId: null, id: 'g1', tool: 'Grep', summary: 'TODO' });
    call(store, T0 + 11 * SECOND, { agentId: null, id: 'g2', tool: 'Grep', summary: 'FIXME' });

    const rows = activity(store).join('\n');

    expect(rows).toContain('Read ×4  a.ts · b.ts · c.ts · d.ts');
    expect(rows).toContain('Grep  TODO');
    expect(rows).toContain('Grep  FIXME');
  });

  it('lists a message that has not been delivered yet, with why it is waiting', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    store.addOutbox('S', outboxMessage('skip the flaky test for now', T0));

    const rows = activity(store).join('\n');

    expect(rows).toContain('NOT DELIVERED YET');
    expect(rows).toContain('skip the flaky test for now');
    expect(rows).toContain('… waiting for its next tool call or turn end');
  });

  it('shows a delivered message in the activity, followed by all the agent said to it', () => {
    const store = new Store();
    const message = outboxMessage('skip the flaky test for now', T0);
    const reply = 'Understood.\n\n1. The flaky test is skipped\n2. The other 41 still run';

    store.syncListing([listing('S')], T0);
    store.addOutbox('S', message);

    store.apply(
      event('message.delivered', T0 + SECOND, {
        sender: 'user',
        nonce: message.nonce,
        via: 'tool',
        text: message.text,
      }),
    );

    store.apply(event('narration', T0 + 2 * SECOND, { text: reply }));

    const rows = activity(store).map((row) => row.slice(10));

    expect(rows.join('\n')).not.toContain('NOT DELIVERED YET');

    expect(rows.slice(-4)).toEqual([
      'Understood.',
      '',
      '1. The flaky test is skipped',
      '2. The other 41 still run',
    ]);

    expect(rows.join(' ')).toContain('✉ your message, delivered at its next tool call:');
  });

  it('holds back what happened after the view was paused or scrolled back', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    call(store, T0, { agentId: null, id: 'c1', tool: 'Bash', summary: 'before' });
    call(store, T0 + MINUTE, { agentId: null, id: 'c2', tool: 'Bash', summary: 'after' });

    const content = sessionActivity(store, store.session('S'), {
      now: T0 + 2 * MINUTE,
      frame: 0,
      width: WIDTH,
      heldAt: T0 + 30 * SECOND,
    });

    const rows = plain(rowsOf(content.body(100)), WIDTH).join('\n');

    expect(rows).toContain('before');
    expect(rows).not.toContain('after');
  });
});

describe('what an agent said, in the activity', () => {
  it('is shown as it was written: its line breaks, its list and its code', () => {
    const store = new Store();

    const said =
      'Two fixes:\n\n- the **parser**\n- its tests\n\n```\nif (ok) {\n    return 1;\n}\n```';

    store.syncListing([listing('S')], T0);
    store.apply(event('narration', T0, { text: said }));

    const rows = activity(store).map((row) => row.slice(10)); // without the time gutter

    expect(rows.slice(-8)).toEqual([
      'Two fixes:',
      '',
      '• the parser',
      '• its tests',
      '',
      'if (ok) {',
      '    return 1;',
      '}',
    ]);
  });
});

describe('a command, in the activity', () => {
  it('is shown under its call as it was written, indentation and all', () => {
    const store = new Store();
    const command = 'for f in *.ts; do\n  wc -l "$f"\ndone';

    store.syncListing([listing('S')], T0);

    store.apply(
      event('tool.started', T0, {
        toolUseId: 'c1',
        tool: 'Bash',
        summary: 'Count the lines of every file',
        detail: command,
      }),
    );

    const rows = activity(store).map((row) => row.slice(10));

    expect(rows.at(-4)).toMatch(/^Bash {2}Count the lines of every file/);
    expect(rows.slice(-3)).toEqual(['$ for f in *.ts; do', '    wc -l "$f"', '  done']);
  });
});

describe('a delivered message in the activity', () => {
  const delivered = (sender: 'user' | 'agent'): string => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    store.apply(
      event('message.delivered', T0, { sender, nonce: 'n', via: 'tool', text: 'ship it' }),
    );

    // Joined into one line: at this width the entry wraps.
    return activity(store).join(' ').replace(/\s+/g, ' ');
  };

  it("is the user's own when the user sent it", () => {
    expect(delivered('user')).toContain('✉ your message, delivered at its next tool call: ship it');
  });

  it("is marked as an agent's when an agent sent it", () => {
    const rows = delivered('agent');

    expect(rows).toContain("✉ an agent's message, delivered at its next tool call: ship it");
    expect(rows).not.toContain('your message');
  });
});

describe('an entry on a narrow pane', () => {
  it('wraps its label instead of cutting it when the label alone fills the row', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    store.apply(
      event('message.delivered', T0, { sender: 'agent', nonce: 'n', via: 'tool', text: 'ship it' }),
    );

    const rows = activity(store, T0 + MINUTE, 38);
    const text = rows.join(' ').replace(/\s+/g, ' ');

    expect(text).toContain("✉ an agent's message, delivered at its next tool call: ship it");
    expect(text).not.toContain('…');
  });
});

describe('the list', () => {
  it('keeps sessions in the order they were first listed, whatever they are doing', () => {
    const store = new Store();

    store.syncListing(
      [listing('older', { startedAt: T0 }), listing('newer', { startedAt: T0 + MINUTE })],
      T0 + MINUTE,
    );

    startAgent(store, 'A', T0 + 2 * MINUTE, { sessionId: 'newer' });

    store.syncListing(
      [
        listing('newer', { status: 'busy', startedAt: T0 + MINUTE }),
        listing('older', { startedAt: T0 }),
      ],
      T0 + 3 * MINUTE,
    );

    const rows = listed(store, T0 + 3 * MINUTE);

    expect(rows.findIndex((row) => row.startsWith('older'))).toBeLessThan(
      rows.findIndex((row) => row.startsWith('newer')),
    );
  });

  it('tells agents whose names begin the same apart', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    startAgent(store, 'A', T0, { description: 'Adversarial review: security' });
    startAgent(store, 'B', T0, { description: 'Adversarial review: data path' });

    const rows = listed(store).join('\n');

    expect(rows).toContain('● security');
    expect(rows).toContain('● data path');
    expect(rows).not.toContain('Adversarial review');
  });

  it('leaves out a session the session list never reported', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    startAgent(store, 'A', T0, { sessionId: 'filtered-out' });

    expect(listed(store).join('\n')).not.toContain('filtered');
  });

  it('says a session needs you while it waits on a permission prompt', () => {
    const store = new Store();

    store.syncListing([listing('S', { status: 'waiting', waitingFor: 'permission prompt' })], T0);

    expect(listed(store)[0]).toMatch(/^S\s+needs you$/);

    expect(
      plain([titleBar(store, { now: T0, paused: false, scrolledBack: false })], 80)[0],
    ).toContain('1 needs you');
  });
});

describe('a session that ended its turn on a question', () => {
  const asking = (): Store => {
    const store = new Store();

    store.syncListing([listing('S', { status: 'idle' }), listing('T', { status: 'idle' })], T0);

    store.apply(
      event('turn.ended', T0 + SECOND, {
        text: 'The build is green.\n\nShall I deploy to production?',
      }),
    );

    store.apply(
      event('turn.ended', T0 + SECOND, { sessionId: 'T', text: 'Done. Everything passes.' }),
    );

    return store;
  };

  const title = (store: Store): string =>
    plain([titleBar(store, { now: T0, paused: false, scrolledBack: false })], 100)[0] ?? '';

  it('is listed as having asked, with what it asked, unlike one that is done', () => {
    const rows = listed(asking());

    expect(rows[0]).toMatch(/^S\s+asked you$/);
    expect(rows[1]).toBe('? Shall I deploy to production?');

    // One that is done is idle, with how it ended under its name all the same.
    const done = rows.findIndex((row) => row.startsWith('T'));

    expect(rows[done]).toMatch(/^T\s+idle$/);
    expect(rows[done + 1]).toBe('↳ Done. Everything passes.');
    expect(title(asking())).toContain('1 asked you');
  });

  it('is busy again once it is answered, and idle when its next turn ends by telling', () => {
    const store = asking();

    store.syncListing([listing('S', { status: 'busy' }), listing('T', { status: 'idle' })], T0);
    store.apply(event('prompt.submitted', T0 + 5 * SECOND, { text: 'Yes, deploy.' }));
    expect(listed(store)[0]).toMatch(/^S\s+busy$/);
    expect(title(store)).not.toContain('asked you');

    store.syncListing([listing('S', { status: 'idle' }), listing('T', { status: 'idle' })], T0);
    store.apply(event('turn.ended', T0 + 9 * SECOND, { text: 'Deployed.' }));
    expect(listed(store)[0]).toMatch(/^S\s+idle$/);
  });

  it('is listed as having asked when it asks for a decision without a question mark', () => {
    const store = new Store();

    store.syncListing([listing('S', { status: 'idle' })], T0);

    store.apply(
      event('turn.ended', T0 + SECOND, {
        text: 'Both designs would work.\n\nLet me know which one you want.',
      }),
    );

    expect(listed(store)[0]).toMatch(/^S\s+asked you$/);
    expect(listed(store)[1]).toBe('? Let me know which one you want.');
  });

  it('counts as needing you, not as asking, while it is blocked on a prompt', () => {
    const store = asking();

    store.syncListing(
      [listing('S', { status: 'waiting', waitingFor: 'permission prompt' }), listing('T')],
      T0,
    );

    expect(listed(store)[0]).toMatch(/^S\s+needs you$/);
    expect(title(store)).toContain('1 needs you');
    expect(title(store)).not.toContain('asked you');
  });
});

describe('the title bar, while the activity is scrolled back', () => {
  const title = (writing: boolean): string => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    return (
      plain([titleBar(store, { now: T0, paused: false, scrolledBack: true, writing })], 100)[0] ??
      ''
    );
  };

  it('says Esc returns to live, except while a message is written, when Esc closes the box', () => {
    expect(title(false)).toContain('SCROLLED BACK · esc for live');
    expect(title(true)).toContain('SCROLLED BACK · ctrl-d for newer');
  });
});

describe('an agent', () => {
  const task = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: do the thing carefully.`).join(
    '\n',
  );

  function detail(width: number): string[] {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    startAgent(store, 'A', T0, { description: 'Port the tests', prompt: task });
    call(store, T0 + SECOND, { agentId: 'A', id: 'c1', tool: 'Bash', summary: 'npm test' });

    const session = store.session('S');
    const agent = session.agents.get('A');

    if (!agent) {
      throw new Error('the agent was not created');
    }

    const content = agentDetail(session, agent, { now: T0 + MINUTE, frame: 0, width, heldAt: 0 });

    return plain([...content.header, ...rowsOf(content.body(50))], width);
  }

  it('shows the start of its task and how to read all of it', () => {
    const rows = detail(80).join('\n');

    expect(rows).toContain('Step 1: do the thing carefully.');
    expect(rows).toContain('Step 2: do the thing carefully.');
    expect(rows).not.toContain('Step 3:');
    expect(rows).toContain('t shows all 12 lines');
  });

  it('has its whole task one key away, every line of it', () => {
    const store = new Store();

    startAgent(store, 'A', T0, { prompt: task });

    const agent = store.session('S').agents.get('A');

    if (!agent) {
      throw new Error('the agent was not created');
    }

    const rows = plain(taskPanel(agent, 80), 80).join('\n');

    for (let step = 1; step <= 12; step++) {
      expect(rows).toContain(`Step ${step}: do the thing`);
    }
  });

  it('never cuts its numbers short, however narrow the pane', () => {
    const rows = detail(30).join(' ');

    expect(rows).not.toContain('…');
    expect(rows).toContain('1 tool call');
  });
});

describe('the help', () => {
  it('wraps what a key does under itself instead of cutting it, at any width', () => {
    for (const columns of [40, 60, 100]) {
      const rows = plain(helpPanel(columns, 0), columns);

      expect(rows.join('\n'), `at ${columns}`).not.toContain('…');

      expect(rows.join(' ').replace(/\s+/g, ' ')).toContain(
        'open the selected entry in full, with all a tool was given and gave back',
      );
    }
  });
});

describe('the rows of an entry', () => {
  it('are laid out once while nothing they show changes, and again when something does', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);
    store.apply(event('narration', T0, { text: 'Looking at the **build** now.' }));

    store.apply(
      event('tool.started', T0 + SECOND, {
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'Run the tests',
      }),
    );

    const [narration, running] = store.session('S').main.timeline.latest(10);
    const ctx = { now: T0 + 5 * SECOND, frame: 0, width: 60 };

    if (!narration || !running) {
      throw new Error('the two entries were not recorded');
    }

    // The very same rows, not rows that merely look the same.
    expect(entryRows(narration, ctx)).toBe(entryRows(narration, ctx));
    expect(entryRows(narration, { ...ctx, width: 30 })).not.toBe(entryRows(narration, ctx));

    // A call still running shows how long it has run: it is laid out every time.
    const early = plain(entryRows(running, ctx), 60).join(' ');
    const later = plain(entryRows(running, { ...ctx, now: T0 + 65 * SECOND }), 60).join(' ');

    expect(early).not.toBe(later);

    store.apply(
      event('tool.ended', T0 + 70 * SECOND, {
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        durationMs: 69_000,
        result: '12 passed',
      }),
    );

    const ended = entryRows(running, ctx);

    expect(plain(ended, 60).join(' ')).toContain('12 passed');
    expect(entryRows(running, { ...ctx, now: T0 + 90 * SECOND })).toBe(ended);
  });
});

describe('the key hints', () => {
  const hints = (
    columns: number,
    writing = false,
    keysInBox = true,
    focus: Focus = 'list',
  ): string =>
    plain(
      [keyHints({ columns, writing, keysInBox, focus, showFinished: true, paused: false })],
      columns,
    )[0] ?? '';

  it('keep messaging, moving, help and quitting on the narrowest terminal', () => {
    const narrow = hints(38);

    for (const key of ['⏎ message', '↑↓ move', '? help', 'q quit']) {
      expect(narrow).toContain(key);
    }

    expect(narrow).not.toContain('…');
  });

  it('say how to get into the activity, and inside it how to select, open and get back', () => {
    expect(hints(80)).toContain('tab into the activity');

    const inside = hints(120, false, true, 'activity');

    expect(inside).toMatch(/^↑↓ select {3}→ open in full {3}tab back to the list {3}⏎ message/);
    expect(inside).toContain('esc live');

    // The narrowest terminal still says how to select and open.
    expect(hints(38, false, true, 'activity')).toBe('↑↓ select   → open in full');
  });

  it('show every key when there is room', () => {
    expect(hints(120)).toContain('p pause');
  });

  it('keep the one thing to remember while a message is being written, and how to read back', () => {
    expect(hints(80, true)).toBe(
      'approvals and answers to its questions go in its own terminal   ctrl-u/d scroll',
    );
  });

  it("carry the keys for writing whenever the box's border has no room for them", () => {
    expect(hints(80, true, false)).toBe(
      '⏎ send   esc keeps draft   alt-⏎ new line   ctrl-u/d scroll',
    );

    // The narrowest terminal: how to send and how to back out, whole.
    expect(hints(38, true, false)).toBe('⏎ send   esc keeps draft');
  });
});
