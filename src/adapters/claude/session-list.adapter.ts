import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  SessionListPort,
  SessionListResult,
} from '../../application/ports/session-list.port.js';
import type { SessionListing } from '../../domain/session.js';
import { SESSION_ID } from './hook-payload.contract.js';

/** One entry of `claude agents --json`, the documented way to list sessions. */
const listedSession = z.object({
  sessionId: z.string().regex(SESSION_ID),
  id: z.string().optional(),
  pid: z.number().nullish(),
  cwd: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  waitingFor: z.string().optional(),
  startedAt: z.number().optional(),
});

/** Claude Code's own per-process record: used for its version, and as a fallback listing. */
const registryEntry = z.object({
  sessionId: z.string().regex(SESSION_ID),
  pid: z.number(),
  cwd: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  startedAt: z.number().optional(),
  version: z.string().optional(),
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A viewer started from inside a Claude Code session must not look like that session.
function withoutClaudeSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };

  for (const key of Object.keys(clean)) {
    if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$|^CLAUDE_EFFORT$/.test(key)) {
      delete clean[key];
    }
  }

  return clean;
}

export class ClaudeSessionListAdapter implements SessionListPort {
  constructor(
    private readonly registryDir: string,
    private readonly command = 'claude',
  ) {}

  list(): Promise<SessionListResult> {
    return new Promise((resolve) => {
      execFile(
        this.command,
        ['agents', '--json'],
        { env: withoutClaudeSession(process.env), timeout: 20_000, maxBuffer: 8 << 20 },
        (error, stdout) => {
          const registry = this.registry();
          const listed = error ? null : parseList(stdout);

          if (!listed) {
            const problem = error ? firstLine(error.message) : 'unexpected output';

            resolve({
              sessions: [...registry.values()],
              authoritative: false,
              problem: `claude agents --json failed (${problem}); showing sessions from Claude Code's own records`,
            });

            return;
          }

          resolve({
            sessions: listed.map((session) => ({
              ...session,
              version: registry.get(session.sessionId)?.version,
            })),
            authoritative: true,
          });
        },
      );
    });
  }

  // Claude Code rewrites a session's record when its status changes: a cheap change signal.
  onChange(listener: () => void): () => void {
    try {
      const watcher = watch(this.registryDir, { persistent: false }, (_event, name) => {
        if (name && /^\d+\.json$/.test(String(name))) {
          listener();
        }
      });

      watcher.on('error', () => {});

      return () => watcher.close();
    } catch {
      return () => {};
    }
  }

  private registry(): Map<string, SessionListing> {
    const sessions = new Map<string, SessionListing>();
    let names: string[] = [];

    try {
      names = readdirSync(this.registryDir);
    } catch {
      return sessions;
    }

    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) {
        continue; // only <pid>.json; the key files are never opened
      }

      try {
        const entry = registryEntry.safeParse(
          JSON.parse(readFileSync(join(this.registryDir, name), 'utf8')),
        );

        if (entry.success && isAlive(entry.data.pid)) {
          sessions.set(entry.data.sessionId, entry.data);
        }
      } catch {
        // Being rewritten: the next poll reads it.
      }
    }

    return sessions;
  }
}

function parseList(stdout: string): SessionListing[] | null {
  try {
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(stdout));

    if (!parsed.success) {
      return null;
    }

    return parsed.data.flatMap((entry) => {
      const session = listedSession.safeParse(entry);

      if (!session.success) {
        return [];
      }

      const { id, pid, ...rest } = session.data;

      return [{ ...rest, shortId: id, pid: pid ?? null }];
    });
  } catch {
    return null;
  }
}

const firstLine = (text: string): string => text.split('\n')[0] ?? text;
