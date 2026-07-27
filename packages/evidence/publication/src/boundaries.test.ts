// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import * as publication from "./index.js";
import * as publicationTesting from "./testing.js";
import {
  createFilesystemPublicationJournalStore,
} from "./fs/index.js";

describe("publication entrypoint boundaries", () => {
  test("keeps the filesystem binding out of the root entrypoint", () => {
    expect(
      "createFilesystemPublicationJournalStore" in publication,
    ).toBe(false);
    expect(
      "FilesystemPublicationJournalStore" in publication,
    ).toBe(false);
    expect(createFilesystemPublicationJournalStore).toBeTypeOf("function");
  });

  test("exports contract kits only from the testing entrypoint", () => {
    expect(
      "describeAnnouncementSinkContract" in publication,
    ).toBe(false);
    expect(
      "describePublicationJournalStoreContract" in publication,
    ).toBe(false);
    expect(
      publicationTesting.describeAnnouncementSinkContract,
    ).toBeTypeOf("function");
    expect(
      publicationTesting.describePublicationJournalStoreContract,
    ).toBeTypeOf("function");
  });

  test("declares Repository as its only Jinn runtime dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      resolutions?: Record<string, string>;
    };
    expect(
      Object.keys(manifest.dependencies ?? {})
        .filter((name) => name.startsWith("@jinn-network/")),
    ).toEqual(["@jinn-network/evidence-repository"]);

    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    expect(
      Object.entries(manifest.resolutions ?? {})
        .filter(([, resolution]) => resolution.startsWith("portal:"))
        .every(([name]) => declared.has(name)),
    ).toBe(true);
  });
});
