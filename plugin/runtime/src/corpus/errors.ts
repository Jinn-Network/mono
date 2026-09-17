// SPDX-License-Identifier: Apache-2.0

import { PluginRuntimeError } from "../errors.js";
import type { RuntimeLogger } from "../logger.js";

/**
 * C3 declares `PluginRuntimeError.code` as a plain string precisely so a
 * component can add codes without editing a closed union. Every C5 code is
 * `corpus-`-prefixed so it never collides with C3's or C4's.
 */
export const CORPUS_ERROR_CODES = Object.freeze({
  syncLockIo: "corpus-sync-lock-io",
  highWaterMarkIo: "corpus-high-water-mark-io",
  highWaterMarkCorrupt: "corpus-high-water-mark-corrupt",
  mirrorStoreIo: "corpus-mirror-store-io",
  recordDigestMismatch: "corpus-record-digest-mismatch",
  repositoryReadOnly: "corpus-repository-read-only",
  sourceMismatch: "corpus-source-mismatch",
} as const);

export type CorpusErrorCode = (typeof CORPUS_ERROR_CODES)[keyof typeof CORPUS_ERROR_CODES];

export class CorpusMirrorError extends PluginRuntimeError {
  override readonly cause?: unknown;

  constructor(code: CorpusErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(code, message);
    this.name = "CorpusMirrorError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Extracts a Node `error.code` without widening the type of an unknown throw. */
export function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

/**
 * Peer-influenced. Terminal-control sequences are stripped at the log
 * boundary, not per site: `createLineLogger` (`logger.ts`) removes DEL and
 * C1 (U+007F-U+009F) from every emitted string value and message, and the
 * JSON it emits escapes C0 (ESC lands as the six-character backslash-u-001b
 * escape). `sanitizeUntrustedText` still owns the durable-file and
 * rendered-row boundaries.
 * Accepted (#4482); the logger-level strip landed as the follow-up (#4552).
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A logger that faults is not allowed to become the fault. `sync-loop.ts`
 * guards its `cycle.unreported` warn this way (see the comment there) because
 * a stderr EPIPE must not stop the loop; the same rule holds module-wide,
 * where a throw from a warn inside a catch changes the CODE a source's
 * failure is reported under (#4482). The line is the accepted loss; the
 * verdict is not.
 */
export function bestEffortLogger(log: RuntimeLogger): RuntimeLogger {
  const guard =
    (level: keyof RuntimeLogger) =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      try {
        log[level](message, fields);
      } catch {
        // The logger itself. Nothing is left to report it to.
      }
    };
  return { debug: guard("debug"), info: guard("info"), warn: guard("warn"), error: guard("error") };
}
