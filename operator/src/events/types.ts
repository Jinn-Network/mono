/**
 * Structured event types for the operator-facing local app.
 *
 * Events are produced by the daemon (intent state transitions, errors, lifecycle
 * markers) and consumed by /v1/events SSE + /v1/events/recent JSON endpoints
 * served to the operator SPA. See docs/superpowers/specs/2026-05-01-operator-local-app-design.md.
 */
import { z } from 'zod/v3';

export const StructuredEventKindSchema = z.enum([
  'intent',
  'reward',
  'fleet',
  'system',
  'error',
  'log',
]);
export type StructuredEventKind = z.infer<typeof StructuredEventKindSchema>;

export const StructuredEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  ts: z.string(),
  kind: StructuredEventKindSchema,
  message: z.string(),
  requestId: z.string().optional(),
  txHash: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;
