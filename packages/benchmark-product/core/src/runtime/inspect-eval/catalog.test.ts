import { describe, expect, test } from "vitest";
import { inspectCatalogSnapshotSha256 } from "./catalog.js";

const BASE = {
  sampleIds: ["HumanEval/0", "HumanEval/1"],
  taskSourceDigest: "b".repeat(64),
  specifiedEpochs: 1,
  epochsReducer: null,
  taskVersion: null,
  datasetName: "hermetic",
  datasetLocation: null,
  datasetSampleCount: 2,
} as const;

describe("inspectCatalogSnapshotSha256", () => {
  test("is stable for an unchanged catalog", () => {
    expect(inspectCatalogSnapshotSha256(BASE)).toBe(inspectCatalogSnapshotSha256({ ...BASE }));
  });

  // `assertInspectSelectionUndrifted` compares this digest and nothing else, so a field the
  // digest ignores is a field that can move between select and lock without refusing. The
  // epochs configuration used to be excluded, which let an eval change its declared k —
  // the value official conformance is judged against — without touching eval.py's digest.
  test("changes when the epochs configuration moves under identical samples", () => {
    const pinned = inspectCatalogSnapshotSha256(BASE);
    expect(inspectCatalogSnapshotSha256({ ...BASE, specifiedEpochs: 3 })).not.toBe(pinned);
    expect(inspectCatalogSnapshotSha256({ ...BASE, epochsReducer: "mean" })).not.toBe(pinned);
    expect(inspectCatalogSnapshotSha256({ ...BASE, taskVersion: "2" })).not.toBe(pinned);
  });

  test("still changes when the sample set or task source moves", () => {
    const pinned = inspectCatalogSnapshotSha256(BASE);
    expect(inspectCatalogSnapshotSha256({ ...BASE, sampleIds: ["HumanEval/0"] })).not.toBe(pinned);
    expect(inspectCatalogSnapshotSha256({ ...BASE, taskSourceDigest: "c".repeat(64) })).not.toBe(pinned);
  });

  test("treats an absent reducer or task version as null, not as a distinct value", () => {
    const { epochsReducer: _r, taskVersion: _v, ...withoutOptional } = BASE;
    expect(inspectCatalogSnapshotSha256({ ...withoutOptional, epochsReducer: null, taskVersion: null }))
      .toBe(inspectCatalogSnapshotSha256(BASE));
  });
});
