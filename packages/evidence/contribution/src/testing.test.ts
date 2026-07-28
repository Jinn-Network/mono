// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { describeEvidenceContributionContract } from "./testing.js";
import { InMemoryEvidenceContributionDriver } from "./testing-fixtures.js";

describeEvidenceContributionContract(() => new InMemoryEvidenceContributionDriver());

describe("root export boundary", () => {
  test("the root entrypoint never exports testing constructors or Vitest symbols", async () => {
    const root = await import("./index.js");
    expect((root as Record<string, unknown>).InMemoryEvidenceContributionDriver).toBeUndefined();
    expect((root as Record<string, unknown>).describeEvidenceContributionContract).toBeUndefined();
    expect((root as Record<string, unknown>).InMemoryContributionStore).toBeUndefined();
  });
});
