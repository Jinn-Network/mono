// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import * as surface from "./index.js";

describe("C6 public surface", () => {
  test("exports everything C7 pins", () => {
    for (const name of [
      "openRelevanceIndex",
      "deriveSearchTerms",
      "discriminatingTerms",
      "projectContext",
      "renderFencedBlock",
      "deriveFence",
      "quoteBlock",
      "runPickup",
      "createCorpusAdmissionFilter",
      "createSensitivityClassifier",
      "createTraceSpanSource",
      "indexLocalPlane",
      "indexLocalRecord",
      "indexPublicPlane",
      "rebuildIndex",
      "RELEVANCE_FLOOR",
      "DEFAULT_PROJECTION_MAX_CHARS",
      "DEFAULT_PROJECTION_MAX_RECORDS",
      "PLANES",
    ]) {
      expect(surface).toHaveProperty(name);
    }
  });

  test("the documented constants have the documented values", () => {
    expect(surface.RELEVANCE_FLOOR).toBe(2);
    expect(surface.DEFAULT_PROJECTION_MAX_CHARS).toBe(3_500);
    expect(surface.DEFAULT_PROJECTION_MAX_RECORDS).toBe(2);
  });

  test("internals stay internal", () => {
    for (const name of ["hashFence", "INDEX_SCHEMA_SQL", "openIndexDatabase", "searchIndex"]) {
      expect(surface).not.toHaveProperty(name);
    }
  });

  test("the relevance barrel re-exports the in-package surface C7 imports", async () => {
    const barrel = await import("./relevance/index.js");
    for (const name of [
      "openRelevanceIndex",
      "deriveSearchTerms",
      "discriminatingTerms",
      "createSensitivityClassifier",
      "createTraceSpanSource",
      "RELEVANCE_FLOOR",
      "PLANES",
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  test("the frozen trio is not reachable from this component", async () => {
    const source = await import("node:fs/promises");
    const files = await source.readdir(new URL("./relevance/", import.meta.url));
    for (const file of files.filter((name) => name.endsWith(".ts"))) {
      const text = await source.readFile(new URL(`./relevance/${file}`, import.meta.url), "utf8");
      expect(text).not.toContain("@jinn-network/core");
      expect(text).not.toContain('@jinn-network/plugin"');
      expect(text).not.toContain("@jinn-network/jinn-layer");
    }
  });
});
