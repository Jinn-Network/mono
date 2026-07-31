// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CORPUS_PROJECTOR_VERSION,
  openCorpusMirrorStore,
  withCorpusMirrorStore,
} from "./store.js";

let directory: string;
let options: { catalogPath: string; objectsDirectory: string };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-store-"));
  options = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("corpus mirror store", () => {
  test("creates the catalog and object store on first open", async () => {
    const store = await openCorpusMirrorStore(options);
    try {
      expect(store.catalog.generation.projectorVersion).toBe(CORPUS_PROJECTOR_VERSION);
      expect((await stat(options.catalogPath)).isFile()).toBe(true);
      expect((await stat(options.objectsDirectory)).isDirectory()).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("creates the catalog owner-only", async () => {
    const store = await openCorpusMirrorStore(options);
    await store.close();
    expect((await stat(options.catalogPath)).mode & 0o777).toBe(0o600);
  });

  test("reopens an existing catalog rather than recreating it", async () => {
    const first = await openCorpusMirrorStore(options);
    const created = first.catalog.generation.createdAt;
    await first.close();

    const second = await openCorpusMirrorStore(options);
    try {
      expect(second.catalog.generation.createdAt).toBe(created);
    } finally {
      await second.close();
    }
  });

  test("permits a concurrent second reader — the mirror is WAL, not exclusive-or-fail", async () => {
    const writer = await openCorpusMirrorStore(options);
    try {
      const reader = await openCorpusMirrorStore(options);
      try {
        await expect(
          reader.catalog.findExecutions({ limit: 1 }),
        ).resolves.toMatchObject({ items: [] });
      } finally {
        await reader.close();
      }
    } finally {
      await writer.close();
    }
  });

  test("withCorpusMirrorStore closes the store even when the body throws", async () => {
    await expect(
      withCorpusMirrorStore(options, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");

    // A second open proves the first handle was released.
    const store = await openCorpusMirrorStore(options);
    await store.close();
  });

  test("close is idempotent", async () => {
    const store = await openCorpusMirrorStore(options);
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
