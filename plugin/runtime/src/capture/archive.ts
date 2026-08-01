// SPDX-License-Identifier: Apache-2.0

import {
  type LocalEvidenceRuntime,
  isLocalEvidenceRuntimeError,
  openLocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";

import { PluginRuntimeError } from "../errors.js";

export const ARCHIVE_BUSY_ERROR_CODE = "capture-archive-busy" as const;

const BACKOFF_MS = [25, 50, 100, 200, 400, 800] as const;

export interface CaptureArchiveOptions {
  readonly rootDir: string;
  readonly busyTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly open?: (options: {
    readonly rootDir: string;
    readonly signal?: AbortSignal;
  }) => Promise<LocalEvidenceRuntime>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function isRootInUse(error: unknown): boolean {
  return isLocalEvidenceRuntimeError(error)
    ? error.code === "ROOT_IN_USE"
    : error instanceof Error &&
        error.name === "LocalEvidenceRuntimeError" &&
        (error as { readonly code?: unknown }).code === "ROOT_IN_USE";
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Opens the local evidence archive for exactly one operation and closes it again.
 *
 * `openLocalEvidenceRuntime` takes an EXCLUSIVE SQLite lock on the root and fails with
 * `ROOT_IN_USE` rather than waiting (`packages/evidence/local-runtime/src/lock.ts`), so
 * long-lived handles are not an option: one held handle locks every other process out of the
 * archive for as long as it lives. Every component therefore opens per operation, and a
 * contended root is waited out here rather than surfaced as a failure.
 */
export async function withCaptureArchive<T>(
  options: CaptureArchiveOptions,
  run: (runtime: LocalEvidenceRuntime) => Promise<T>,
): Promise<T> {
  const open = options.open ?? openLocalEvidenceRuntime;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.busyTimeoutMs;

  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted === true) {
      throw new PluginRuntimeError(
        ARCHIVE_BUSY_ERROR_CODE,
        `Waiting for the evidence archive at ${options.rootDir} was aborted.`,
      );
    }
    let runtime: LocalEvidenceRuntime;
    try {
      runtime = await open({
        rootDir: options.rootDir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // Anything that is not lock contention — a corrupt root, an unsafe path, an abort —
      // is the caller's to see immediately; only ROOT_IN_USE is worth waiting out.
      if (!isRootInUse(error)) throw error;
      const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      if (now() + backoff > deadline) {
        throw new PluginRuntimeError(
          ARCHIVE_BUSY_ERROR_CODE,
          `Another process holds the evidence archive at ${options.rootDir}; gave up after ${String(
            options.busyTimeoutMs,
          )} ms.`,
          { cause: error },
        );
      }
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    try {
      return await run(runtime);
    } finally {
      // A close failure must never mask the operation's own outcome; the next open performs
      // the authoritative integrity check on the root.
      try {
        await runtime.close();
      } catch {
        /* intentionally swallowed */
      }
    }
  }
}
