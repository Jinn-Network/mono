import "server-only";

import type { ProductErrorCode, ProductErrorEnvelope } from "@colophon-claims/core";

const SAFE_DETAILS: Readonly<Record<ProductErrorCode, string>> = {
  validation: "The supplied input was not accepted. Correct the named fields and retry.",
  "illegal-transition": "This action is not available in the current lifecycle state. Refresh the page and choose an enabled action.",
  "authority-denied": "The configured principal does not hold the required authority for this action.",
  "record-integrity": "Stored evidence did not pass its integrity check. Do not rely on this result; inspect the server record and retry.",
  "journal-integrity": "The durable journal did not pass its integrity check. Inspect the server record before retrying.",
  "not-found": "The requested product state was not found. Refresh after confirming it exists on the server.",
  conflict: "The operation conflicts with current durable state. Refresh and retry against the latest state.",
  "invalid-invocation": "The request was not accepted. Correct the submitted fields and retry.",
  "venue-unavailable": "The local execution venue is unavailable. Retry when the server-side condition is resolved.",
  "venue-unverifiable": "The selected venue cannot verify the required guarantee. Choose a supported venue or change the requirement.",
  execution: "The operation stopped inside the local runtime. Retry when the condition is resolved; diagnostic details are available in server logs.",
};

function safeIssuePath(path: string): string {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path) ? path : "operation.input";
}

/** Runtime diagnostics may originate in filesystem, launcher, or subprocess exceptions. Keep
 * their typed category for recovery while retaining exact detail only in core journals/logs. */
export function projectProductErrorForGui(error: ProductErrorEnvelope): ProductErrorEnvelope {
  return {
    code: error.code,
    detail: SAFE_DETAILS[error.code],
    ...(error.issues === undefined
      ? {}
      : {
          issues: error.issues.map((issue) => ({
            path: safeIssuePath(issue.path),
            message: "The server rejected this field or boundary.",
          })),
        }),
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
