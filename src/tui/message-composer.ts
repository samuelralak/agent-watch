import type { SendMessageService } from '../application/send-message.service.js';
import { type AgentState, agentLabel } from '../domain/agent.js';
import { MESSAGE_TEXT_LIMIT } from '../domain/message.js';
import type { SessionState } from '../domain/session.js';
import type { Store } from '../domain/store.js';
import { formatCount } from '../util/format.js';
import type { Style } from './paint.js';
import { TextEditor } from './text-editor.js';
import { style } from './theme.js';
import type { Draft } from './views/message-box.js';

/**
 * A draft may run past what a message holds, so that nothing typed or pasted is lost while it
 * is cut down to size. Past this it is no draft of a message any more, and is not taken.
 */
const DRAFT_ROOM = 10 * MESSAGE_TEXT_LIMIT;

export interface MessageComposerDeps {
  readonly store: Store;
  readonly sendMessage: Pick<SendMessageService, 'send'>;
  /** Tells the user something in the row under the message box. */
  readonly say: (text: string, textStyle: Style) => void;
}

/**
 * The message box: the draft being written, drafts put aside, and sending. A draft's target is
 * fixed when the box opens, so nothing that happens in the list can redirect it.
 */
export class MessageComposer {
  /** Set while the message box is open. */
  private draft: Draft | null = null;
  /** Unsent drafts, by session: closing the box never discards what was written. */
  private readonly saved = new Map<string, TextEditor>();
  /** A message is being signed and queued: the box waits, and takes no keys meanwhile. */
  private sending = false;

  constructor(private readonly deps: MessageComposerDeps) {}

  /** The draft being written, or null while the box is closed. */
  get current(): Draft | null {
    return this.draft;
  }

  /** True from Enter until the message is signed and queued, or refused. */
  get isSending(): boolean {
    return this.sending;
  }

  /** What was written to a session earlier and not sent. */
  savedDraft(sessionId: string): string | null {
    return this.saved.get(sessionId)?.text ?? null;
  }

  /** Opens the box for `session`; `agent` is the one the message is about, if any. */
  open(session: SessionState, agent: AgentState | null): Draft {
    this.draft = {
      sessionId: session.sessionId,
      sessionName: session.name,
      agentId: agent?.agentId ?? null,
      agentLabel: agent ? agentLabel(agent) : null,
      editor: this.saved.get(session.sessionId) ?? new TextEditor(),
    };

    return this.draft;
  }

  /** Closing keeps what was written; only sending or clearing discards it. */
  close(): void {
    if (!this.draft) {
      return;
    }

    // Spaces and line breaks alone are nothing to come back to.
    if (this.draft.editor.isBlank) {
      this.saved.delete(this.draft.sessionId);
    } else {
      this.saved.set(this.draft.sessionId, this.draft.editor);
    }

    this.draft = null;
  }

  /** A key pressed while the box is open. Unknown keys do nothing. */
  key(name: string): void {
    if (this.draft && !this.sending) {
      this.keys[name]?.(this.draft.editor);
    }
  }

  /**
   * Typed or pasted text. A pasted line break stays a line break: it is never the Enter key.
   * All of it goes into the draft or none of it does: text is never dropped from its end.
   */
  type(text: string): void {
    const draft = this.draft;

    if (!draft || this.sending) {
      return;
    }

    const length = draft.editor.text.length + text.length;

    if (length > DRAFT_ROOM) {
      const holds = formatCount(MESSAGE_TEXT_LIMIT);

      this.deps.say(
        `Not added: that would make ${formatCount(length)} characters, and a message holds ${holds}.`,
        style.red,
      );

      return;
    }

    draft.editor.insert(text);
  }

  private send(): void {
    const draft = this.draft;

    if (!draft) {
      return;
    }

    const text = draft.editor.text.trim();

    if (!text) {
      this.close();

      return;
    }

    const over = text.length - MESSAGE_TEXT_LIMIT;

    if (over > 0) {
      const holds = formatCount(MESSAGE_TEXT_LIMIT);

      this.deps.say(
        `Not sent: ${formatCount(over)} characters too long, a message holds ${holds}. Your draft is kept.`,
        style.red,
      );

      return;
    }

    if (!this.deps.store.sessions.get(draft.sessionId)?.alive) {
      const kept = `${draft.sessionName} has ended, so nothing was sent. Your draft is kept.`;

      this.deps.say(kept, style.red);

      return;
    }

    void this.deliver(draft, text);
  }

  /** Signs and queues the message. Signing can take a moment: a locked key waits for a touch. */
  private async deliver(draft: Draft, text: string): Promise<void> {
    this.sending = true;

    try {
      const sent = await this.deps.sendMessage.send({
        sessionId: draft.sessionId,
        text,
        aboutAgentId: draft.agentId,
        aboutLabel: draft.agentLabel,
      });

      this.deps.store.addOutbox(draft.sessionId, sent);
      this.saved.delete(draft.sessionId);
      this.draft = null;
    } catch (error) {
      // The box stays open with the draft in it.
      const reason = error instanceof Error ? error.message : String(error);

      this.deps.say(`Could not send, your draft is kept: ${reason}`, style.red);
    } finally {
      this.sending = false;
    }
  }

  private readonly keys: Readonly<Record<string, (editor: TextEditor) => void>> = {
    enter: () => this.send(),
    'alt-enter': (editor) => editor.newLine(),
    up: (editor) => editor.up(),
    down: (editor) => editor.down(),
    escape: () => this.close(),
    'ctrl-c': () => this.close(),
    backspace: (editor) => editor.backspace(),
    delete: (editor) => editor.delete(),
    left: (editor) => editor.left(),
    right: (editor) => editor.right(),
    home: (editor) => editor.home(),
    end: (editor) => editor.end(),
    'ctrl-a': (editor) => editor.home(),
    'ctrl-e': (editor) => editor.end(),
    'word-left': (editor) => editor.wordLeft(),
    'word-right': (editor) => editor.wordRight(),
    'ctrl-w': (editor) => editor.deleteWordBack(),
    'delete-word-back': (editor) => editor.deleteWordBack(),
    'delete-word-forward': (editor) => editor.deleteWordForward(),
    'ctrl-k': (editor) => editor.killToEnd(),
  };
}
