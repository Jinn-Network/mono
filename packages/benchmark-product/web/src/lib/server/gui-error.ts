import "server-only";

import type { ProductErrorEnvelope } from "@jinn-network/benchmark-product-core";

const PRIVATE_RUNTIME_CODES = new Set(["execution", "venue-unavailable", "venue-unverifiable"]);

/** Runtime diagnostics may originate in filesystem, launcher, or subprocess exceptions. Keep
 * their typed category for recovery while retaining exact detail only in core journals/logs. */
export function projectProductErrorForGui(error: ProductErrorEnvelope): ProductErrorEnvelope {
  if (!PRIVATE_RUNTIME_CODES.has(error.code)) return error;
  return {
    code: error.code,
    detail: "The operation stopped inside the local runtime. Retry when the condition is resolved; diagnostic details are available in server logs.",
  };
}
