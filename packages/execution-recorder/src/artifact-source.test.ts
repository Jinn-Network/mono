// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { snapshotArtifactSource } from "./artifact-source.js";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

afterEach(async () => {
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

describe("artifact source snapshots", () => {
  test("copies byte sources so later caller mutation cannot change the snapshot", async () => {
    const bytes = encoder.encode("before");

    const snapshot = await snapshotArtifactSource({
      bytes,
      mediaType: "text/plain",
      name: "note.txt",
    });
    bytes.fill(0);

    expect(new TextDecoder().decode(snapshot.bytes)).toBe("before");
    expect(snapshot).toMatchObject({
      mediaType: "text/plain",
      name: "note.txt",
    });
  });

  test("copies Buffer byte sources without retaining Buffer slice aliases", async () => {
    const bytes = Buffer.from("before");

    const snapshot = await snapshotArtifactSource({
      bytes,
      mediaType: "application/octet-stream",
    });
    bytes.fill(0);

    expect(new TextDecoder().decode(snapshot.bytes)).toBe("before");
  });

  test("opens a regular path once and preserves bytes after the source changes", async () => {
    const root = await temporaryDirectory("jinn-recorder-source-");
    const sourcePath = join(root, "source.txt");
    await writeFile(sourcePath, "before");

    const snapshot = await snapshotArtifactSource({
      path: sourcePath,
      mediaType: "text/plain",
    });
    await writeFile(sourcePath, "after");

    expect(new TextDecoder().decode(snapshot.bytes)).toBe("before");
  });

  test("rejects symlink and non-regular path sources", async () => {
    const root = await temporaryDirectory("jinn-recorder-source-unsafe-");
    const target = join(root, "target.txt");
    const linked = join(root, "linked.txt");
    await writeFile(target, "content");
    await symlink(target, linked);

    await expect(
      snapshotArtifactSource({
        path: linked,
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    await expect(
      snapshotArtifactSource({
        path: root,
        mediaType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  test("rejects a regular source reached through a symlinked ancestor", async () => {
    const root = await temporaryDirectory(
      "jinn-recorder-source-ancestor-symlink-",
    );
    const targetDirectory = join(root, "target");
    const linkedDirectory = join(root, "linked");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "source.txt"), "content");
    await symlink(targetDirectory, linkedDirectory);

    await expect(
      snapshotArtifactSource({
        path: join(linkedDirectory, "source.txt"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  test("preserves IO failure semantics for a missing source path", async () => {
    const root = await temporaryDirectory("jinn-recorder-source-missing-");

    await expect(
      snapshotArtifactSource({
        path: join(root, "missing.txt"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("honors cancellation before reading a path source", async () => {
    const root = await temporaryDirectory("jinn-recorder-source-abort-");
    const sourcePath = join(root, "source.txt");
    await writeFile(sourcePath, "content");
    await chmod(sourcePath, 0o600);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      snapshotArtifactSource(
        { path: sourcePath, mediaType: "text/plain" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
