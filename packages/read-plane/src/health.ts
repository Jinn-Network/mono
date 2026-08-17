export type HealthBody = { ok: true };

export type ReadyReason = "ready" | "degraded" | "bootstrapping";

export interface ReadyBody {
  reason: ReadyReason;
  cause?: string;
  accepting_work: boolean;
}

export function healthResponse(): HealthBody {
  return { ok: true };
}

export function readyResponse(input: {
  reason: ReadyReason;
  cause?: string;
}): { status: 200 | 503; body: ReadyBody } {
  const status = input.reason === "ready" || input.reason === "degraded" ? 200 : 503;
  const body: ReadyBody = {
    reason: input.reason,
    ...(input.cause ? { cause: input.cause } : {}),
    accepting_work: input.reason === "ready",
  };
  return { status, body };
}
