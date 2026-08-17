/**
 * Global structured-event emitter for the daemon.
 *
 * Singleton ring buffer + a thin `emitStructured` helper. Notifications count
 * `claim_failed` from this private buffer. `/v1/events` SSE is the lifecycle
 * CloudEvents tail (activity_events), not this ring.
 */
import { randomUUID } from 'node:crypto';
import { EventRingBuffer } from './ring-buffer.js';
import type { StructuredEvent, StructuredEventKind } from './types.js';

const RING = new EventRingBuffer(1000);

export function getEventBuffer(): EventRingBuffer {
  return RING;
}

export interface EmitInput {
  kind: StructuredEventKind;
  message: string;
  requestId?: string;
  txHash?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export function emitStructured(input: EmitInput): void {
  const event: StructuredEvent = {
    schemaVersion: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...input,
  };
  RING.push(event);
}
