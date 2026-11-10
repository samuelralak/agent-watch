/** Wiring: the session list, history, live events and messaging, with fakes for all four. */
import { describe, expect, it } from 'vitest';
import type { InboxPort } from '../../src/application/ports/inbox.port.js';
import type {
  SessionListPort,
  SessionListResult,
} from '../../src/application/ports/session-list.port.js';
import type {
  EventCollectorPort,
  FollowedSession,
  HistoryPort,
  LiveEventsPort,
} from '../../src/application/ports/watch-sources.port.js';
import { WatchService } from '../../src/application/watch.service.js';
import { Store } from '../../src/domain/store.js';

const NOW = 1_800_000_000_000;

function setup(options: { filter?: string } = {}) {
  const store = new Store();
  let next: SessionListResult = { sessions: [], authoritative: true };
  let clock = NOW;
  const calls: string[] = [];
  const followed: FollowedSession[] = [];
  const withoutTranscript = new Set<string>();
  const sessionList: SessionListPort = { list: async () => next, onChange: () => () => {} };

  const history: HistoryPort = {
    follow: (session) => {
      followed.push(session);

      return !withoutTranscript.has(session.sessionId);
    },
    setLiveSince: (sessionId, since) => calls.push(`live:${sessionId}:${since}`),
    forget: (sessionId) => calls.push(`forget:${sessionId}`),
    tick: () => {},
    rescan: () => {},
    warnings: () => [],
    close: () => {},
  };

  let liveProblem: string | undefined;

  const liveEvents: LiveEventsPort = {
    start: () => {},
    tick: () => {},
    warnings: () => (liveProblem ? [liveProblem] : []),
    close: () => {},
  };

  const collector: EventCollectorPort = {
    isCollecting: true,
    tick: () => {},
    forgetOldSpools: () => {},
    stop: () => {},
  };

  const reachable = new Set<string>();

  const inbox = {
    canReceive: (sessionId: string) => reachable.has(sessionId),
    recoverAbandoned: () => 0,
  } as unknown as InboxPort;

  const service = new WatchService({
    store,
    sessionList,
    history,
    liveEvents,
    collector,
    inbox,
    sessionFilter: options.filter ?? null,
    recentMs: 600_000,
    verifiedVersions: ['2.1.321'],
    now: () => clock,
  });

  return {
    store,
    service,
    calls,
    followed,
    withoutTranscript,
    reachable,
    listed: (result: SessionListResult) => {
      next = result;
    },
    liveProblemIs: (problem: string | undefined) => {
      liveProblem = problem;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const session = (sessionId: string, extra: object = {}) => ({
  sessionId,
  name: sessionId,
  status: 'idle',
  ...extra,
});

describe('the session list', () => {
  it('adds live sessions and follows their history', async () => {
    const { store, service, followed, listed } = setup();

    listed({ sessions: [session('alpha', { cwd: '/work/alpha' })], authoritative: true });
    await service.poll();
    expect(store.session('alpha')).toMatchObject({ alive: true, cwd: '/work/alpha' });
    expect(followed.map((f) => f.sessionId)).toEqual(['alpha']);
    expect(service.ready).toBe(true);
  });

  it('keeps looking for the history of a new session until its first turn writes one', async () => {
    const { service, followed, withoutTranscript, listed } = setup();

    withoutTranscript.add('alpha');
    listed({ sessions: [session('alpha'), session('beta')], authoritative: true });
    await service.poll();
    expect(followed.map((f) => f.sessionId)).toEqual(['alpha', 'beta']);

    // Every tick, without waiting for the session list to be read again.
    service.tick();
    service.tick();
    expect(followed.map((f) => f.sessionId)).toEqual(['alpha', 'beta', 'alpha', 'alpha']);

    withoutTranscript.delete('alpha');
    service.tick();
    service.tick();
    expect(followed).toHaveLength(5);

    // A session that left the list is no longer looked for.
    withoutTranscript.add('gamma');
    listed({ sessions: [session('gamma')], authoritative: true });
    await service.poll();
    listed({ sessions: [], authoritative: true });
    await service.poll();

    const before = followed.length;

    service.tick();
    expect(followed).toHaveLength(before);
  });

  it('that failed once leaves every session in place, and its warning clears on the next good read', async () => {
    const { store, service, listed } = setup();

    listed({ sessions: [session('alpha'), session('beta')], authoritative: true });
    await service.poll();

    listed({
      sessions: [session('alpha')],
      authoritative: false,
      problem: 'claude agents --json failed',
    });

    await service.poll();
    await service.poll();
    expect(store.session('beta').alive).toBe(true);
    expect(service.warnings.get('sessions')).toMatch(/failed/);

    listed({ sessions: [session('alpha'), session('beta')], authoritative: true });
    await service.poll();
    expect(service.warnings.has('sessions')).toBe(false);
  });

  it('shows only the sessions the user asked for', async () => {
    const { store, service, listed } = setup({ filter: 'ajira' });

    listed({
      sessions: [session('one', { cwd: '/work/ajira' }), session('two', { cwd: '/work/other' })],
      authoritative: true,
    });

    await service.poll();
    expect([...store.sessions.keys()]).toEqual(['one']);
  });

  it('warns when a session runs a Claude Code version whose transcripts were not checked', async () => {
    const { service, listed } = setup();

    listed({ sessions: [session('alpha', { version: '9.9.9' })], authoritative: true });
    await service.poll();
    expect([...service.warnings.values()].join(' ')).toMatch(/9\.9\.9 is untested/);
  });
});

describe('a session whose hooks become live', () => {
  it('hands over from history at that moment, even when the hooks were live before it was listed', async () => {
    const { store, service, calls, listed } = setup();

    service.noteLive('alpha', NOW + 5);
    listed({ sessions: [session('alpha')], authoritative: true });
    await service.poll();
    expect(store.session('alpha').hooksLive).toBe(true);

    expect(calls.filter((call) => call.startsWith('live:'))).toEqual([
      `live:alpha:${NOW + 5}`,
      `live:alpha:${NOW + 5}`,
    ]);
  });
});

describe('whether a session can be messaged', () => {
  it("is yes once it runs agentwatch's hooks, and no once it is gone", async () => {
    const { store, service, reachable, listed } = setup();

    listed({ sessions: [session('alpha')], authoritative: true });
    await service.poll();
    service.tick();
    expect(store.session('alpha').canMessage).toBe(false);

    reachable.add('alpha');
    service.tick();
    expect(store.session('alpha').canMessage).toBe(true);

    listed({ sessions: [], authoritative: true });
    await service.poll();
    await service.poll();
    service.tick();
    expect(store.session('alpha').canMessage).toBe(false);
  });
});

describe('a problem reading live events', () => {
  it('is shown while it lasts and cleared when it is over', async () => {
    const { service, liveProblemIs } = setup();

    liveProblemIs('another version of agentwatch is recording');
    service.tick();
    expect([...service.warnings.values()]).toEqual(['another version of agentwatch is recording']);

    liveProblemIs(undefined);
    service.tick();
    expect(service.warnings.size).toBe(0);
  });
});

describe('housekeeping', () => {
  it('stops following sessions the store has forgotten', async () => {
    const { service, calls, listed, advance } = setup();

    listed({ sessions: [session('alpha')], authoritative: true });
    await service.poll();
    listed({ sessions: [], authoritative: true });
    await service.poll();
    await service.poll();
    advance(3 * 3600_000);
    service.housekeep();
    expect(calls).toContain('forget:alpha');
  });
});
