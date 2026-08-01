// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assertCandidate, type Candidate } from "./candidate.js";
import { DerivationError } from "./errors.js";
import { buildFixtureCandidate as candidate } from "./testing-support.js";

describe("candidate validation", () => {
  it("accepts a well-formed imported candidate", () => {
    expect(() => assertCandidate(candidate())).not.toThrow();
  });

  it("requires a non-empty statement", () => {
    expect(() => assertCandidate(candidate({ statement: "" }))).toThrow(DerivationError);
  });

  it("requires at least one fail-to-pass transition — a suite that cannot discriminate is not a task", () => {
    expect(() => assertCandidate(candidate({ transitions: { failToPass: [], passToPass: [] } })))
      .toThrow(DerivationError);
  });

  it("requires gold patch bytes", () => {
    expect(() => assertCandidate(candidate({ goldPatch: new Uint8Array() })))
      .toThrow(DerivationError);
  });

  it("requires at least one test-material descriptor whose digest matches its content", () => {
    expect(() => assertCandidate(candidate({ testMaterial: [] }))).toThrow(DerivationError);
    const wrong: Candidate = candidate();
    expect(() =>
      assertCandidate({
        ...wrong,
        testMaterial: [{ ...wrong.testMaterial[0]!, digest: `sha256:${"0".repeat(64)}` }],
      }),
    ).toThrow(DerivationError);
  });

  it("requires a positive integer timeout", () => {
    expect(() => assertCandidate(candidate({ timeout: 0 }))).toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ timeout: 90.5 }))).toThrow(DerivationError);
  });

  it("requires a declared SPDX expression (D12) and rejects free text", () => {
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "" } })))
      .toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "see LICENSE file" } })))
      .toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "Apache-2.0 WITH LLVM-exception" } })))
      .not.toThrow();
  });
});
