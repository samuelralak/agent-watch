import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where agentwatch keeps its state, its hook scripts, and where Claude Code keeps its own. */
export interface StatePaths {
  /** Raw hook payloads, one file each, written by the observe hook. */
  readonly events: string;
  readonly eventsTmp: string;
  /** Reduced events, one JSON Lines file per session. */
  readonly spool: string;
  /** Signed messages waiting for delivery, one folder per session. */
  readonly inbox: string;
  readonly rejected: string;
  /** Nonces already delivered, one file per session. */
  readonly seen: string;
  readonly key: string;
  /** Holds the pid of the viewer that collects events; hooks record only while it is alive. */
  readonly ingestLock: string;
  readonly stateDir: string;
  /** The generated hook scripts. */
  readonly shareDir: string;
  readonly observeScript: string;
  readonly deliverScript: string;
  readonly waitScript: string;
  /** The folder of the lock on sending. Only root can write it; it exists once sending is locked. */
  readonly lockDir: string;
  /** The compiled helper that signs with the fingerprint key. */
  readonly signer: string;
  /** A reference to the fingerprint key, and its public half. Neither is a secret. */
  readonly fingerprintKey: string;
  readonly fingerprintPublicKey: string;
  /** Claude Code's own folders. */
  readonly claudeDir: string;
  readonly claudeSettings: string;
  readonly claudeProjects: string;
  readonly claudeSessions: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolved once, from the environment, and passed to whatever needs it. The hook scripts carry
 * these paths to the hook process themselves, so both halves always agree.
 */
export function resolveStatePaths(env: Env = process.env): StatePaths {
  const home = homedir();

  const stateDir =
    env.AGENTWATCH_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'agentwatch');

  const shareDir =
    env.AGENTWATCH_SHARE_DIR ??
    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'agentwatch');

  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');

  return {
    stateDir,
    events: join(stateDir, 'events'),
    eventsTmp: join(stateDir, 'events', '.tmp'),
    spool: join(stateDir, 'spool'),
    inbox: join(stateDir, 'inbox'),
    rejected: join(stateDir, 'rejected'),
    seen: join(stateDir, 'seen'),
    key: join(stateDir, 'key'),
    ingestLock: join(stateDir, 'ingest.lock'),
    shareDir,
    observeScript: join(shareDir, 'observe.sh'),
    deliverScript: join(shareDir, 'deliver.sh'),
    waitScript: join(shareDir, 'wait.sh'),
    lockDir: env.AGENTWATCH_LOCK_DIR ?? '/usr/local/libexec/agentwatch',
    signer: join(shareDir, 'agentwatch-signer'),
    fingerprintKey: join(stateDir, 'fingerprint-key'),
    fingerprintPublicKey: join(stateDir, 'fingerprint-key.pub'),
    claudeDir,
    claudeSettings: join(claudeDir, 'settings.json'),
    claudeProjects: join(claudeDir, 'projects'),
    claudeSessions: join(claudeDir, 'sessions'),
  };
}

/** Creates the state folders, private to the user. */
export function ensureStateDirs(paths: StatePaths): void {
  for (const dir of [
    paths.stateDir,
    paths.events,
    paths.eventsTmp,
    paths.spool,
    paths.inbox,
    paths.rejected,
    paths.seen,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
