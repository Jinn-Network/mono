// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { assertRecorderOperationActive, ExecutionRecorderError } from "./errors.js";
import {
  assertNoSymlinkPathComponents,
  recorderIoError,
} from "./paths.js";
import type { ArtifactSource } from "./types.js";

export interface ArtifactSourceSnapshot {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export async function snapshotArtifactSource(
  source: ArtifactSource,
  signal?: AbortSignal,
): Promise<ArtifactSourceSnapshot> {
  assertRecorderOperationActive(signal);
  if (source.bytes !== undefined) {
    return {
      bytes: Uint8Array.from(source.bytes),
      mediaType: source.mediaType,
      ...(source.name === undefined ? {} : { name: source.name }),
    };
  }

  const path = resolve(source.path);
  let handle;
  try {
    await assertNoSymlinkPathComponents(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Artifact source must be a regular file and not a symlink: ${path}`,
      );
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Artifact source changed while opening: ${path}`,
      );
    }
    const bytes = new Uint8Array(await handle.readFile());
    assertRecorderOperationActive(signal);
    return {
      bytes,
      mediaType: source.mediaType,
      ...(source.name === undefined ? {} : { name: source.name }),
    };
  } catch (error) {
    if (nodeErrorCode(error) === "ELOOP") {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Artifact source must not be a symlink: ${path}`,
        undefined,
        { cause: error },
      );
    }
    throw recorderIoError(
      error,
      `Unable to snapshot artifact source: ${path}`,
    );
  } finally {
    await handle?.close();
  }
}
