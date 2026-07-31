// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface CapturePaths {
  readonly captureDirectory: string;
  readonly sessionsDirectory: string;
  readonly workspacesDirectory: string;
  readonly retentionWatermarkPath: string;
}

export function resolveCapturePaths(config: RuntimeConfig): CapturePaths {
  return {
    captureDirectory: config.captureDirectory,
    sessionsDirectory: join(config.captureDirectory, "sessions"),
    workspacesDirectory: join(config.captureDirectory, "workspaces"),
    retentionWatermarkPath: join(config.captureDirectory, "retention.json"),
  };
}

/**
 * Session identifiers name directories, so they are constrained to a shape that cannot
 * traverse, cannot be a relative marker, and cannot carry control characters.
 */
export function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new PluginRuntimeError(
      "capture-session-id-invalid",
      "A capture session id must be 1-128 characters of [a-z0-9-] starting with [a-z0-9].",
    );
  }
}

export function sessionDirectory(paths: CapturePaths, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(paths.sessionsDirectory, sessionId);
}

export function sessionFeedPath(paths: CapturePaths, sessionId: string): string {
  return join(sessionDirectory(paths, sessionId), "feed.ndjson");
}

export function workspaceDirectory(paths: CapturePaths, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(paths.workspacesDirectory, sessionId);
}

/**
 * Creates the directory owner-only, and tightens it if it already exists with looser
 * permissions. Matching what the evidence repository does to its own tree
 * (`packages/evidence/repository/src/fs/index.ts:120,128`) keeps the whole capture
 * footprint in one exposure class.
 */
export async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const existing = await stat(path);
  if ((existing.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

/** Creates the file if absent and forces owner-only permissions on it. */
export async function ensureOwnerOnlyFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}
