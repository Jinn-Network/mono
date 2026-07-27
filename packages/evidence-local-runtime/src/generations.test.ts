// SPDX-License-Identifier: MIT
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSwitchableCatalogReader } from "./catalog-reader.js";
import {
  createCatalogGeneration,
  openCurrentCatalogGeneration,
  publishCatalogPointer,
} from "./generations.js";
import { prepareRuntimePaths } from "./paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("catalog generations", () => {
  it("publishes and reopens an exact atomic pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-generation-"));
    roots.push(root);
    const paths = await prepareRuntimePaths(root);
    const created = await createCatalogGeneration(paths);
    await publishCatalogPointer(paths, created.pointer);
    const reopened = await openCurrentCatalogGeneration(paths);
    expect(reopened?.pointer).toEqual(created.pointer);
    await reopened?.catalog.close();
    await created.catalog.close();
  });

  it("treats a missing disposable generation as rebuild-required", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-generation-missing-"));
    roots.push(root);
    const paths = await prepareRuntimePaths(root);
    const created = await createCatalogGeneration(paths);
    await publishCatalogPointer(paths, created.pointer);
    await created.catalog.close();
    await unlink(join(paths.generationsDir, created.pointer.databaseFile));

    await expect(openCurrentCatalogGeneration(paths)).resolves.toBeNull();
  });

  it("switches new reader calls while preserving the public proxy", async () => {
    const calls: string[] = [];
    const reader = (name: string) => ({
      async getRecord() { calls.push(name); return null; },
    });
    const proxy = createSwitchableCatalogReader(
      reader("old") as never,
      async () => {},
    );
    await proxy.reader.getRecord({
      family: "execution-evidence",
      digest: `sha256:${"a".repeat(64)}`,
    });
    await proxy.switchTo(reader("new") as never, async () => {});
    await proxy.reader.getRecord({
      family: "execution-evidence",
      digest: `sha256:${"b".repeat(64)}`,
    });
    expect(calls).toEqual(["old", "new"]);
    await proxy.close();
  });

  it("lets an in-flight old reader lease finish after new calls switch", async () => {
    const calls: string[] = [];
    let releaseOld!: () => void;
    const oldFinished = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldClosed = false;
    const proxy = createSwitchableCatalogReader(
      {
        async getRecord() {
          calls.push("old");
          await oldFinished;
          return null;
        },
      } as never,
      async () => { oldClosed = true; },
    );
    const oldCall = proxy.reader.getRecord({
      family: "execution-evidence",
      digest: `sha256:${"a".repeat(64)}`,
    });
    await Promise.resolve();
    await proxy.switchTo({
      async getRecord() {
        calls.push("new");
        return null;
      },
    } as never, async () => {});
    expect(oldClosed).toBe(false);
    await proxy.reader.getRecord({
      family: "execution-evidence",
      digest: `sha256:${"b".repeat(64)}`,
    });
    releaseOld();
    await oldCall;
    await vi.waitFor(() => expect(oldClosed).toBe(true));
    expect(calls).toEqual(["old", "new"]);
    await proxy.close();
  });
});
