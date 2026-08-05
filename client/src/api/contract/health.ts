/**
 * `GET /health` + `GET /ready` response schemas (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.1, §14.5; issue #2404).
 *
 * Both routes are UNGATED — the only ungated operator-listener routes besides `/metrics`
 * (§6.2) — so their payloads are deliberately shallow: booleans and machine reason codes
 * only, never identity/path/credential material. No `contractVersion` here by design: §8's
 * "every read payload carries `contractVersion`" rule targets the versioned read contract
 * (`/v1/status` and its successors); these two liveness/readiness probes stay a fixed,
 * minimal shape a supervisor (Railway, k8s, systemd) can parse without any handshake.
 */
import { z } from 'zod/v4';

export const healthResponseSchema = z.looseObject({
  ok: z.literal(true),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * `reason` mirrors `DaemonReadiness` (`daemon/loop-heartbeat.ts`) exactly and is the SOLE
 * discriminator (spec §6.1: "the machine reason code is the discriminator"). `cause` is
 * populated only when a `degraded` readiness has a persisted bootstrap-halt envelope code
 * available (`errors/persisted-bootstrap-error.ts`) — omitted otherwise, never fabricated.
 * `accepting_work` is intentionally snake_case (matches the spec's exact wording) and is its
 * own field precisely so readiness and work admission can never be conflated by a consumer
 * (spec §5's per-loop `admission` field is the same distinction, restated on the wire).
 */
export const readyResponseSchema = z.looseObject({
  reason: z.enum(['ready', 'degraded', 'bootstrapping']),
  cause: z.string().optional(),
  accepting_work: z.boolean(),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
