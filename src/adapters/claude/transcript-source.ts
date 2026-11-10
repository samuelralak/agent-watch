import { existsSync, type FSWatcher, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WatchEvent } from '../../domain/event.js';
import { oneLine } from '../../util/sanitize.js';
import { firstRecord } from '../fs/tail.js';
import { firstPrompt, lastRunStart, recordTime, TranscriptReader } from './transcript-reader.js';
import { type AgentMeta, agentMetaSchema } from './transcript-record.contract.js';

/** How much of an existing transcript is read for history. */
const HISTORY_BYTES = 512 * 1024;
/** An agent this young is read from its first record, not from the tail. */
const FRESH_MS = 2 * 60 * 1000;
const RETRY_MISSING_MS = 15_000;
/** Every reader is checked this often even with no watch event, in case one was missed. */
const FULL_PUMP_EVERY_TICKS = 10;
const UNRECOGNISED_LINES = 20;

export interface FollowedSession {
  readonly sessionId: string;
  readonly cwd?: string;
  /** When the session's current process started: agents untouched since then are leftovers. */
  readonly startedAt?: number;
  /** The transcript path a hook reported, which is authoritative when present. */
  readonly transcriptPath?: string | null;
}

interface AgentFiles {
  readonly reader: TranscriptReader;
  readonly agentType: string;
  metaModifiedAt: number;
  finished: boolean;
}

/** What the files of an agent not yet followed say about it. */
interface FoundAgent {
  readonly meta: AgentMeta;
  readonly finished: boolean;
  readonly metaModifiedAt: number;
  /** Null when the agent has no transcript yet. */
  readonly transcriptModifiedAt: number | null;
  /** When either of its files last changed. */
  readonly touchedAt: number;
}

interface SessionFiles {
  readonly sessionId: string;
  readonly cwd: string;
  startedAt: number;
  readonly subagentsDir: string;
  readonly main: TranscriptReader;
  readonly agents: Map<string, AgentFiles>;
  /** Agents ruled out, by a key of their files' state: not looked at again until a file changes. */
  readonly skipped: Map<string, string>;
  readonly dirty: Set<string>;
  watcher: FSWatcher | null;
  liveSince: number;
}

export interface TranscriptSourceOptions {
  readonly projectsDir: string;
  /** How long a finished agent stays worth showing. */
  readonly recentMs: number;
  readonly emit: (event: WatchEvent) => void;
  readonly now?: () => number;
}

function modifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Every followed session's transcripts: history when a viewer opens, everything for sessions
 * whose hooks are not live, and what hooks lack once they are. The transcript format is
 * internal to Claude Code, so this is where a format change shows first (see `warnings`).
 *
 * A followed session's readers are kept for as long as it is followed, so a session that drops
 * out of the session list and returns continues where it was instead of replaying its history.
 */
export class TranscriptSource {
  private readonly sessions = new Map<string, SessionFiles>();
  private readonly missing = new Map<string, number>();
  private readonly projectsDir: string;
  private readonly recentMs: number;
  private readonly emit: (event: WatchEvent) => void;
  private readonly now: () => number;
  private ticks = 0;
  /** Agents found by the first scan of a session are history, not fresh spawns. */
  private readonly settled = new Set<string>();

  constructor(options: TranscriptSourceOptions) {
    this.projectsDir = options.projectsDir;
    this.recentMs = options.recentMs;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
  }

  /** The main transcript of a followed session, once found. */
  transcriptPath(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.main.file ?? null;
  }

  /** The transcript that records what an agent did, the main one for `null`, once followed. */
  transcriptFile(sessionId: string, agentId: string | null): string | null {
    const files = this.sessions.get(sessionId);

    if (!files) {
      return null;
    }

    return agentId === null
      ? files.main.file
      : (files.agents.get(agentId)?.reader.file ??
          join(files.subagentsDir, `agent-${agentId}.jsonl`));
  }

  /**
   * Starts following a session, or updates what is known about one already followed. False
   * while the session has no transcript: it gets one with its first turn.
   */
  follow(session: FollowedSession): boolean {
    const known = this.sessions.get(session.sessionId);

    if (known) {
      // The session came back in a new process: agents untouched since then are leftovers.
      if (session.startedAt && session.startedAt > known.startedAt) {
        known.startedAt = session.startedAt;
      }

      return true;
    }

    if (!this.worthLooking(session)) {
      return false;
    }

    const transcript = this.findTranscript(session);

    if (!transcript) {
      this.missing.set(session.sessionId, this.now());

      return false;
    }

    this.missing.delete(session.sessionId);
    this.open(session, transcript);

    return true;
  }

  /**
   * Looking for a transcript reads the projects folder, so a session that had none is looked
   * for again only once in a while. A file a hook named is one cheap check, made every time.
   */
  private worthLooking(session: FollowedSession): boolean {
    const lastMiss = this.missing.get(session.sessionId);

    if (lastMiss === undefined || this.now() - lastMiss >= RETRY_MISSING_MS) {
      return true;
    }

    return Boolean(session.transcriptPath) && existsSync(session.transcriptPath ?? '');
  }

  /** Reads the session's history and keeps readers on its transcripts. */
  private open(session: FollowedSession, transcript: string): void {
    const cwd = session.cwd ?? '';

    const files: SessionFiles = {
      sessionId: session.sessionId,
      cwd,
      startedAt: session.startedAt ?? 0,
      subagentsDir: join(transcript.replace(/\.jsonl$/, ''), 'subagents'),
      main: new TranscriptReader(transcript, {
        sessionId: session.sessionId,
        agentId: null,
        cwd,
        emit: this.emit,
      }),
      agents: new Map(),
      skipped: new Map(),
      dirty: new Set(),
      watcher: null,
      liveSince: Number.POSITIVE_INFINITY,
    };

    this.sessions.set(session.sessionId, files);
    files.main.seekNearEnd(HISTORY_BYTES);
    files.main.pump();
    this.scan(files);
    this.settled.add(session.sessionId);
  }

  /**
   * The session's hooks deliver events from `at` on. History before it is still reported in
   * full, whenever it is read; from then on the readers report only what hooks lack.
   */
  setLiveSince(sessionId: string, at: number): void {
    const files = this.sessions.get(sessionId);

    if (!files || files.liveSince <= at) {
      return;
    }

    files.liveSince = at;
    files.main.liveSince = at;

    for (const agent of files.agents.values()) {
      agent.reader.liveSince = at;
    }
  }

  /** Stops following a session and forgets its readers. */
  forget(sessionId: string): void {
    const files = this.sessions.get(sessionId);

    this.missing.delete(sessionId);

    if (!files) {
      return;
    }

    files.watcher?.close();
    this.sessions.delete(sessionId);
    this.settled.delete(sessionId);
  }

  /** Reads what was appended. Cheap when nothing changed: one stat per session. */
  tick(): void {
    this.ticks++;

    const pumpAll = this.ticks % FULL_PUMP_EVERY_TICKS === 0;

    for (const files of this.sessions.values()) {
      const mainLines = files.main.pump();

      // A session's first subagent creates the folder; the main transcript records its spawn.
      if (!files.watcher && mainLines > 0) {
        this.scan(files);
      }

      const due = pumpAll ? [...files.agents.keys()] : [...files.dirty];

      files.dirty.clear();

      for (const agentId of due) {
        this.inspectAgent(files, agentId);
      }
    }
  }

  /** A slow safety net for watch events that were missed; also lets go of long-finished agents. */
  rescan(): void {
    const cutoff = this.now() - this.recentMs * 6;

    for (const files of this.sessions.values()) {
      this.scan(files);

      for (const [agentId, agent] of files.agents) {
        const touchedAt = Math.max(agent.metaModifiedAt, modifiedAt(agent.reader.file) ?? 0);

        if (!agent.finished || touchedAt > cutoff) {
          continue;
        }

        files.agents.delete(agentId);

        // Not looked at again unless one of its files changes (an agent can be continued).
        files.skipped.set(
          agentId,
          `${agent.metaModifiedAt}:${modifiedAt(agent.reader.file) ?? -1}`,
        );
      }
    }
  }

  /** Formats that no longer look as expected, in words for the user. */
  warnings(): string[] {
    const out: string[] = [];

    for (const files of this.sessions.values()) {
      const readers = [files.main, ...[...files.agents.values()].map((agent) => agent.reader)];

      const drifted = readers.find(
        (r) => r.linesSeen >= UNRECOGNISED_LINES && r.messagesSeen === 0,
      );

      if (drifted) {
        out.push(
          `no recognisable messages in ${drifted.file}; Claude Code's transcript format may have changed`,
        );
      }
    }

    return out;
  }

  close(): void {
    for (const files of this.sessions.values()) {
      files.watcher?.close();
    }

    this.sessions.clear();
  }

  // The same session id can exist in more than one project folder (worktrees, moved projects):
  // a path reported by a hook wins, otherwise the most recently written copy.
  private findTranscript(session: FollowedSession): string | null {
    if (session.transcriptPath && existsSync(session.transcriptPath)) {
      return session.transcriptPath;
    }

    const name = `${session.sessionId}.jsonl`;
    let folders: string[];

    try {
      folders = readdirSync(this.projectsDir);
    } catch {
      return null;
    }

    let best: { path: string; modifiedAt: number } | null = null;

    for (const folder of folders) {
      const path = join(this.projectsDir, folder, name);
      const at = modifiedAt(path);

      if (at !== null && (!best || at > best.modifiedAt)) {
        best = { path, modifiedAt: at };
      }
    }

    return best?.path ?? null;
  }

  private scan(files: SessionFiles): void {
    let names: string[];

    try {
      names = readdirSync(files.subagentsDir);
    } catch {
      return; // no subagents yet
    }

    if (!files.watcher) {
      try {
        files.watcher = watch(files.subagentsDir, { persistent: false }, (_event, name) => {
          const match = name ? /^agent-(.+?)\.(?:meta\.json|jsonl)$/.exec(String(name)) : null;

          if (match?.[1]) {
            files.dirty.add(match[1]);
          }
        });

        files.watcher.on('error', () => {});
      } catch {
        // The periodic full pump and rescan cover a folder that cannot be watched.
      }
    }

    for (const name of names) {
      const match = /^agent-(.+)\.meta\.json$/.exec(name);

      if (match?.[1]) {
        this.inspectAgent(files, match[1]);
      }
    }
  }

  /** Looks at one agent's files: reads on for one already followed, decides about a new one. */
  private inspectAgent(files: SessionFiles, agentId: string): void {
    const metaPath = join(files.subagentsDir, `agent-${agentId}.meta.json`);
    const transcript = join(files.subagentsDir, `agent-${agentId}.jsonl`);
    const metaModifiedAt = modifiedAt(metaPath);
    const known = files.agents.get(agentId);

    if (metaModifiedAt === null) {
      return;
    }

    if (known) {
      this.readOn(files, agentId, known, metaPath, metaModifiedAt);

      return;
    }

    const found = this.worthFollowing(files, agentId, { metaPath, transcript, metaModifiedAt });

    if (found) {
      this.startFollowing(files, agentId, transcript, found);
    }
  }

  /** Reads what a followed agent appended, and notices when its metadata says it finished. */
  private readOn(
    files: SessionFiles,
    agentId: string,
    known: AgentFiles,
    metaPath: string,
    metaModifiedAt: number,
  ): void {
    known.reader.pump();

    if (metaModifiedAt === known.metaModifiedAt) {
      return;
    }

    const finished = this.readMeta(metaPath)?.finished === true;

    if (finished && !known.finished) {
      this.emitFinished(files, agentId, known.agentType, metaModifiedAt);
    }

    known.metaModifiedAt = metaModifiedAt;
    known.finished = finished;
  }

  /**
   * What the files of an agent not yet followed say about it, or null when it is not worth
   * following: it ended too long ago to show, or an earlier process of the session left it.
   */
  private worthFollowing(
    files: SessionFiles,
    agentId: string,
    paths: { metaPath: string; transcript: string; metaModifiedAt: number },
  ): FoundAgent | null {
    const { metaModifiedAt } = paths;
    const transcriptModifiedAt = modifiedAt(paths.transcript);
    const fileState = `${metaModifiedAt}:${transcriptModifiedAt ?? -1}`;
    const touchedAt = Math.max(metaModifiedAt, transcriptModifiedAt ?? 0);
    const recentCutoff = this.now() - this.recentMs;

    // Ruled out before, and neither file has changed since.
    if (files.skipped.get(agentId) === fileState) {
      return null;
    }

    // Old enough that its metadata need not even be read.
    if (touchedAt < files.startedAt && touchedAt < recentCutoff) {
      this.ruleOut(files, agentId, fileState, touchedAt);

      return null;
    }

    const meta = this.readMeta(paths.metaPath);

    if (!meta) {
      return null;
    }

    const finished = meta.finished === true;

    if (finished && touchedAt < recentCutoff) {
      this.ruleOut(files, agentId, fileState, touchedAt);

      return null;
    }

    // Unfinished but untouched since this Claude process started: cut off when an earlier one ended.
    if (!finished && touchedAt < files.startedAt) {
      this.ruleOut(files, agentId, fileState, touchedAt, 'session-end');

      return null;
    }

    files.skipped.delete(agentId);

    return { meta, finished, metaModifiedAt, transcriptModifiedAt, touchedAt };
  }

  /** Reports the agent, then its history, and keeps a reader on its transcript. */
  private startFollowing(
    files: SessionFiles,
    agentId: string,
    transcript: string,
    found: FoundAgent,
  ): void {
    const { meta, finished, metaModifiedAt } = found;
    const hasTranscript = found.transcriptModifiedAt !== null;
    const first = hasTranscript ? firstRecord(transcript) : null;
    const firstAt = (first === null ? null : recordTime(first)) ?? metaModifiedAt;
    // Found after the session's first scan and only just started: a spawn seen as it happens.
    const fresh = this.settled.has(files.sessionId) && firstAt >= this.now() - FRESH_MS;
    const lastRun = fresh || !hasTranscript ? null : lastRunStart(transcript);
    const agentType = meta.agentType ?? 'agent';

    const reader = new TranscriptReader(transcript, {
      sessionId: files.sessionId,
      agentId,
      cwd: meta.worktreePath ?? files.cwd,
      emit: this.emit,
    });

    reader.liveSince = files.liveSince;
    files.agents.set(agentId, { reader, agentType, metaModifiedAt, finished });

    this.emit({
      at: lastRun ?? firstAt,
      sessionId: files.sessionId,
      agentId,
      origin: 'transcript',
      kind: 'agent.started',
      agentType,
      description: oneLine(meta.description, 500) || undefined,
      parentAgentId: meta.parentAgentId,
      model: meta.model && meta.model !== 'inherit' ? meta.model : undefined,
      prompt: first === null ? undefined : firstPrompt(first) || undefined,
    });

    // A long-running agent's history is read from near its end, like the session's own.
    if (!fresh) {
      reader.seekNearEnd(HISTORY_BYTES);
    }

    reader.pump();

    if (finished) {
      this.emitFinished(files, agentId, agentType, found.touchedAt);
    }
  }

  /**
   * The agent is not followed: it ended too long ago to show, or an earlier process left it
   * behind. The session's own history may still mention its launch, so the store is told it is
   * over; a store that never heard of it ignores that.
   */
  private ruleOut(
    files: SessionFiles,
    agentId: string,
    fileState: string,
    at: number,
    interruptedBy?: 'session-end',
  ): void {
    files.skipped.set(agentId, fileState);

    this.emit({
      at,
      sessionId: files.sessionId,
      agentId,
      origin: 'transcript',
      kind: 'agent.stopped',
      interruptedBy,
    });
  }

  // The metadata's finished flag is the agent's real end: no list of running work is needed.
  private emitFinished(files: SessionFiles, agentId: string, agentType: string, at: number): void {
    this.emit({
      at,
      sessionId: files.sessionId,
      agentId,
      origin: 'transcript',
      kind: 'agent.stopped',
      agentType,
    });
  }

  private readMeta(path: string) {
    try {
      const parsed = agentMetaSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
