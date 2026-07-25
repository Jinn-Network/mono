// SPDX-License-Identifier: Apache-2.0

import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assertPinnedWorkspaceDirectory,
  pinWorkspaceDirectory,
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
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
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

  test("rejects an existing workspace reached through a symlinked ancestor", async () => {
    const parent = await temporaryDirectory(
      "jinn-recorder-ancestor-symlink-",
    );
    const targetParent = join(parent, "target");
    const linkedParent = join(parent, "linked");
    const target = join(targetParent, "recording");
    await mkdir(targetParent);
    await prepareWorkspaceDirectories(workspacePaths(target));
    await symlink(targetParent, linkedParent);

    await expect(
      prepareWorkspaceDirectories(
        workspacePaths(join(linkedParent, "recording")),
      ),
    ).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  test("rejects a symlinked ancestor before creating a missing workspace root", async () => {
    const parent = await temporaryDirectory(
      "jinn-recorder-missing-root-ancestor-symlink-",
    );
    const targetParent = join(parent, "target");
    const linkedParent = join(parent, "linked");
    await mkdir(targetParent);
    await symlink(targetParent, linkedParent);
    const target = join(linkedParent, "first", "recording");

    await expect(
      prepareWorkspaceDirectories(workspacePaths(target)),
    ).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });

    await expect(lstat(join(targetParent, "first"))).rejects.toMatchObject({
      code: "ENOENT",
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

  test("creates and flushes every missing workspace ancestor", async () => {
    const parent = await temporaryDirectory(
      "jinn-recorder-nested-path-sync-",
    );
    const probe = await open(parent, "r");
    const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync");
    await probe.close();
    const first = join(parent, "first");
    const second = join(first, "second");
    const paths = workspacePaths(join(second, "recording"));

    await prepareWorkspaceDirectories(paths);

    for (const path of [
      first,
      second,
      paths.root,
      join(paths.root, "objects"),
      paths.objects,
      paths.journal,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    expect(sync).toHaveBeenCalledTimes(6);

    await prepareWorkspaceDirectories(paths);
    expect(sync).toHaveBeenCalledTimes(6);
  });

  test("detects replacement of a pinned workspace directory", async () => {
    const parent = await temporaryDirectory("jinn-recorder-path-pin-");
    const paths = workspacePaths(join(parent, "recording"));
    await prepareWorkspaceDirectories(paths);
    const pinned = await pinWorkspaceDirectory(paths, paths.journal);

    try {
      expect(typeof pinned.device).toBe("bigint");
      expect(typeof pinned.inode).toBe("bigint");
      await rename(paths.journal, join(paths.root, "journal-moved"));
      await mkdir(paths.journal, { mode: 0o700 });

      await expect(
        assertPinnedWorkspaceDirectory(paths, pinned),
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    } finally {
      await pinned.handle.close();
    }
  });
});
