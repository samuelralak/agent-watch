import { randomBytes } from 'node:crypto';
import { HookEventSource } from '../adapters/claude/hook-event-source.js';
import { HookInstaller } from '../adapters/claude/hook-installer.js';
import { stableNodePath } from '../adapters/claude/hook-scripts.js';
import { receiptVerifier } from '../adapters/claude/receipt.js';
import { TranscriptSessionHistory } from '../adapters/claude/session-history.adapter.js';
import { ClaudeSessionListAdapter } from '../adapters/claude/session-list.adapter.js';
import { TranscriptToolExchange } from '../adapters/claude/tool-exchange.adapter.js';
import { TranscriptSource } from '../adapters/claude/transcript-source.js';
import { VERIFIED_CLAUDE_VERSIONS } from '../adapters/claude/verified-versions.js';
import { HmacSigner } from '../adapters/crypto/hmac-signer.adapter.js';
import { EnclaveSigner } from '../adapters/enclave/enclave-signer.adapter.js';
import { EventIngester } from '../adapters/fs/event-ingester.js';
import { FileInbox } from '../adapters/fs/inbox.adapter.js';
import { IngestLock } from '../adapters/fs/ingest-lock.js';
import { ensureStateDirs, resolveStatePaths, type StatePaths } from '../adapters/fs/state-paths.js';
import { LockSetup } from '../adapters/lock/lock-setup.js';
import { SystemLock } from '../adapters/lock/system-lock.adapter.js';
import type { InboxPort } from '../application/ports/inbox.port.js';
import { SendMessageService } from '../application/send-message.service.js';
import { WatchService } from '../application/watch.service.js';
import type { WatchEvent } from '../domain/event.js';
import { Store } from '../domain/store.js';
import type { SendCommandDeps } from './send.command.js';
import { WatchApp } from './watch-app.js';

export interface WatchAppOptions {
  /** How long finished agents stay listed. */
  readonly recentMs: number;
  readonly sessionFilter: string | null;
  readonly hookEntry: string;
}

/**
 * The installer for this build: the Node that runs it, and the hook entry point it ships.
 * `hookEntry` comes from the CLI's entry file, the one module whose own path is known after
 * bundling.
 */
export function composeInstaller(
  hookEntry: string,
  paths: StatePaths = resolveStatePaths(),
): HookInstaller {
  return new HookInstaller({ paths, node: stableNodePath(process.execPath), hookEntry });
}

/** Builds the adapters and wires them to the store and the services. Nothing runs until `start`. */
export function composeWatchApp(options: WatchAppOptions): WatchApp {
  const paths = resolveStatePaths();

  ensureStateDirs(paths);

  const store = new Store();
  const sharedKey = HmacSigner.load(paths.key);
  const inbox = new FileInbox(paths);
  const locked = new SystemLock(paths.lockDir).isLocked;
  const fingerprint = locked ? fingerprintSigner(paths, store) : null;

  const history = new TranscriptSource({
    projectsDir: paths.claudeProjects,
    recentMs: options.recentMs,
    emit: (event) => store.apply(event),
  });

  const past = new TranscriptSessionHistory(paths.claudeProjects);

  return new WatchApp({
    store,
    inbox,
    locked,
    watch: composeWatchService({ paths, store, signer: sharedKey, inbox, history, options }),
    history: past,
    // A call is looked up where its session is kept: among the running ones, or the past ones.
    toolExchange: new TranscriptToolExchange(
      (sessionId, agentId) =>
        history.transcriptFile(sessionId, agentId) ?? past.transcriptFile(sessionId, agentId),
    ),
    sendMessage: new SendMessageService({ signer: fingerprint ?? sharedKey, inbox, newNonce }),
    installer: composeInstaller(options.hookEntry, paths),
    release: () => fingerprint?.close(),
  });
}

const newNonce = (): string => randomBytes(16).toString('hex');

/**
 * Signs the user's messages with their fingerprint key: one touch for the whole window. The
 * prompt names the session of the message that caused it, so a prompt nobody caused stands out.
 */
function fingerprintSigner(paths: StatePaths, store: Store): EnclaveSigner {
  return new EnclaveSigner({
    helper: paths.signer,
    keyFile: paths.fingerprintKey,
    reason: (fields) => {
      const session = store.sessions.get(fields.session)?.name ?? 'a session';

      return `send your agentwatch message to ${session}, and later ones from this window`;
    },
  });
}

/** Turning the lock on sending on and off. `signerSource` is the helper's Swift source. */
export function composeLockSetup(signerSource: string): LockSetup {
  return new LockSetup({ paths: resolveStatePaths(), signerSource });
}

/** What `agentwatch send` needs: who is running, what agents may send, and how to sign. */
export function composeSendCommand(write: (line: string) => void): SendCommandDeps {
  const paths = resolveStatePaths();

  ensureStateDirs(paths);

  return {
    write,
    newNonce,
    sessionList: new ClaudeSessionListAdapter(paths.claudeSessions),
    trust: new SystemLock(paths.lockDir).trust(),
    inbox: new FileInbox(paths),
    sharedKey: HmacSigner.load(paths.key),
    approver: (reason) =>
      new EnclaveSigner({
        helper: paths.signer,
        keyFile: paths.fingerprintKey,
        approveEach: true,
        reason: () => reason,
      }),
  };
}

interface WatchServiceParts {
  readonly paths: StatePaths;
  readonly store: Store;
  readonly signer: HmacSigner;
  readonly inbox: InboxPort;
  readonly history: TranscriptSource;
  readonly options: WatchAppOptions;
}

/** The three sources of what sessions do, each feeding the store, paced by one service. */
function composeWatchService(parts: WatchServiceParts): WatchService {
  const { paths, store, signer, inbox, history, options } = parts;
  const emit = (event: WatchEvent): void => store.apply(event);

  const liveEvents = new HookEventSource({
    spoolDir: paths.spool,
    emit,
    verifyReceipt: receiptVerifier(signer),
    onLive: (sessionId, since) => watch.noteLive(sessionId, since),
  });

  const collector = new EventIngester(paths, new IngestLock(paths.ingestLock), {
    onSpooled: (sessionId) => liveEvents.pump(sessionId),
  });

  const watch: WatchService = new WatchService({
    store,
    history,
    liveEvents,
    collector,
    inbox,
    sessionList: new ClaudeSessionListAdapter(paths.claudeSessions),
    sessionFilter: options.sessionFilter,
    recentMs: options.recentMs,
    verifiedVersions: VERIFIED_CLAUDE_VERSIONS,
  });

  return watch;
}
