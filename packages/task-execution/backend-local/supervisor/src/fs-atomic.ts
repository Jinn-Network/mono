// SPDX-License-Identifier: Apache-2.0

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Atomic durable writes (design §6.1 step 6 / §9.1 seal-once): temp-file, fsync the temp file's
 * data, rename over the destination, then fsync the CONTAINING DIRECTORY so the rename itself
 * survives a crash (POSIX rename durability requires a directory fsync — a renamed dirent is not
 * guaranteed durable until the directory entry itself is synced). A failed fsync at any step is
 * poison, not a retryable blip (§6.1 step 6) — this function never swallows an fsync failure.
 *
 * `beforeRename` is a test-only injection point (undefined in production) that lets a test
 * simulate "the process died after the temp file was fsynced but before the rename landed" — the
 * exact race the outcome-file-atomicity shim-contract fixture requires (kill -9 between temp and
 * rename). Left undefined, the sequence is data-fsync -> rename -> directory-fsync, unbroken.
 */
export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  options?: { beforeRename?: () => void },
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w");
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  options?.beforeRename?.();
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Reads a file written by `atomicWriteFileSync`, or `undefined` if it does not exist (never a partial parse — the rename is atomic, so the file is either absent or whole). */
export function readAtomicFileSync(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/**
 * Append one fsynced line to a JSONL file, then fsync the containing directory (§6.2
 * fsynced-append-before-emission — every journal append is durable before anything downstream
 * observes it). Creates the file and its directory on first use.
 */
export function appendFsyncedLineSync(path: string, line: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const text = line.endsWith("\n") ? line : `${line}\n`;
  const fd = openSync(path, "a");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Reads a JSONL file's raw text, or `""` if it does not exist yet. */
export function readTextIfExistsSync(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

/** Best-effort removal of a stray temp file left by an interrupted `atomicWriteFileSync` (design §6.1: a leftover temp file is harmless — ignored if this is never called, cleaned up if it is). */
export function removeIfExistsSync(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
