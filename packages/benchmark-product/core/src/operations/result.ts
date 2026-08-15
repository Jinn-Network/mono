import type { ProductErrorEnvelope } from "../errors.js";

/**
 * The machine-readable envelope on the library surface (spec §4.3) —
 * identical in shape to the CLI's `--json` output. Callers branch on `ok`,
 * and on failure on `error.code` (and `error.issues[].path` where they
 * care) — never on `error.detail`, which is prose and free to change.
 */
export type OperationResult<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ProductErrorEnvelope };
