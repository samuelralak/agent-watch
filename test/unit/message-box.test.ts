/** The box at the bottom of the view: who a message goes to, its text, and what becomes of it. */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/domain/store.js';
import { borderColumns, boxColumns, composeFrame } from '../../src/tui/frame.js';
import { layoutFor } from '../../src/tui/layout.js';
import { createPainter, type Row, row, type Segment } from '../../src/tui/paint.js';
import { MIN_COLUMNS } from '../../src/tui/screen.js';
import { TextEditor } from '../../src/tui/text-editor.js';
import { type Draft, type MessageBox, messageBox } from '../../src/tui/views/message-box.js';
import { event, MINUTE, SECOND } from '../helpers/events.js';
import { plain } from '../helpers/rows.js';
import { listing, outboxMessage, startAgent } from '../helpers/sessions.js';

const T0 = 1_800_000_000_000;
/** A frame this wide gives the box 60 columns of text. */
const FRAME = 64;
/** The narrowest frame the view is drawn in. */
const NARROWEST = MIN_COLUMNS - 1;
const painter = createPainter(false);

interface BoxOptions {
  readonly draft?: Draft;
  readonly agentId?: string;
  readonly waiter?: boolean;
  readonly saved?: string;
  readonly sending?: boolean;
  readonly maxRows?: number;
  /** The width of the frame the box is drawn in. */
  readonly frame?: number;
}

const words = (segments: readonly Segment[]): string => segments.map(([, text]) => text).join('');

/** The box as plain text: its title, the rows of its body, its keys and its state. */
function box(store: Store, options: BoxOptions = {}) {
  const session = store.sessions.get('S') ?? null;
  const frame = options.frame ?? FRAME;

  const result = messageBox({
    now: T0 + MINUTE,
    columns: boxColumns(frame),
    borderColumns: borderColumns(frame),
    maxRows: options.maxRows ?? 6,
    draft: options.draft ?? null,
    draftSession: options.draft ? (store.sessions.get(options.draft.sessionId) ?? null) : null,
    session,
    agent: session?.agents.get(options.agentId ?? '') ?? null,
    savedDraft: options.saved ?? null,
    sending: options.sending ?? false,
    hasWaiter: () => options.waiter ?? false,
  });

  return {
    title: words(result.title),
    extent: words(result.extent),
    body: plain(result.body as Row[], boxColumns(frame)),
    keys: words(result.keys),
    state: words(result.state),
    cursor: result.cursor,
    bottomBorder: bottomBorder(result, frame),
  };
}

/** The bottom border as the frame draws it. */
function bottomBorder(result: MessageBox, frame: number): string {
  const layout = layoutFor(frame + 1, 30, false, result.body.length);
  const blank = row([]);

  const { lines, inputRow } = composeFrame(
    {
      title: blank,
      warning: null,
      list: [],
      detail: [],
      hints: blank,
      focus: 'list',
      messageBox: result,
    },
    layout,
    painter,
  );

  return lines[inputRow + result.body.length] ?? '';
}

function reachable(status = 'idle'): Store {
  const store = new Store();

  store.syncListing([listing('S', { status })], T0);
  store.setCanMessage('S', true);

  return store;
}

const draftTo = (text: string, agent: { id: string; label: string } | null = null): Draft => {
  const editor = new TextEditor();

  editor.insert(text);

  return {
    sessionId: 'S',
    sessionName: 'S',
    agentId: agent?.id ?? null,
    agentLabel: agent?.label ?? null,
    editor,
  };
};

describe('the message box, before anything is written', () => {
  it('says who a message would go to and how to start one', () => {
    const { title, body, keys, cursor } = box(reachable());

    expect(title).toBe('To S');
    expect(body).toEqual(['No recent messages from this window.']);
    expect(keys).toBe('⏎ write a message');
    expect(cursor).toBeNull();
  });

  it('names the subagent the message would be about', () => {
    const store = reachable();

    startAgent(store, 'A', T0, { description: 'Port the tests' });
    expect(box(store, { agentId: 'A' }).title).toBe('To S · about Port the tests');
  });

  it('explains a session that has not run the hooks yet instead of offering to write', () => {
    const store = new Store();

    store.syncListing([listing('S')], T0);

    const { title, body, keys, state } = box(store);

    expect(title).toBe("S can't receive messages yet");
    expect(body[0]).toContain("hasn't run agentwatch's hooks yet");
    expect(keys).toBe('');
    expect(state).toBe('⏎ why');
  });

  it('says a message cannot answer a permission prompt', () => {
    const { body, state, keys } = box(reachable('waiting'));

    // Wider than the box: it takes a second row rather than lose its end.
    expect(body).toEqual(['It is asking you to approve something: answer in its', 'terminal.']);
    expect(state).toBe('waiting for you');
    expect(keys).toBe('');
  });

  it('shows what became of the last message, and the start of the reply once there is one', () => {
    const store = reachable();
    const message = outboxMessage('use the staging database', T0);

    store.addOutbox('S', message);
    expect(box(store).state).toBe('… waiting for its next tool call or turn end');
    expect(box(store).body).toEqual(['✉ you said: use the staging database']);

    store.apply(
      event('message.delivered', T0 + SECOND, {
        sender: 'user',
        nonce: message.nonce,
        via: 'wake',
        text: message.text,
      }),
    );

    store.apply(event('narration', T0 + 2 * SECOND, { text: 'Switching to staging.' }));

    const { body, state } = box(store);

    expect(state).toContain('✓ delivered');
    expect(state).toContain('right away');
    expect(body).toEqual(['↳ it said: Switching to staging.']);
  });

  it('shows the newest thing the agent said, and says while it is still at work on the message', () => {
    const store = reachable('busy');
    const message = outboxMessage('run the review and tell me what it finds', T0);

    store.addOutbox('S', message);

    store.apply(
      event('message.delivered', T0 + SECOND, {
        sender: 'user',
        nonce: message.nonce,
        via: 'tool',
        text: message.text,
      }),
    );

    // Delivered, nothing said yet, and it is working.
    expect(box(store, { frame: 100 }).state).toMatch(
      /^✓ delivered \d\d:\d\d:\d\d · still at work$/,
    );

    // A holding answer: its turn ends while the review it started is still running.
    store.apply(
      event('turn.ended', T0 + 3 * SECOND, {
        text: 'I have started the review and will report when it is done.',
        runningTaskIds: ['bg1'],
      }),
    );

    const holding = box(store, { frame: 100 });

    expect(holding.body).toEqual([
      '↳ it said: I have started the review and will report when it is done.',
    ]);

    expect(holding.state).toMatch(/· still at work$/);

    // The answer the message was sent for, a turn later.
    store.apply(
      event('turn.ended', T0 + 40 * SECOND, {
        text: 'The review found two issues.',
        runningTaskIds: [],
      }),
    );

    const answered = box(store, { frame: 100 });

    expect(answered.body).toHaveLength(1);

    // What it said before is not here: the row says where all of it is.
    expect(answered.body[0]).toMatch(
      /^↳ then it said: The review found two issues\.\s+all of it: in its activity$/,
    );

    expect(answered.state).toMatch(/^✓ delivered \d\d:\d\d:\d\d, at its next tool call$/);
  });

  it('shows a reply of a few rows whole, and says where the rest of a longer one is', () => {
    const replied = (reply: string): Store => {
      const store = reachable();
      const message = outboxMessage('what changed?', T0);

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

      return store;
    };

    const short = 'Three things changed.\n\n1. The parser\n2. Its tests\n3. The documentation';

    expect(box(replied(short)).body).toEqual([
      '↳ it said: Three things changed. 1. The parser 2. Its tests',
      '  3. The documentation',
    ]);

    const long = Array.from({ length: 30 }, (_, index) => `Change ${index + 1} is in.`).join('\n');
    const { body } = box(replied(long));

    expect(body).toHaveLength(3);
    expect(body[0]).toMatch(/^↳ it said: Change 1 is in\. Change 2 is in\./);
    expect(body[2]).toMatch(/…\s+all of it: in its activity$/);

    // With a single row to spare, the start of the reply and where the rest is share it.
    const [only, ...others] = box(replied(long), { maxRows: 1 }).body;

    expect(others).toEqual([]);
    expect(only).toMatch(/^↳ it said: Change 1 is in\..*…\s+all of it: in its activity$/);

    // On a narrow box the pointer would leave no room for the reply itself: the reply wins.
    const [narrow] = box(replied(long), { maxRows: 1, frame: NARROWEST }).body;

    expect(narrow).toMatch(/^↳ it said: Change 1 is in\. Change.*…$/);
    expect(narrow).not.toContain('all of it');
  });

  it('sums a reply up in plain words: no Markdown marks, a table as cells set apart', () => {
    const store = reachable();
    const message = outboxMessage('which fruit?', T0);

    store.addOutbox('S', message);

    store.apply(
      event('message.delivered', T0 + SECOND, {
        sender: 'user',
        nonce: message.nonce,
        via: 'wake',
        text: message.text,
      }),
    );

    store.apply(
      event('turn.ended', T0 + 2 * SECOND, {
        text: '**Two** options, see `fruit.md`:\n\n| Fruit | Colour |\n|-------|--------|\n| Apple | Red |\n\nWhich one?',
      }),
    );

    expect(box(store, { frame: 100 }).body).toEqual([
      '↳ it said: Two options, see fruit.md: Fruit · Colour Apple · Red Which one?',
    ]);
  });

  it('offers to continue a draft that was put aside', () => {
    const { body, keys } = box(reachable(), { saved: 'half a thought' });

    expect(body).toEqual(['draft: half a thought']);
    expect(keys).toBe('⏎ continue the draft');
  });
});

describe('the message box, while a message is being written', () => {
  it('shows the text, the cursor after it, how to send, and when it will arrive', () => {
    const busy = box(reachable('busy'), { draft: draftTo('stop'), frame: 100 });

    expect(busy.body).toEqual(['stop']);
    expect(busy.cursor).toEqual({ row: 0, column: 4 });
    expect(busy.keys).toBe('⏎ send · alt-⏎ new line · esc keeps draft');
    expect(busy.state).toBe('busy: at its next tool call');

    expect(box(reachable(), { draft: draftTo('stop'), waiter: true }).state).toBe(
      'idle: wakes it now',
    );

    expect(box(reachable(), { draft: draftTo('stop') }).state).toBe('idle: at its next turn');

    // A waiter left by the last turn end still listens after the session went back to work.
    expect(box(reachable('busy'), { draft: draftTo('stop'), waiter: true }).state).toBe(
      'busy: reaches it right away',
    );
  });

  it('sets the keys into the border only when all of them fit beside the state', () => {
    const wide = box(reachable(), { draft: draftTo('stop'), waiter: true, frame: 100 });

    expect(wide.keys).toBe('⏎ send · alt-⏎ new line · esc keeps draft');

    expect(wide.bottomBorder).toMatch(
      /^└ ⏎ send · alt-⏎ new line · esc keeps draft ─+ idle: wakes it now ─┘$/,
    );

    // The narrowest box there is: the row under it has the keys then, and no key is half named.
    const narrow = box(reachable(), { draft: draftTo('stop'), waiter: true, frame: NARROWEST });

    expect(narrow.keys).toBe('');
    expect(narrow.bottomBorder).toMatch(/^└─+ idle: wakes it now ─┘$/);
  });

  it('shows every state of a draft whole on the narrowest terminal', () => {
    const draft = draftTo('stop');
    const ended = reachable();

    ended.apply(event('session.ended', T0 + SECOND));

    const states = [
      box(reachable(), { draft, frame: NARROWEST }),
      box(reachable(), { draft, waiter: true, frame: NARROWEST }),
      box(reachable('busy'), { draft, frame: NARROWEST }),
      box(reachable('busy'), { draft, waiter: true, frame: NARROWEST }),
      box(reachable('waiting'), { draft, frame: NARROWEST }),
      box(reachable(), { draft, sending: true, frame: NARROWEST }),
      box(ended, { draft, frame: NARROWEST }),
    ];

    expect(new Set(states.map(({ state }) => state)).size).toBe(states.length);

    for (const { state, bottomBorder: border } of states) {
      expect(border, state).toContain(` ${state} ─┘`);
      expect(border, state).not.toContain('…');
    }
  });

  it('grows a row for each line of the draft, wrapping long ones, up to the room it has', () => {
    const long =
      'hold the promotion until I have seen the screenshot, and keep the fit words in one style';

    const two = box(reachable(), { draft: draftTo(long) });

    expect(two.body).toHaveLength(2);
    expect(two.body.join(' ').replace(/\s+/g, ' ')).toBe(long);
    expect(two.cursor?.row).toBe(1);
    expect(two.extent).toBe('');

    const many = box(reachable(), { draft: draftTo('1\n2\n3\n4\n5\n6\n7\n8'), maxRows: 6 });

    expect(many.body).toEqual(['3', '4', '5', '6', '7', '8']);
    expect(many.cursor).toEqual({ row: 5, column: 1 });
    // Rows out of view are never out of mind: the top border says which ones are showing.
    expect(many.extent).toBe('rows 3-8 of 8');
    expect(box(reachable(), { draft: draftTo('1\n2\n3'), maxRows: 1 }).extent).toBe('row 3 of 3');
  });

  it("shows the draft's own target, whatever is selected by then", () => {
    const store = reachable();

    startAgent(store, 'A', T0, { description: 'Port the tests' });

    const draft = draftTo('hello', { id: 'B', label: 'Review the diff' });

    expect(box(store, { draft, agentId: 'A' }).title).toBe('To S · about Review the diff');
  });

  it('says how full a long draft is, and that one past the limit is too long to send', () => {
    const nearly = box(reachable(), { draft: draftTo('x'.repeat(3200)), frame: 100 });

    expect(nearly.extent).toBe('rows 29-34 of 34 · 3,200/4,000');
    expect(nearly.state).toBe('idle: at its next turn');

    const short = box(reachable(), { draft: draftTo('x'.repeat(100)), frame: 100 });

    expect(short.extent).toBe('');

    const over = box(reachable(), { draft: draftTo(`${'x'.repeat(4312)}  `), frame: 100 });

    expect(over.extent).toContain('4,312/4,000');
    expect(over.state).toBe('312 characters too long');
    expect(over.bottomBorder).toContain(' 312 characters too long ─┘');
  });

  it('says it is waiting for the signature while the message is being sent', () => {
    expect(box(reachable(), { draft: draftTo('ship it'), sending: true }).state).toBe(
      'sending: use Touch ID if asked',
    );
  });

  it('keeps saying a message cannot approve anything while the session waits on a prompt', () => {
    expect(box(reachable('waiting'), { draft: draftTo('yes, go ahead') }).state).toBe(
      'it needs approval in its terminal',
    );
  });

  it('says so when the session ended while the message was being written', () => {
    const store = reachable();

    store.apply(event('session.ended', T0 + SECOND));

    expect(box(store, { draft: draftTo('still there?') }).state).toBe(
      'session ended: your draft is kept',
    );
  });
});
