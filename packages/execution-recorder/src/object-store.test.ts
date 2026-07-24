// SPDX-License-Identifier: Apache-2.0

import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  objectPath,
  readStoredObject,
  storeObject,
} from "./object-store.js";
import {
  prepareWorkspaceDirectories,
  workspacePaths,
  type WorkspacePaths,
} from "./paths.js";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];
let paths: WorkspacePaths;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "jinn-recorder-objects-")),
  );
  temporaryDirectories.push(parent);
  paths = workspacePaths(join(parent, "recording"));
  await prepareWorkspaceDirectories(paths);
});

describe("workspace object store", () => {
  test("publishes exact bytes by SHA-256 identity without duplicating objects", async () => {
    const first = await storeObject(paths, encoder.encode("hello"));
    const second = await storeObject(paths, encoder.encode("hello"));

    expect(first).toEqual({
      digest:
        "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      size: 5,
    });
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(await readStoredObject(paths, first))).toBe(
      "hello",
    );
    expect(await readdir(join(paths.objects, "2c"))).toEqual([
      "f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ]);
    expect((await lstat(objectPath(paths, first.digest))).mode & 0o777).toBe(
      0o600,
    );
  });

  test("ignores abandoned same-directory temporary object files", async () => {
    const reference = await storeObject(paths, encoder.encode("hello"));
    const parent = join(paths.objects, "2c");
    await writeFile(join(parent, ".abandoned.tmp"), "partial", {
      mode: 0o600,
    });

    expect(new TextDecoder().decode(await readStoredObject(paths, reference))).toBe(
      "hello",
    );
  });

  test("rejects corruption of an existing captured object", async () => {
    const reference = await storeObject(paths, encoder.encode("hello"));
    await writeFile(objectPath(paths, reference.digest), "changed");

    await expect(readStoredObject(paths, reference)).rejects.toMatchObject({
      code: "CAPTURED_OBJECT_CORRUPT",
    });
    await expect(
      storeObject(paths, encoder.encode("hello")),
    ).rejects.toMatchObject({
      code: "CAPTURED_OBJECT_CORRUPT",
    });
  });

  test("rejects digest traversal and symbolic-link object paths", async () => {
    expect(() =>
      objectPath(paths, "sha256:../../outside" as Sha256Digest),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_PATH" }));

    const digest =
      `sha256:${"a".repeat(64)}` as Sha256Digest;
    const parent = join(paths.objects, "aa");
    await mkdir(parent, { mode: 0o700 });
    const outside = join(paths.root, "outside");
    await writeFile(outside, "content");
    await symlink(outside, objectPath(paths, digest));

    await expect(
      readStoredObject(paths, { digest, size: 7 }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  test("rejects symbolic-link traversal through a managed object directory", async () => {
    const outside = join(paths.root, "outside-directory");
    await mkdir(outside, { mode: 0o700 });
    await rm(paths.objects, { recursive: true });
    await symlink(outside, paths.objects);

    await expect(
      storeObject(paths, encoder.encode("must-stay-contained")),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });

  test("honors cancellation before object publication", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      storeObject(paths, encoder.encode("content"), controller.signal),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
