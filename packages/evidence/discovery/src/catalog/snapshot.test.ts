// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";

import { InMemoryEvidenceCatalog } from "./in-memory.js";
import { enumerateCatalogSnapshot } from "./snapshot.js";
import { createCatalogContractFixtures } from "./testing.js";

describe("catalog snapshot enumeration", () => {
  test("freezes exact sorted references with the source cursor and cutoff", async () => {
    const catalog = new InMemoryEvidenceCatalog();
    const fixtures = createCatalogContractFixtures();
    for (const projection of [fixtures.publicDerivative, fixtures.privateExecution]) {
      await catalog.putRecordProjection(projection);
    }
    const snapshot = await enumerateCatalogSnapshot({
      reader: catalog,
      boundary: { sourceCursor: "journal:42", cutoff: "2026-08-16T10:00:00Z" },
    }, {
      family: "execution-evidence",
      query: { availability: "any", taskDigest: fixtures.privateExecution.task.digest },
    });
    expect(snapshot.boundary).toEqual({
      sourceCursor: "journal:42",
      cutoff: "2026-08-16T10:00:00Z",
    });
    expect(snapshot.references).toEqual([
      fixtures.privateExecution.reference,
      fixtures.publicDerivative.reference,
    ]);
  });
});
