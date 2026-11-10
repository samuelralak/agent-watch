import type { WatchEvent, WatchEventKind } from '../../src/domain/event.js';

type Fields<K extends WatchEventKind> = Omit<
  Extract<WatchEvent, { kind: K }>,
  'kind' | 'at' | 'sessionId' | 'agentId' | 'origin'
> &
  Partial<Pick<WatchEvent, 'sessionId' | 'agentId' | 'origin'>>;

/** An event at `at` for session `S`'s main agent, from a hook, unless `fields` says otherwise. */
export function event<K extends WatchEventKind>(
  kind: K,
  at: number,
  fields: Fields<K> = {} as Fields<K>,
): WatchEvent {
  return { sessionId: 'S', agentId: null, origin: 'hook', ...fields, kind, at } as WatchEvent;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
