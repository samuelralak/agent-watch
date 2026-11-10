import type { DeliveryPath } from '../../domain/event.js';
import type { SignedMessage } from '../../domain/message.js';

/** Tells the viewer what the delivery hook did with a message. */
export interface ReceiptWriterPort {
  delivered(sessionId: string, message: SignedMessage, via: DeliveryPath): void;
  rejected(sessionId: string, file: string, reason: string): void;
}
