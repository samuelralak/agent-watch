import { describe, expect, it } from 'vitest';
import {
  agentKey,
  keepSelection,
  type SelectableRow,
  sessionKey,
} from '../../src/tui/selection.js';

const session = (id: string): SelectableRow => ({
  key: sessionKey(id),
  sessionId: id,
  agentId: null,
});

const agent = (sessionId: string, agentId: string): SelectableRow => ({
  key: agentKey(sessionId, agentId),
  sessionId,
  agentId,
});

const noneRunning = () => false;

describe('the selection', () => {
  it('stays on its row when other rows appear, vanish or get busy', () => {
    const rows = [session('alpha'), agent('alpha', '1'), session('beta'), agent('beta', '9')];

    expect(keepSelection(sessionKey('alpha'), rows, () => true)).toBe(sessionKey('alpha'));
    expect(keepSelection(agentKey('alpha', '1'), rows, noneRunning)).toBe(agentKey('alpha', '1'));
  });

  it('falls back to its own session when the selected agent goes away, never to another session', () => {
    const rows = [session('alpha'), session('beta'), agent('beta', '9')];

    expect(keepSelection(agentKey('alpha', '1'), rows, () => true)).toBe(sessionKey('alpha'));
  });

  it('starts on a running agent if there is one, else on the first session', () => {
    const rows = [session('alpha'), agent('alpha', '1'), session('beta'), agent('beta', '9')];

    expect(keepSelection(null, rows, (row) => row.agentId === '9')).toBe(agentKey('beta', '9'));
    expect(keepSelection(null, rows, noneRunning)).toBe(sessionKey('alpha'));
    expect(keepSelection(null, [], noneRunning)).toBeNull();
  });
});
