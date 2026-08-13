// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./index.js";

describe("@jinn-network/task-execution-oci-grader", () => {
  it("declares its package version", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});
