// SPDX-License-Identifier: Apache-2.0

import { PluginRuntimeError } from "../errors.js";

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

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
