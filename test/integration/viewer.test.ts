/**
 * The full-screen view, driven the way a person drives it: keys, pastes and resizes go in, and
 * what is on the screen comes out.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PastSession,
  SessionHistoryPort,
} from '../../src/application/ports/session-history.port.js';
import type { ToolExchangePort } from '../../src/application/ports/tool-exchange.port.js';
import type { SendMessageInput } from '../../src/application/send-message.service.js';
import { Store } from '../../src/domain/store.js';
import { Viewer } from '../../src/tui/viewer.js';
import { event, MINUTE, SECOND } from '../helpers/events.js';
import { call, listing, outboxMessage, startAgent } from '../helpers/sessions.js';
import { FakeTerminal } from '../helpers/terminal.js';

const T0 = 1_800_000_000_000;
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_U = '\x15';
const CTRL_D = '\x04';
/** Longer than the wait that tells a lone Esc from the start of an escape sequence. */
const ESCAPE_SETTLES_MS = 80;

const open: Viewer[] = [];

afterEach(() => {
  for (const viewer of open.splice(0)) {
    viewer.stop();
  }
});

interface SetupOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly sendFails?: boolean;
  /** Sending waits for this, the way signing waits for a fingerprint. */
  readonly signature?: Promise<void>;
  /** The terminal is asked to report the mouse. */
  readonly mouse?: boolean;
  /** Where a tool call's whole input and output come from. */
  readonly toolExchange?: Pick<ToolExchangePort, 'find'>;
  /** The sessions that are over. */
  readonly history?: SessionHistoryPort;
}

function setup(options: SetupOptions = {}) {
  const store = new Store();
  const terminal = new FakeTerminal(options.columns ?? 120, options.rows ?? 30);
  const sent: SendMessageInput[] = [];
  const state = { now: T0 + MINUTE, quits: 0, copied: [] as string[] };

  const viewer = new Viewer({
    store,
    watch: { warnings: new Map(), ready: true },
    sendMessage: {
      async send(input) {
        if (options.sendFails) {
          throw new Error('the disk is full');
        }

        await options.signature;
        sent.push(input);

        return outboxMessage(input.text, state.now);
      },
    },
    inbox: { hasWaiter: () => false },
    recentMs: 10 * MINUTE,
    hooksInstalled: () => true,
    copyToClipboard: (text) => {
      state.copied.push(text);

      return true;
    },
    color: false,
    mouse: options.mouse,
    toolExchange: options.toolExchange,
    history: options.history,
    input: terminal.input,
    output: terminal.output,
    onQuit: () => {
      state.quits++;
    },
    now: () => state.now,
  });

  open.push(viewer);

  const redraw = async () => {
    viewer.render();
    await terminal.settle();
  };

  return { store, terminal, viewer, sent, state, redraw };
}

/** Two sessions that can be messaged; `alpha` was listed first. */
function twoSessions(store: Store): void {
  store.syncListing(
    [listing('alpha', { startedAt: T0 }), listing('beta', { startedAt: T0 + SECOND })],
    T0 + SECOND,
  );

  store.setCanMessage('alpha', true);
  store.setCanMessage('beta', true);
}

describe('sending a message', () => {
  it('shows where to write before any key is pressed', () => {
    const { store, terminal, viewer } = setup();

    twoSessions(store);
    viewer.start();
    expect(terminal.text()).toContain('┌ To alpha');
    expect(terminal.text()).toContain('⏎ write a message');
    expect(terminal.text()).toContain('⏎ message');
  });

  it('goes to the selected session when Enter is pressed twice around the text', async () => {
    const { store, terminal, viewer, sent } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type('j'); // down to beta
    await terminal.type(ENTER);
    await terminal.type('run the linter too');
    expect(terminal.text()).toContain('│ run the linter too');
    expect(terminal.cursor).not.toBeNull();
    await terminal.type(ENTER);

    expect(sent).toEqual([
      { sessionId: 'beta', text: 'run the linter too', aboutAgentId: null, aboutLabel: null },
    ]);

    expect(terminal.text()).toContain('… waiting for its next tool call or turn end');
    expect(terminal.cursor).toBeNull();
  });

  it('goes to the session the box was opened for, even if the list changes while typing', async () => {
    const { store, terminal, viewer, sent, redraw } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type('j');
    await terminal.type(ENTER);
    await terminal.type('first half, ');

    // While typing: an older session appears above, beta gets busy agents, alpha goes away.
    store.syncListing(
      [listing('older', { startedAt: T0 - MINUTE }), listing('beta', { status: 'busy' })],
      T0 + 2 * SECOND,
    );

    store.syncListing(
      [listing('older', { startedAt: T0 - MINUTE }), listing('beta', { status: 'busy' })],
      T0 + 3 * SECOND,
    );

    startAgent(store, 'A', T0 + 3 * SECOND, { sessionId: 'beta' });
    await redraw();
    expect(terminal.text()).toContain('┌ To beta');

    await terminal.type('second half');
    await terminal.type(ENTER);

    expect(sent.map((message) => [message.sessionId, message.text])).toEqual([
      ['beta', 'first half, second half'],
    ]);
  });

  it('says which subagent a message is about when one is selected', async () => {
    const { store, terminal, viewer, sent } = setup();

    twoSessions(store);
    startAgent(store, 'A', T0, { sessionId: 'alpha', description: 'Port the tests' });
    viewer.start(); // a running agent is selected to begin with
    await terminal.type(ENTER);
    expect(terminal.text()).toContain('┌ To alpha · about Port the tests');
    await terminal.type(`check the fixtures${ENTER}`);

    expect(sent).toEqual([
      {
        sessionId: 'alpha',
        text: 'check the fixtures',
        aboutAgentId: 'A',
        aboutLabel: 'Port the tests',
      },
    ]);
  });

  it('takes a large paste with line breaks as one draft and sends nothing until Enter', async () => {
    const { store, terminal, viewer, sent } = setup();

    twoSessions(store);
    viewer.start();

    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the log, quit j k d p`);

    await terminal.paste(lines.join('\n'));

    expect(sent).toEqual([]);
    expect(terminal.text()).toContain('┌ To alpha');
    expect(terminal.cursor).not.toBeNull(); // the box is open with the paste in it

    await terminal.type(ENTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(lines.join('\n')); // its line breaks are kept, as line breaks
  });

  it('grows with what is written, up to six rows, and takes a new line from Alt+Enter', async () => {
    const { store, terminal, viewer, sent } = setup();

    const body = () =>
      terminal.screen().filter((line) => line.startsWith('│ ') && line.endsWith(' │'));

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('first line');
    expect(body()).toHaveLength(1);

    await terminal.type('\x1b\r'); // Alt+Enter
    await terminal.type('second line');

    expect(body().map((line) => line.slice(2).trimEnd().replace(/ │$/, '').trimEnd())).toEqual([
      'first line',
      'second line',
    ]);

    for (let i = 3; i <= 9; i++) {
      await terminal.type(`\x1b\rline ${i}`);
    }

    expect(body()).toHaveLength(6);
    expect(terminal.text()).toContain('│ line 9');
    expect(terminal.text()).toContain('rows 4-9 of 9 ─┐');
    expect(terminal.screen().length).toBeLessThanOrEqual(30);

    await terminal.type(ENTER);
    expect(sent[0]?.text.split('\n')).toHaveLength(9);
    expect(body()).toHaveLength(1);
  });

  it('names the keys for writing whole at every width: in the border, or in the row under it', async () => {
    const { store, terminal, viewer } = setup({ columns: 80, rows: 24 });

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('ping');
    expect(terminal.text()).toContain('└ ⏎ send · alt-⏎ new line · esc keeps draft ─');
    expect(terminal.text()).toContain('idle: at its next turn ─┘');

    await terminal.resize(60, 24);
    expect(terminal.text()).toContain('⏎ send   esc keeps draft   alt-⏎ new line');
    expect(terminal.text()).toContain('idle: at its next turn ─┘');

    await terminal.resize(40, 10);
    expect(terminal.text()).toContain('⏎ send   esc keeps draft');
    expect(terminal.text()).toContain('idle: at its next turn ─┘');
    expect(terminal.text()).toContain('│ ping');
  });

  it('keeps all of a paste longer than a message holds, says so, and sends only once it fits', async () => {
    const { store, terminal, viewer, sent, state, redraw } = setup();
    const long = `${'word '.repeat(900)}the end`; // 4,507 characters

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.paste(long);

    // Nothing was dropped: the end of the paste is there, and the box says how far over it is.
    expect(terminal.text()).toContain('the end');
    expect(terminal.text()).toContain('4,507/4,000');
    expect(terminal.text()).toContain('507 characters too long ─┘');

    await terminal.type(ENTER);
    expect(sent).toEqual([]);
    expect(terminal.text()).toContain('Not sent: 507 characters too long, a message holds 4,000.');
    expect(terminal.text()).toContain('the end'); // the draft is still all there

    // Cut down to size, it goes, whole.
    for (let i = 0; i < 110; i++) {
      await terminal.type('\x17'); // Ctrl-W: the word before the cursor
    }

    state.now += 10 * SECOND; // the notice has had its time
    await redraw();
    expect(terminal.text()).not.toContain('too long');

    await terminal.type(ENTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.length).toBeLessThanOrEqual(4000);
    expect(sent[0]?.text.startsWith('word word')).toBe(true);
  });

  it('takes a paste far too long to be a message whole or not at all, and says which', async () => {
    const { store, terminal, viewer } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('kept ');
    await terminal.paste('x'.repeat(50_000));

    expect(terminal.text()).toContain('Not added: that would make 50,005 characters');
    expect(terminal.text()).toContain('│ kept');
    expect(terminal.text()).not.toContain('xxxx');
  });

  it('keeps nothing of a draft that is only line breaks and spaces', async () => {
    const { store, terminal, viewer, sent } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('\x1b\r'); // Alt+Enter, twice, by a slip of the hand
    await terminal.type('\x1b\r');
    await terminal.type(ENTER);

    expect(sent).toEqual([]);
    expect(terminal.text()).not.toContain('draft:');
    expect(terminal.text()).toContain('⏎ write a message');
  });

  it('keeps a draft when the box is closed, and continues it when reopened', async () => {
    const { store, terminal, viewer, sent } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('not sure yet');
    await terminal.type(ESC);
    await terminal.settle(ESCAPE_SETTLES_MS);

    expect(sent).toEqual([]);
    expect(terminal.text()).toContain('draft: not sure yet');
    expect(terminal.text()).toContain('⏎ continue the draft');

    await terminal.type(ENTER);
    await terminal.type(`, but go on${ENTER}`);
    expect(sent.map((message) => message.text)).toEqual(['not sure yet, but go on']);
  });

  it('waits while the message is signed, takes no keys meanwhile, and sends it once', async () => {
    let touchSensor: () => void = () => {};

    const signature = new Promise<void>((resolve) => {
      touchSensor = resolve;
    });

    const { store, terminal, viewer, sent, redraw } = setup({ signature });

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type(`ping${ENTER}`);
    expect(terminal.text()).toContain('sending: use Touch ID if asked');

    await terminal.type(ENTER); // pressed again while it waits
    await terminal.type(' pong');
    expect(sent).toEqual([]);
    expect(terminal.text()).toContain('│ ping');

    touchSensor();
    await terminal.settle();
    await redraw();
    expect(sent.map((message) => message.text)).toEqual(['ping']);
    expect(terminal.text()).not.toContain('sending:');
  });

  it('keeps the draft and says why when sending fails', async () => {
    const { store, terminal, viewer } = setup({ sendFails: true });

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type(`important${ENTER}`);

    expect(terminal.text()).toContain('Could not send, your draft is kept: the disk is full');
    expect(terminal.text()).toContain('│ important');
  });

  it('sends nothing to a session that ended while the message was written', async () => {
    const { store, terminal, viewer, sent, redraw } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('are you there');
    store.apply(event('session.ended', T0 + 2 * SECOND, { sessionId: 'alpha' }));
    await redraw();
    expect(terminal.text()).toContain('session ended: your draft is kept');

    await terminal.type(ENTER);
    expect(sent).toEqual([]);
    expect(terminal.text()).toContain('alpha has ended, so nothing was sent. Your draft is kept.');
  });

  it('explains a session that cannot be reached yet instead of opening the box', async () => {
    const { store, terminal, viewer, sent, state } = setup();

    store.syncListing([listing('alpha')], T0);
    viewer.start();
    expect(terminal.text()).toContain("alpha can't receive messages yet");

    await terminal.type(ENTER);
    expect(terminal.text()).toContain("It hasn't run agentwatch's hooks since they were installed");
    expect(terminal.cursor).toBeNull();
    await terminal.type('y');
    expect(state.copied).toEqual(['claude --resume alpha']);
    expect(sent).toEqual([]);
  });
});

describe('reading activity', () => {
  function busySession(store: Store, calls: number): void {
    store.syncListing([listing('alpha', { status: 'busy' })], T0);

    for (let i = 0; i < calls; i++) {
      call(store, T0 + i * SECOND, {
        sessionId: 'alpha',
        agentId: null,
        id: `c${i}`,
        tool: 'Bash',
        summary: `command number ${i}`,
      });
    }
  }

  it('shows the newest activity, and older activity after scrolling back', async () => {
    const { store, terminal, viewer } = setup();

    busySession(store, 80);
    viewer.start();
    expect(terminal.text()).toContain('command number 79');
    expect(terminal.text()).not.toContain('command number 40 ');

    for (let i = 0; i < 4; i++) {
      await terminal.type(CTRL_U);
    }

    expect(terminal.text()).not.toContain('command number 79');
    expect(terminal.text()).toContain('SCROLLED BACK');
  });

  it('scrolls the pane under the pointer with the wheel, and selects with a click', async () => {
    const { store, terminal, viewer, state } = setup({ mouse: true });

    state.now = T0 + 5 * MINUTE; // after every entry, as the present is
    busySession(store, 80);
    store.syncListing([listing('alpha', { status: 'busy' }), listing('beta')], T0);
    viewer.start();
    expect(terminal.reportsMouse).toBe(true);
    expect(terminal.text()).toContain('command number 79');

    const lastShown = (): number =>
      Number(
        terminal
          .screen()
          .filter((line) => line.includes('command number'))
          .at(-1)
          ?.match(/command number (\d+)/)?.[1],
      );

    // Over the activity, on the right: three rows a step, and the selection stays.
    await terminal.mouse('wheel-up', 10, 80);

    const afterOne = lastShown();

    await terminal.mouse('wheel-up', 10, 80);
    expect(terminal.text()).toContain('SCROLLED BACK');
    expect(terminal.text()).not.toContain('command number 79');
    expect(afterOne - lastShown()).toBe(3);
    expect(terminal.text()).toContain('▌ alpha');

    await terminal.mouse('wheel-down', 10, 80);
    await terminal.mouse('wheel-down', 10, 80);
    expect(terminal.text()).toContain('command number 79');
    expect(terminal.text()).not.toContain('SCROLLED BACK');

    // A click in the activity moves into it and selects the entry under the pointer.
    await terminal.mouse('press', 10, 80);
    expect(terminal.text()).toContain('↑↓ select   → open in full');
    expect(terminal.screen()[10]).toMatch(/▌\d\d:\d\d:\d\d {2}Bash {2}command number/);

    // A click on the selected entry opens it in full.
    await terminal.mouse('press', 10, 80);
    expect(terminal.text()).toContain('ENTRY');

    // A click on a row of the list selects it, and gives the keys back to the list.
    const betaRow = terminal.screen().findIndex((line) => line.includes('beta'));

    await terminal.mouse('press', betaRow, 5);
    expect(terminal.text()).toContain('▌ beta');
    expect(terminal.text()).not.toContain('ENTRY');
    expect(terminal.text()).toContain('tab into the activity');

    viewer.stop();
    expect(terminal.reportsMouse).toBe(false);
  });

  it('scrolls the activity with the wheel while a message is being written, and clicks nothing', async () => {
    const { store, terminal, viewer } = setup({ mouse: true });

    busySession(store, 80);
    store.syncListing([listing('alpha', { status: 'busy' }), listing('beta')], T0);
    store.setCanMessage('alpha', true);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('a draft');

    await terminal.mouse('wheel-up', 10, 80);
    expect(terminal.text()).toContain('SCROLLED BACK');
    expect(terminal.text()).toContain('│ a draft');

    const betaRow = terminal.screen().findIndex((line) => line.includes('beta'));

    await terminal.mouse('press', betaRow, 5);
    expect(terminal.text()).toContain('▌ alpha');
    expect(terminal.text()).toContain('To alpha');
  });

  it('leaves the mouse to the terminal when it is not asked to report it', async () => {
    const { store, terminal, viewer } = setup();

    busySession(store, 10);
    viewer.start();
    expect(terminal.reportsMouse).toBe(false);
  });

  it('moves into the activity with Tab: an entry is selected, the arrows move it, → opens it', async () => {
    const { store, terminal, viewer } = setup({
      toolExchange: {
        find: ({ toolUseId }) => ({
          input: `command: run ${toolUseId} --all`,
          result: 'first line of the output\nand the whole rest of it',
        }),
      },
    });

    const TAB = '\t';
    const UP = '\x1b[A';
    const DOWN = '\x1b[B';

    /** The number of the command on the row that carries the mark of the selected entry. */
    const selected = (): number | null => {
      const line = terminal.screen().find((each) => /▌\d\d:\d\d:\d\d/.test(each));

      return line ? Number(line.match(/command number (\d+)/)?.[1]) : null;
    };

    busySession(store, 80);
    store.syncListing([listing('alpha', { status: 'busy' }), listing('beta')], T0);
    viewer.start();
    expect(terminal.text()).toContain('tab into the activity');
    expect(selected()).toBeNull();

    // Into the activity: its newest entry is selected, and what arrives meanwhile waits.
    await terminal.type(TAB);

    const newest = selected();

    expect(newest).not.toBeNull();
    expect(terminal.text()).toContain('HELD WHILE YOU SELECT · esc for live');
    expect(terminal.text()).toContain('↑↓ select   → open in full   tab back to the list');
    expect(terminal.text()).toContain('━');

    await terminal.type(UP);
    await terminal.type(UP);
    expect(selected()).toBe((newest ?? 0) - 2);
    expect(terminal.text()).toContain('▌ alpha'); // the list's selection did not move

    await terminal.type(DOWN);
    expect(selected()).toBe((newest ?? 0) - 1);

    // The right arrow opens the selected entry: what the tool was given and gave back, whole.
    await terminal.type('\x1b[C');
    expect(terminal.text()).toContain('ENTRY  main · in alpha');
    expect(terminal.text()).toContain(`command: run c${(newest ?? 0) - 1} --all`);
    expect(terminal.text()).toContain('and the whole rest of it');
    expect(terminal.text()).toContain('← back to the activity');

    // The left arrow closes it; the selection is where it was.
    await terminal.type('\x1b[D');
    expect(terminal.text()).not.toContain('ENTRY');
    expect(selected()).toBe((newest ?? 0) - 1);

    // To the oldest entry and back to the newest in one key each.
    await terminal.type('g');
    expect(selected()).toBe(0);

    await terminal.type('G');
    expect(selected()).toBe(newest);

    // Tab gives the arrow keys back to the list.
    await terminal.type(TAB);
    expect(selected()).toBeNull();

    await terminal.type(DOWN);
    expect(terminal.text()).toContain('▌ beta');
    expect(terminal.text()).not.toContain('━');
  });

  it('gives the arrow keys back to the list on Esc, at the newest activity', async () => {
    const { store, terminal, viewer } = setup();

    busySession(store, 80);
    viewer.start();
    await terminal.type('\x1b[C'); // the right arrow moves into the activity too
    await terminal.type('\x1b[A');
    expect(terminal.text()).toContain('HELD WHILE YOU SELECT');

    await terminal.type('\x1b');
    await terminal.settle(60);
    expect(terminal.text()).not.toContain('HELD');
    expect(terminal.text()).not.toContain('SCROLLED BACK');
    expect(terminal.text()).toContain('tab into the activity');
  });

  it('scrolls while a message is being written, and never costs a line of the draft', async () => {
    const { store, terminal, viewer, sent } = setup();

    busySession(store, 80);
    store.setCanMessage('alpha', true);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type('first line');
    await terminal.type('\x1b\r');
    await terminal.type('second line');

    await terminal.type(CTRL_U); // scrolls here too: it used to wipe the draft
    await terminal.type('\x1b[5~'); // PageUp
    expect(terminal.text()).toContain('SCROLLED BACK · ctrl-d for newer');
    expect(terminal.text()).not.toContain('command number 79');
    expect(terminal.text()).toContain('│ first line');
    expect(terminal.text()).toContain('│ second line');
    expect(terminal.text()).toContain('ctrl-u/d scroll');

    await terminal.type(CTRL_D);
    await terminal.type('\x1b[6~'); // PageDown
    expect(terminal.text()).toContain('command number 79');
    expect(terminal.text()).not.toContain('SCROLLED BACK');

    await terminal.type(ENTER);
    expect(sent.map((message) => message.text)).toEqual(['first line\nsecond line']);
  });

  it('holds still while scrolled back, and catches up when returned to live', async () => {
    const { store, terminal, viewer, state, redraw } = setup();

    busySession(store, 80);
    viewer.start();
    await terminal.type(CTRL_U);

    const held = terminal.text();

    state.now += 5 * SECOND;

    call(store, state.now, {
      sessionId: 'alpha',
      agentId: null,
      id: 'new',
      tool: 'Bash',
      summary: 'brand new command',
    });

    await redraw();

    const activity = (text: string) => text.split('\n').filter((line) => line.includes('command'));

    expect(activity(terminal.text())).toEqual(activity(held));

    await terminal.type(CTRL_D);
    expect(terminal.text()).toContain('brand new command');
    expect(terminal.text()).not.toContain('SCROLLED BACK');
  });

  it('cannot be scrolled past the oldest entry', async () => {
    const { store, terminal, viewer } = setup();

    busySession(store, 30);
    viewer.start();

    for (let i = 0; i < 20; i++) {
      await terminal.type(CTRL_U);
    }

    expect(terminal.text()).toContain('command number 0 ');

    await terminal.type(CTRL_D);
    expect(terminal.text()).not.toContain('command number 0 '); // one page forward moved the view
  });

  it("opens an agent's whole task with t and closes it with Esc", async () => {
    const { store, terminal, viewer } = setup();

    store.syncListing([listing('alpha')], T0);

    const task = Array.from({ length: 9 }, (_, i) => `Requirement ${i + 1}.`).join('\n');

    startAgent(store, 'A', T0, { sessionId: 'alpha', description: 'Port the tests', prompt: task });
    viewer.start();
    expect(terminal.text()).toContain('t shows all 9 lines');
    expect(terminal.text()).not.toContain('Requirement 9.');

    await terminal.type('t');
    expect(terminal.text()).toContain('Requirement 9.');
    await terminal.type(ESC);
    await terminal.settle(ESCAPE_SETTLES_MS);
    expect(terminal.text()).not.toContain('Requirement 9.');
  });

  it('hides finished agents with d and shows them again', async () => {
    const { store, terminal, viewer } = setup();

    store.syncListing([listing('alpha')], T0);
    startAgent(store, 'A', T0, { sessionId: 'alpha', description: 'Already done' });
    store.apply(event('agent.stopped', T0 + SECOND, { sessionId: 'alpha', agentId: 'A' }));
    viewer.start();
    expect(terminal.text()).toContain('✓ Already done');

    await terminal.type('d');
    expect(terminal.text()).not.toContain('✓ Already done');
    await terminal.type('d');
    expect(terminal.text()).toContain('✓ Already done');
  });
});

describe('the selected agent', () => {
  it('is marked on its title only, not on the line that says what it is doing', async () => {
    const { store, terminal, viewer } = setup();

    store.syncListing([listing('alpha', { status: 'busy' })], T0);
    startAgent(store, 'A', T0, { sessionId: 'alpha', description: 'Port the tests' });

    store.apply(
      event('tool.started', T0 + SECOND, {
        sessionId: 'alpha',
        agentId: 'A',
        toolUseId: 'c1',
        tool: 'Bash',
        summary: 'npm test',
      }),
    );

    viewer.start();

    const marked = terminal.screen().filter((line) => line.startsWith('▌'));

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Port the tests');
    expect(terminal.text()).toMatch(/\n {6}Bash/); // what it is doing: indented, unmarked
  });
});

describe('the terminal', () => {
  it('still shows the message box and the keys at 40 by 10', async () => {
    const { store, terminal, viewer } = setup({ columns: 40, rows: 10 });

    twoSessions(store);
    viewer.start();

    const screen = terminal.screen();

    expect(screen.length).toBeLessThanOrEqual(10);
    expect(terminal.text()).toContain('┌ To alpha');
    expect(screen.at(-1)).toContain('⏎ message');
    expect(screen.at(-1)).toContain('q quit');

    await terminal.type(ENTER);
    await terminal.type('fits');
    expect(terminal.text()).toContain('│ fits');
  });

  it('says what it needs when it is smaller than that, and recovers when enlarged', async () => {
    const { store, terminal, viewer } = setup({ columns: 30, rows: 8 });

    twoSessions(store);
    viewer.start();
    expect(terminal.text()).toContain('agentwatch needs at least 40');

    await terminal.resize(120, 30);
    expect(terminal.text()).toContain('┌ To alpha');
  });

  it('is given back as it was on q, and the viewer says it quit once', async () => {
    const { store, terminal, viewer, state } = setup();

    twoSessions(store);
    viewer.start();
    expect(terminal.fullScreen).toBe(true);
    expect(terminal.rawMode).toBe(true);

    await terminal.type('q');
    expect(terminal.fullScreen).toBe(false);
    expect(terminal.rawMode).toBe(false);
    expect(state.quits).toBe(1);
    viewer.stop(); // again, as a signal handler would: harmless
    expect(state.quits).toBe(1);
  });

  it('does not quit on q typed into a message', async () => {
    const { store, terminal, viewer, state, sent } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type(ENTER);
    await terminal.type(`quit quietly${ENTER}`);
    expect(state.quits).toBe(0);
    expect(sent.map((message) => message.text)).toEqual(['quit quietly']);
  });
});

describe('the history of sessions that are over', () => {
  const HOUR = 60 * MINUTE;

  const past = (sessionId: string, title: string, endedAt: number, asks = false): PastSession => ({
    sessionId,
    title,
    cwd: `/work/${sessionId}`,
    endedAt,
    agentCount: sessionId === 'old1' ? 3 : 0,
    closing: { line: asks ? 'Shall I also remove the old retry?' : 'All done.', asks },
  });

  /** A history of two past sessions; opening one gives a store with what it did. */
  function history(): SessionHistoryPort & { opened: string[] } {
    const sessions = [
      past('old1', 'Rebuild prototype cleanly', T0 - 2 * HOUR),
      past('old2', 'Fix the flaky upload test', T0 - 30 * HOUR, true),
      past('alpha', 'still running', T0),
    ];

    const opened: string[] = [];

    return {
      opened,
      list: () => sessions,
      open(session) {
        const store = new Store();

        opened.push(session.sessionId);
        store.syncListing([{ sessionId: session.sessionId, name: session.title }], session.endedAt);

        store.apply(
          event('narration', session.endedAt - SECOND, {
            sessionId: session.sessionId,
            text: `what ${session.sessionId} did`,
          }),
        );

        store.apply(event('session.ended', session.endedAt, { sessionId: session.sessionId }));

        return store;
      },
    };
  }

  it('is a second list beside the live one: h switches, and a past session shows what it did', async () => {
    const port = history();
    const { store, terminal, viewer, sent } = setup({ history: port });

    twoSessions(store);
    viewer.start();
    expect(terminal.text()).toContain('Live │ History');
    expect(terminal.text()).toContain('h history');
    expect(terminal.text()).toContain('▌ alpha');

    await terminal.type('h');

    // Newest first; a session that is still running is not history yet.
    expect(terminal.text()).toContain('History (2)');
    expect(terminal.text()).toContain('▌ Rebuild prototype cleanly');
    expect(terminal.text()).toContain('/work/old1 · 3 agents');
    expect(terminal.text()).toContain('↳ All done.');
    expect(terminal.text()).not.toContain('still running');
    expect(terminal.text()).toContain('what old1 did');
    expect(terminal.text()).toContain('h live');

    await terminal.type('j');
    expect(terminal.text()).toContain('▌ Fix the flaky upload test');
    expect(terminal.text()).toContain('? Shall I also remove the old retry?');
    expect(terminal.text()).toContain('what old2 did');

    // What a session did is read when it is selected, not again on every frame.
    await terminal.type('k');
    await terminal.type('j');
    expect(port.opened).toEqual(['old1', 'old2', 'old1', 'old2']);

    // A session that is over cannot be written to.
    await terminal.type(ENTER);
    expect(terminal.text()).toContain('has ended');
    expect(sent).toEqual([]);

    await terminal.type('h');
    expect(terminal.text()).toContain('▌ alpha');
    expect(terminal.text()).not.toContain('Rebuild prototype cleanly');
  });

  it('is not offered where there is no history to show', async () => {
    const { store, terminal, viewer } = setup();

    twoSessions(store);
    viewer.start();
    await terminal.type('h');
    expect(terminal.text()).not.toContain('History');
    expect(terminal.text()).toContain('▌ alpha');
  });
});
