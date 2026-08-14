// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as surface from "./index.js";

describe("public surface", () => {
  it("exports exactly the frozen set, in sorted order", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "PACKAGE_VERSION",
      "PINNED_IMAGE",
      "SWE_REBENCH_OCI_GRADER_PROGRAM",
      "SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES",
      "SWE_REBENCH_PUBLIC_NETWORK_EXTENSION",
      "buildPinnedOciInvocation",
      "canonicalJsonBytes",
      "ensurePinnedOciImage",
      "exactSweRebenchTestCommands",
      "graderProgramDigest",
      "pinnedSweRebenchImage",
      "runPinnedOciGrader",
      "sha256Hex",
      "sweRebenchOciGraderReportSource",
    ]);
  });

  it("produces a GraderReportSource-shaped object", () => {
    const source = surface.sweRebenchOciGraderReportSource();
    expect(typeof source.read).toBe("function");
  });
});
