// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { assertRecorderOperationActive, ExecutionRecorderError } from "./errors.js";
import type { StoredObjectReference } from "./journal-types.js";
import {
  assertWorkspaceContained,
  prepareWorkspaceDirectory,
  recorderIoError,
  validateWorkspaceParentChain,
  type WorkspacePaths,
} from "./paths.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function capturedObjectCorrupt(
  paths: WorkspacePaths,
  message: string,
  error?: unknown,
): ExecutionRecorderError {
  return new ExecutionRecorderError(
    "CAPTURED_OBJECT_CORRUPT",
    message,
    { workspaceDir: paths.root },
    error === undefined ? undefined : { cause: error },
  );
}

export function objectDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function objectPath(
  paths: WorkspacePaths,
  digest: Sha256Digest,
): string {
  if (!SHA256_DIGEST.test(digest)) {
    throw new ExecutionRecorderError(
      "UNSAFE_PATH",
      "Captured object digest is not canonical SHA-256.",
      { workspaceDir: paths.root },
    );
  }
  const hex = digest.slice("sha256:".length);
  const path = join(paths.objects, hex.slice(0, 2), hex.slice(2));
  assertWorkspaceContained(paths, path);
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readExistingObject(
  paths: WorkspacePaths,
  reference: StoredObjectReference,
  missingAllowed: boolean,
): Promise<Uint8Array | null> {
  const path = objectPath(paths, reference.digest);
  let handle;
  try {
    if (
      !(await validateWorkspaceParentChain(
        paths,
        path,
        true,
      ))
    ) {
      return null;
    }
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Captured object path is not a regular file: ${path}`,
        { workspaceDir: paths.root },
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
        `Captured object changed while opening: ${path}`,
        { workspaceDir: paths.root },
      );
    }
    const bytes = new Uint8Array(await handle.readFile());
    if (
      bytes.byteLength !== reference.size ||
      objectDigest(bytes) !== reference.digest
    ) {
      throw capturedObjectCorrupt(
        paths,
        `Captured object does not match its immutable reference: ${path}`,
      );
    }
    return bytes;
  } catch (error) {
    if (missingAllowed && nodeErrorCode(error) === "ENOENT") return null;
    if (error instanceof ExecutionRecorderError) throw error;
    throw capturedObjectCorrupt(
      paths,
      `Unable to verify captured object: ${path}`,
      error,
    );
  } finally {
    await handle?.close();
  }
}

export async function readStoredObject(
  paths: WorkspacePaths,
  reference: StoredObjectReference,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertRecorderOperationActive(signal);
  const bytes = await readExistingObject(paths, reference, false);
  assertRecorderOperationActive(signal);
  if (bytes === null) {
    throw capturedObjectCorrupt(
      paths,
      `Captured object is missing: ${objectPath(paths, reference.digest)}`,
    );
  }
  return bytes;
}

export async function storeObject(
  paths: WorkspacePaths,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<StoredObjectReference> {
  assertRecorderOperationActive(signal);
  const reference: StoredObjectReference = {
    digest: objectDigest(bytes),
    size: bytes.byteLength,
  };
  const path = objectPath(paths, reference.digest);
  const parent = dirname(path);
  await prepareWorkspaceDirectory(paths, parent);

  const existing = await readExistingObject(paths, reference, true);
  if (existing !== null) return reference;

  const temporary = join(
    parent,
    `.${path.slice(parent.length + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertRecorderOperationActive(signal);
    try {
      await link(temporary, path);
      await syncDirectory(parent);
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
    await unlink(temporary);
    await syncDirectory(parent);
    await readExistingObject(paths, reference, false);
    return reference;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof ExecutionRecorderError) throw error;
    throw recorderIoError(
      error,
      `Unable to publish captured object: ${path}`,
    );
  }
}
