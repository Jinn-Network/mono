/**
 * Durable atomic writes and fsynced appends.
 *
 * Adopted from `packages/policy-optimization/src/fs-atomic.ts` (itself adopted from the
 * local backend's supervisor) — the same three sequences for the same three reasons,
 * reproduced rather than imported because neither tree is on this product's dependency
 * allow-list and a product may not reach into a sibling package's internals for a
 * filesystem helper.
 *
 * The rules, restated so a reader here does not have to go and find them:
 *
 * - **Write to a temp file, fsync it, rename over the destination, then fsync the
 *   containing directory.** POSIX `rename` is atomic but its *durability* is not
 *   guaranteed until the directory entry itself is synced, so a crash after the rename
 *   can still lose it.
 * - **Append, then fsync the file, then fsync the directory** — every journal entry is
 *   durable before anything downstream observes it. An operation acted on but not
 *   recorded would be repeated after a restart, which is the exact failure the audit
 *   journal exists to prevent.
 * - **A failed fsync is poison, never a retryable blip** — except the ENOSYS stub some
 *   virtualized filesystems return, which is not a failure at all.
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

function isFsyncUnsupportedError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = typeof cause === "object" && cause !== null && "code" in cause
    && typeof (cause as { code: unknown }).code === "string"
    ? (cause as { code: string }).code
    : "";
  return code === "ENOSYS" || message === "Method not implemented.";
}

function fsyncBestEffortSync(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (cause) {
    if (!isFsyncUnsupportedError(cause)) throw cause;
  }
}

export function fsyncDirectorySync(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncBestEffortSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteFileSync(path: string, data: string | Uint8Array, mode?: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, "w", mode);
  try {
    writeSync(fd, data as never);
    fsyncBestEffortSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectorySync(directory);
}

/** Appends one fsynced line to a JSON Lines file, creating it and its directory on first use. */
export function appendFsyncedLineSync(path: string, line: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
    fsyncBestEffortSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectorySync(directory);
}

/** Reads a file's bytes, or `undefined` when it does not exist. */
export function readFileIfExistsSync(path: string): Uint8Array | undefined {
  if (!existsSync(path)) return undefined;
  return new Uint8Array(readFileSync(path));
}

/** Reads a JSON Lines file's raw text, or `""` when it does not exist yet. */
export function readTextIfExistsSync(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}
