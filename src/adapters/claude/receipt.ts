import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReceiptSignerPort } from '../../application/ports/message-signer.port.js';
import type { ReceiptWriterPort } from '../../application/ports/receipt-writer.port.js';
import type { DeliveryPath } from '../../domain/event.js';
import type { SignedMessage } from '../../domain/message.js';
import { cleanBlock, oneLine } from '../../util/sanitize.js';
import type { StatePaths } from '../fs/state-paths.js';
import { RECEIPT_DELIVERED, RECEIPT_REJECTED } from './hook-payload.contract.js';
import type { SpoolRecord } from './spool-record.contract.js';
import type { ReceiptVerifier } from './spool-record.mapper.js';

// A receipt's text passes through the same cleaning on its way to the spool, so it is signed
// in that form.
const receiptText = (text: string | undefined): string => cleanBlock(text, 6000);
const receiptLine = (text: string | undefined): string => oneLine(text, 200);

/**
 * What a delivery receipt's signature covers. A user's message is signed as it always was, so
 * a viewer from before agents could send still reads it; an agent's adds who sent it.
 */
function deliveredFields(receipt: {
  sessionId: string;
  nonce: string;
  via: string;
  text: string;
  sender: string;
}): readonly string[] {
  const fields = [
    'delivered',
    receipt.sessionId,
    receipt.nonce,
    receipt.via,
    receiptText(receipt.text),
  ];

  return receipt.sender === 'user' ? fields : [...fields, receipt.sender];
}

const rejectedFields = (sessionId: string, file: string, reason: string) =>
  ['rejected', sessionId, receiptLine(file), receiptLine(reason)] as const;

/** Checks a receipt read from a spool against the key the delivery hook signs with. */
export function receiptVerifier(signer: ReceiptSignerPort | null): ReceiptVerifier {
  return (record: SpoolRecord) => {
    if (!signer) {
      return false;
    }

    if (record.event === RECEIPT_DELIVERED) {
      return signer.verifyReceipt(
        deliveredFields({
          sessionId: record.sessionId,
          nonce: record.nonce ?? '',
          via: record.via ?? '',
          text: record.text ?? '',
          sender: record.sender ?? 'user',
        }),
        record.mac,
      );
    }

    if (record.event === RECEIPT_REJECTED) {
      return signer.verifyReceipt(
        rejectedFields(record.sessionId, record.file ?? '', record.reason ?? ''),
        record.mac,
      );
    }

    return false;
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Writes receipts as event files, the way the observe hook records hook events, signed so the
 * viewer can tell them from files anything else drops in the event folder.
 */
export class EventFileReceiptWriter implements ReceiptWriterPort {
  constructor(
    private readonly paths: StatePaths,
    private readonly signer: ReceiptSignerPort | null,
  ) {}

  delivered(sessionId: string, message: SignedMessage, via: DeliveryPath): void {
    const { nonce, text, sender } = message;

    this.write({
      hook_event_name: RECEIPT_DELIVERED,
      session_id: sessionId,
      nonce,
      via,
      text,
      sender,
      mac: this.signer?.signReceipt(deliveredFields({ sessionId, nonce, via, text, sender })),
    });
  }

  rejected(sessionId: string, file: string, reason: string): void {
    this.write({
      hook_event_name: RECEIPT_REJECTED,
      session_id: sessionId,
      file,
      reason,
      mac: this.signer?.signReceipt(rejectedFields(sessionId, file, reason)),
    });
  }

  private write(payload: object): void {
    if (!this.viewerIsOpen()) {
      return; // nobody to read it
    }

    try {
      mkdirSync(this.paths.eventsTmp, { recursive: true, mode: 0o700 });

      const name = `receipt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const temporary = join(this.paths.eventsTmp, name);

      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      renameSync(temporary, join(this.paths.events, `${name}.json`));
    } catch {
      // The viewer will not learn the outcome; the delivery itself is unaffected.
    }
  }

  private viewerIsOpen(): boolean {
    try {
      const pid = Number(readFileSync(this.paths.ingestLock, 'utf8'));

      return Number.isInteger(pid) && pid > 0 && isAlive(pid);
    } catch {
      return false;
    }
  }
}
