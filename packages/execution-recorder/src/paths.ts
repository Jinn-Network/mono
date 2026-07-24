// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ExecutionRecorderError } from "./errors.js";

export interface WorkspacePaths {
  readonly root: string;
  readonly marker: string;
  readonly objects: string;
  readonly journal: string;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function recorderIoError(
  error: unknown,
  message: string,
  code: "IO_FAILURE" | "UNSAFE_PATH" | "WORKSPACE_CORRUPT" = "IO_FAILURE",
): ExecutionRecorderError {
  if (error instanceof ExecutionRecorderError) return error;
  return new ExecutionRecorderError(code, message, undefined, {
    cause: error,
  });
}

export function workspacePaths(workspaceDir: string): WorkspacePaths {
  const root = resolve(workspaceDir);
  return {
    root,
    marker: join(root, "workspace.json"),
    objects: join(root, "objects", "sha256"),
    journal: join(root, "journal"),
  };
}

export function assertWorkspaceContained(
  paths: WorkspacePaths,
  path: string,
): void {
  const relativePath = relative(paths.root, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new ExecutionRecorderError(
      "UNSAFE_PATH",
      `Recorder-owned path escapes the workspace: ${path}`,
      { workspaceDir: paths.root },
    );
  }
}

export async function prepareWorkspaceDirectory(
  paths: WorkspacePaths,
  path: string,
): Promise<void> {
  assertWorkspaceContained(paths, path);
  try {
    if (path === paths.root) {
      const created = await mkdir(path, { recursive: true, mode: 0o700 });
      await secureWorkspaceDirectory(paths, path, true);
      if (created !== undefined) await syncDirectory(dirname(path));
      return;
    }

    await secureWorkspaceDirectory(paths, paths.root, true);
    const segments = relative(paths.root, path).split(sep).filter(Boolean);
    let current = paths.root;
    for (const segment of segments) {
      current = join(current, segment);
      let created = false;
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
      }
      await secureWorkspaceDirectory(paths, current, true);
      if (created) await syncDirectory(dirname(current));
    }
  } catch (error) {
    if (nodeErrorCode(error) === "ELOOP") {
      throw recorderIoError(
        error,
        `Recorder workspace path must not be a symlink: ${path}`,
        "UNSAFE_PATH",
      );
    }
    throw recorderIoError(
      error,
      `Unable to prepare recorder workspace directory: ${path}`,
    );
  }
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
    try {
      await handle.sync();
    } catch (error) {
      if (
        !["EINVAL", "ENOSYS", "ENOTSUP"].includes(
          nodeErrorCode(error) ?? "",
        )
      ) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

async function secureWorkspaceDirectory(
  paths: WorkspacePaths,
  path: string,
  setPrivateMode: boolean,
): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new ExecutionRecorderError(
      "UNSAFE_PATH",
      `Recorder workspace path must be a directory and not a symlink: ${path}`,
      { workspaceDir: paths.root },
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Recorder workspace directory changed while opening: ${path}`,
        { workspaceDir: paths.root },
      );
    }
    if (setPrivateMode && process.platform !== "win32") {
      await handle.chmod(0o700);
    }
  } finally {
    await handle.close();
  }
}

export async function prepareWorkspaceDirectories(
  paths: WorkspacePaths,
): Promise<void> {
  await prepareWorkspaceDirectory(paths, paths.root);
  await prepareWorkspaceDirectory(paths, join(paths.root, "objects"));
  await prepareWorkspaceDirectory(paths, paths.objects);
  await prepareWorkspaceDirectory(paths, paths.journal);
}

export async function validateWorkspaceParentChain(
  paths: WorkspacePaths,
  path: string,
  missingAllowed = false,
): Promise<boolean> {
  assertWorkspaceContained(paths, path);
  try {
    await secureWorkspaceDirectory(paths, paths.root, false);
  } catch (error) {
    if (missingAllowed && nodeErrorCode(error) === "ENOENT") return false;
    throw recorderIoError(
      error,
      `Unable to validate recorder workspace root: ${paths.root}`,
      "UNSAFE_PATH",
    );
  }
  const relativeParent = relative(paths.root, path);
  const segments = relativeParent.split(sep).filter(Boolean);
  let current = paths.root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      await secureWorkspaceDirectory(paths, current, false);
    } catch (error) {
      if (missingAllowed && nodeErrorCode(error) === "ENOENT") return false;
      throw recorderIoError(
        error,
        `Unable to validate recorder workspace directory: ${current}`,
        "UNSAFE_PATH",
      );
    }
  }
  return true;
}

export async function validateWorkspaceDirectory(
  paths: WorkspacePaths,
  path: string,
): Promise<void> {
  assertWorkspaceContained(paths, path);
  try {
    await secureWorkspaceDirectory(paths, path, false);
  } catch (error) {
    throw recorderIoError(
      error,
      `Unable to validate recorder workspace directory: ${path}`,
      "UNSAFE_PATH",
    );
  }
}
