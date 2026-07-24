// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdtemp, open, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  prepareWorkspaceDirectories,
  workspacePaths,
} from "./paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

describe("workspace paths", () => {
  test("normalizes a caller-supplied relative workspace and creates private directories", async () => {
    const parent = await temporaryDirectory("jinn-recorder-paths-");
    const target = join(parent, "recording");
    const paths = workspacePaths(relative(process.cwd(), target));

    expect(isAbsolute(paths.root)).toBe(true);
    expect(paths.root).toBe(join(parent, "recording"));

    await prepareWorkspaceDirectories(paths);

    for (const path of [paths.root, paths.objects, paths.journal]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
  });

  test("rejects a workspace whose final component is a symbolic link", async () => {
    const parent = await temporaryDirectory("jinn-recorder-symlink-");
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    await prepareWorkspaceDirectories(workspacePaths(target));
    await symlink(target, linked);

    await expect(
      prepareWorkspaceDirectories(workspacePaths(linked)),
    ).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  test("flushes each containing directory after creating managed directories", async () => {
    const parent = await temporaryDirectory("jinn-recorder-path-sync-");
    const probe = await open(parent, "r");
    const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync");
    await probe.close();
    const paths = workspacePaths(join(parent, "recording"));

    await prepareWorkspaceDirectories(paths);
    expect(sync).toHaveBeenCalledTimes(4);

    await prepareWorkspaceDirectories(paths);
    expect(sync).toHaveBeenCalledTimes(4);
  });
});
