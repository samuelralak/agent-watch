/** One entry of the activity, opened in full. */
import { describe, expect, it } from 'vitest';
import type { ToolExchange } from '../../src/application/ports/tool-exchange.port.js';
import { Store } from '../../src/domain/store.js';
import { entryPanel } from '../../src/tui/views/entry-panel.js';
import { event, SECOND } from '../helpers/events.js';
import { plain } from '../helpers/rows.js';
import { call, listing } from '../helpers/sessions.js';

const T0 = 1_800_000_000_000;
const WIDTH = 70;

function opened(exchange: ToolExchange | null, ended = true): string[] {
  const store = new Store();

  store.syncListing([listing('S')], T0);

  if (ended) {
    call(store, T0, {
      sessionId: 'S',
      agentId: null,
      id: 't1',
      tool: 'Bash',
      summary: 'Run the tests',
      result: '12 passed (+40 lines)',
    });
  } else {
    store.apply(
      event('tool.started', T0, { toolUseId: 't1', tool: 'Bash', summary: 'Run the tests' }),
    );
  }

  const entries = store.session('S').main.timeline.latest(5);
  const ctx = { now: T0 + 5 * SECOND, frame: 0, width: WIDTH, who: 'main · in S' };

  return plain(entryPanel(entries, new Map([['t1', exchange]]), ctx), WIDTH);
}

describe('an entry opened in full', () => {
  it('shows what the tool was given and all of what it gave back, as it was', () => {
    const rows = opened({
      input: 'command:\n  npm test \\\n    --reporter verbose',
      result: 'PASS a.test.ts\n  ✓ one\n  ✓ two\n\n12 passed',
    });

    expect(rows[0]).toMatch(/^ENTRY {2}main · in S\s+← or esc closes$/);

    expect(rows.join('\n')).toContain(
      'INPUT\n  command:\n    npm test \\\n      --reporter verbose',
    );

    expect(rows.join('\n')).toContain(
      'RESULT\n  PASS a.test.ts\n    ✓ one\n    ✓ two\n\n  12 passed',
    );
  });

  it('says so when a call has no result yet', () => {
    const text = opened({ input: 'command: make', result: null }, false).join('\n');

    expect(text).toContain('RESULT\n  none on record: the call is still running');
  });

  it('says where the whole text comes from when the call is not found there, and shows what was kept', () => {
    const text = opened(null).join(' ').replace(/\s+/g, ' ');

    expect(text).toContain("read from its agent's transcript when the call is opened");
    expect(text).toContain('Bash Run the tests');
    expect(text).toContain('12 passed (+40 lines)');
  });
});
