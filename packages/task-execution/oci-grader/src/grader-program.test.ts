// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  graderProgramDigest,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
  SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES,
} from "./grader-program.js";

describe("the frozen swe-rebench grader program", () => {
  it("is a python program that writes its report to the output mount", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM.startsWith("#!/usr/bin/env python3")).toBe(true);
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain('OUT = pathlib.Path("/jinn/out")');
  });

  it("exposes its exact UTF-8 bytes", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES).toEqual(
      new TextEncoder().encode(SWE_REBENCH_OCI_GRADER_PROGRAM),
    );
  });

  it("digests exactly those bytes, prefixed, and is stable across calls", () => {
    const expected = `sha256:${createHash("sha256")
      .update(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES)
      .digest("hex")}`;

    expect(graderProgramDigest()).toBe(expected);
    expect(graderProgramDigest()).toBe(graderProgramDigest());
    expect(graderProgramDigest()).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("is frozen: the digest matches the value published at method lock", () => {
    // LOCK FREEZE. This literal is the grader program's published identity. Changing the program
    // changes the science: any edit MUST be a deliberate, reviewed change that re-publishes the
    // digest in the locked method document before the next official cell runs. Never "just
    // update the expected value" to make this test green.
    expect(graderProgramDigest()).toBe(
      "sha256:8194eb47ad010d8e1ce2f5f4a5becd3354102f80c138aad836cfd3b0e8b2ab11",
    );
  });
});
