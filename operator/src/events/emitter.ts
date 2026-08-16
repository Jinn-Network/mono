/**
 * Global structured-event emitter for the daemon.
 *
 * Singleton ring buffer + a thin `emitStructured` helper. The /v1/events SSE
 * endpoint subscribes to this buffer; the daemon's lifecycle/error sites push
 * into it. See docs/superpowers/specs/2026-05-01-operator-local-app-design.md.
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
