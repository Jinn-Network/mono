// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { environmentRecordDigest, sealEnvironmentRecord } from "@jinn-network/environment-record";
import { loadDerivationEnvironment } from "./strategy.js";
import { buildFixtureEnvironmentRecordBody } from "./testing-support.js";

describe("derivation environment", () => {
  it("parses and digests the record from its bytes, so the three cannot desync", () => {
    const bytes = sealEnvironmentRecord(buildFixtureEnvironmentRecordBody());
    const env = loadDerivationEnvironment(bytes);
    expect(env.recordBytes).toEqual(bytes);
    expect(env.recordDigest).toBe(environmentRecordDigest(bytes));
    expect(env.record.image.platform).toBe("linux/amd64");
  });
});
