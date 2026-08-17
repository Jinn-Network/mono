import { ConstructorTokenGate } from "./auth.js";
import { cachePolicyHeaders } from "./freshness.js";
import { healthResponse, readyResponse } from "./health.js";
import { parseLastEventId, sseResumePlan } from "./sse.js";

/**
 * In-tree fake proving the read-plane kit passable: an in-memory surface that
 * is not the daemon HTTP server.
 */
export function createReadPlaneFake(token: string) {
  const ids = new Set<number>([1, 2, 3]);
  const gate = new ConstructorTokenGate({ token });
  return {
    health: healthResponse,
    ready: readyResponse,
    freshness: cachePolicyHeaders,
    authorize: (supplied: string | undefined) => gate.accept(supplied),
    resume: (raw: string | undefined) => sseResumePlan(parseLastEventId(raw), (id) => ids.has(id)),
  };
}
