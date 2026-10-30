// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";

import { checkRecord, loadPublishedDocuments, recordDigest } from "./index.js";
import { PUBLISHED_DOCUMENTS } from "./published-documents.js";

const require = createRequire(import.meta.url);
const OWNER = "@jinn-network/task-execution-profiles";

function carried(path: string): Uint8Array {
  return new Uint8Array(readFileSync(require.resolve(`${OWNER}/${path}`)));
}

function jsonFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.name.endsWith(".json") ? [path] : [];
  });
}

describe("the published documents this package carries", () => {
  test.each(PUBLISHED_DOCUMENTS.map(({ path, sha256 }) => [path, sha256] as const))("%s has not drifted from its pin", (path, sha256) => {
    expect(recordDigest(carried(path))).toBe(`sha256:${sha256}`);
  });

  test("every pin agrees with the sidecar the owning package publishes beside the document", () => {
    const pins = PUBLISHED_DOCUMENTS.filter(({ path }) => path !== "profiles/task-profile/v1/profile.json");
    for (const { path, sha256 } of pins) {
      const sidecar = readFileSync(require.resolve(`${OWNER}/${path.replace(/\.json$/u, ".sha256")}`), "utf8");
      expect(sidecar.trim()).toBe(`sha256:${sha256}`);
    }
  });

  test("the pins cover every document the owning package ships, so a new one cannot go unpinned", () => {
    const anchor = require.resolve(`${OWNER}/profiles/task-profile/v1/profile.json`);
    const root = dirname(dirname(dirname(anchor)));
    const shipped = jsonFiles(root).map((file) => `profiles/${relative(root, file)}`).sort();
    expect(PUBLISHED_DOCUMENTS.map(({ path }) => path).sort()).toEqual(shipped);
  });

  test("the task profiles read as profile documents and conform", async () => {
    const profiles = PUBLISHED_DOCUMENTS.filter(({ path }) => path.startsWith("profiles/task-profiles/"));
    expect(profiles).toHaveLength(4);
    for (const { path } of profiles) {
      // eslint-disable-next-line no-await-in-loop -- four small files.
      const report = await checkRecord(carried(path));
      expect(report).toMatchObject({ kind: RECORD_KINDS.profileDocument, outcome: "checked" });
    }
  });

  test("loading returns every carried document", () => {
    expect(loadPublishedDocuments().map(recordDigest).sort()).toEqual(
      PUBLISHED_DOCUMENTS.map(({ sha256 }) => `sha256:${sha256}`).sort(),
    );
  });
});

describe("a carried document whose bytes drifted", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test("is not loaded, so it can resolve nothing", async () => {
    const drifted = PUBLISHED_DOCUMENTS[0]!;
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: (path: string, ...rest: never[]) => {
          const bytes = actual.readFileSync(path, ...rest);
          return String(path).endsWith(drifted.path) ? Buffer.concat([bytes, Buffer.of(0x0a)]) : bytes;
        },
      };
    });
    vi.resetModules();
    const { loadPublishedDocuments: load } = await import("./published-documents.js");
    const digests = load().map(recordDigest);
    expect(digests).toHaveLength(PUBLISHED_DOCUMENTS.length - 1);
    expect(digests).not.toContain(`sha256:${drifted.sha256}`);
  });
});
