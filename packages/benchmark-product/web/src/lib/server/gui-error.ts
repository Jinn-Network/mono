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

/** Publish receipts can contain filesystem failures from immutable-target checks. Preserve only
 * the typed recovery category and stable logical issue paths at the browser boundary. */
export function projectPublishErrorForGui(error: ProductErrorEnvelope): ProductErrorEnvelope {
  const safePath = (path: string): string => /^[A-Za-z0-9_.-]+$/u.test(path) && !path.startsWith(".")
    ? path
    : "publish.target";
  return {
    code: error.code,
    detail: `Publication was refused (${error.code}). The server retained diagnostic details locally.`,
    ...(error.issues === undefined
      ? {}
      : {
          issues: error.issues.map((issue) => ({
            path: safePath(issue.path),
            message: "Publication could not safely complete at this logical boundary.",
          })),
        }),
  };
}
