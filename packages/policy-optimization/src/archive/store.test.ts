// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineagePair, manifestFor } from "../testing/archive-fixtures.js";
import { adopt, emptyAdoptionLog } from "./adoption.js";
import {
  appendAdoptionRecord,
  archiveLayout,
  defaultArchiveRoot,
  deriveArchive,
  readAdoptionLog,
  readArchiveProjection,
  writeArchiveProjection,
} from "./store.js";
import { ADOPTION_LOG_FILENAME, ARCHIVE_DERIVED_DIRNAME } from "./tokens.js";
import { PRODUCT_FRONTIER_DIMENSIONS, type AdoptionScope } from "./types.js";

const SCOPE: AdoptionScope = { taskProfile: "https://profiles.jinn.network/repository-work/1.0" };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "jinn-archive-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("the layout", () => {
  // The directory layout IS the §8.3 label: derivable under derived/, non-derivable outside it.
  it("puts the derivable half under derived/ and adoption outside it", () => {
    const layout = archiveLayout(root);
    expect(layout.projectionPath).toBe(join(root, ARCHIVE_DERIVED_DIRNAME, "projection.json"));
    expect(layout.adoptionPath).toBe(join(root, ADOPTION_LOG_FILENAME));
    expect(defaultArchiveRoot("/campaigns/one")).toBe(join("/campaigns/one", "archive"));
  });
});

describe("deriveArchive", () => {
  it("produces a history for every tuple in the lineage, measured or not", () => {
    const { seed, child } = lineagePair();
    const projection = deriveArchive({
      manifests: [seed.bytes, child.bytes],
      dimensions: PRODUCT_FRONTIER_DIMENSIONS,
    });
    expect(projection.derived).toBe(true);
    expect(projection.note).toContain("Safe to delete");
    expect(projection.lineage.nodes).toHaveLength(2);
    expect(projection.histories).toHaveLength(2);
    expect(projection.histories.every((history) => history.evaluations.length === 0)).toBe(true);
    expect(projection.frontier).toEqual([]);
  });

  it("carries the frontier as a digest-sorted membership list", () => {
    const seed = manifestFor({ name: "seed", fill: "1" });
    const tupleDigest = deriveArchive({
      manifests: [seed.bytes], dimensions: PRODUCT_FRONTIER_DIMENSIONS,
    }).lineage.nodes[0]!.tupleDigest;
    const projection = deriveArchive({
      manifests: [seed.bytes],
      dimensions: PRODUCT_FRONTIER_DIMENSIONS,
      frontierEntries: [{ tupleDigest, values: { quality: "0.9", cost: "1", latency: "1" } }],
    });
    expect(projection.frontier).toEqual([tupleDigest]);
  });

  it("is deterministic — two derivations of the same inputs are byte-identical", () => {
    const { seed, child } = lineagePair();
    const first = deriveArchive({ manifests: [seed.bytes, child.bytes], dimensions: PRODUCT_FRONTIER_DIMENSIONS });
    const second = deriveArchive({ manifests: [child.bytes, seed.bytes], dimensions: PRODUCT_FRONTIER_DIMENSIONS });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("the derived projection on disk", () => {
  it("round-trips, and re-derives after the directory is deleted", () => {
    const layout = archiveLayout(root);
    const { seed, child } = lineagePair();
    const projection = deriveArchive({ manifests: [seed.bytes, child.bytes], dimensions: PRODUCT_FRONTIER_DIMENSIONS });
    writeArchiveProjection(layout, projection);
    expect(readArchiveProjection(layout)).toEqual(projection);

    rmSync(layout.derivedDir, { recursive: true });
    expect(readArchiveProjection(layout)).toBeUndefined();
    writeArchiveProjection(layout, deriveArchive({
      manifests: [seed.bytes, child.bytes], dimensions: PRODUCT_FRONTIER_DIMENSIONS,
    }));
    expect(readArchiveProjection(layout)).toEqual(projection);
  });

  it("refuses a projection whose format token is not this one", () => {
    const layout = archiveLayout(root);
    mkdirSync(layout.derivedDir, { recursive: true });
    writeFileSync(layout.projectionPath, JSON.stringify({ formatToken: "other/1.0" }));
    expect(() => readArchiveProjection(layout))
      .toThrow(expect.objectContaining({ category: "invalid-document" }));
  });
});

describe("the adoption log on disk", () => {
  it("reads an absent log as empty rather than as an error", () => {
    const log = readAdoptionLog(archiveLayout(root));
    expect(log.records).toEqual([]);
    expect(log.nonDerivable).toBe(true);
    expect(existsSync(archiveLayout(root).adoptionPath)).toBe(false);
  });

  it("appends without rewriting, and round-trips adopt -> rollback through the file", () => {
    const layout = archiveLayout(root);
    const first = adopt({ log: readAdoptionLog(layout), scope: SCOPE, tupleDigest: `sha256:${"1".repeat(64)}`, requires: [], approved: [] });
    appendAdoptionRecord(layout, first);
    const second = adopt({ log: readAdoptionLog(layout), scope: SCOPE, tupleDigest: `sha256:${"2".repeat(64)}`, requires: [], approved: [] });
    const after = appendAdoptionRecord(layout, second);

    expect(after.records).toEqual([first, second]);
    expect(readAdoptionLog(layout).records).toEqual([first, second]);
    expect(JSON.parse(readFileSync(layout.adoptionPath, "utf8")).nonDerivable).toBe(true);
  });

  it("refuses a log this package did not write, rather than reading past it", () => {
    // The one file no re-derivation can rebuild: reading past a corrupt one discards the only copy.
    const layout = archiveLayout(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(layout.adoptionPath, "{ not json");
    expect(() => readAdoptionLog(layout))
      .toThrow(expect.objectContaining({ category: "invalid-document" }));
    writeFileSync(layout.adoptionPath, JSON.stringify({ ...emptyAdoptionLog(), formatToken: "other/1.0" }));
    expect(() => readAdoptionLog(layout))
      .toThrow(expect.objectContaining({ category: "invalid-document" }));
  });
});
