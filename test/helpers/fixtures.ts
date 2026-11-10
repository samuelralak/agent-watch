import { readFileSync } from 'node:fs';
import { hookPayloadSchema } from '../../src/adapters/claude/hook-payload.contract.js';
import { toSpoolRecord } from '../../src/adapters/claude/hook-payload.mapper.js';
import { toWatchEvents } from '../../src/adapters/claude/spool-record.mapper.js';
import type { WatchEvent } from '../../src/domain/event.js';
import { Store } from '../../src/domain/store.js';

/** Real hook payloads recorded from Claude Code, one `{ t, payload }` per line. */
export function recordedPayloads(name: string): { at: number; payload: unknown }[] {
  return readFileSync(new URL(`../fixtures/${name}.ndjson`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { t: number; payload: unknown })
    .map(({ t, payload }) => ({ at: t, payload }));
}

/** The events a recording stands for, through the same contracts and mappers the viewer uses. */
export function recordedEvents(name: string): WatchEvent[] {
  return recordedPayloads(name).flatMap(({ at, payload }) =>
    toWatchEvents(toSpoolRecord(hookPayloadSchema.parse(payload), at), () => true),
  );
}

export function replay(name: string): Store {
  const store = new Store();

  for (const event of recordedEvents(name)) {
    store.apply(event);
  }

  return store;
}
