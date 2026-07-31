// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { documentDigest } from "./digest.js";
import { DerivationError } from "./errors.js";
import {
  SOURCE_COMMITMENT_RULE,
  computeSourceCommitment,
  sourceCommitmentPreImage,
  statementDigest,
  type UpstreamIdentity,
} from "./source-commitment.js";

const UPSTREAM: UpstreamIdentity = {
  dataset: "nebius/SWE-rebench",
  revision: "refs/convert/parquet-2026-05-01",
  instanceId: "acme__widget-1234",
};
const STATEMENT = "Widget.resize() raises on zero width.\n\nSteps to reproduce: …\n";

describe("source commitment (design §7.2, first writer)", () => {
  it("pins the rule id inside the hashed bytes", () => {
    expect(SOURCE_COMMITMENT_RULE).toBe("network.jinn.source-commitment/1");
  });

  it("builds the exact canonical pre-image", () => {
    const expected =
      `{"dataset":"nebius/SWE-rebench",`
      + `"instanceId":"acme__widget-1234",`
      + `"revision":"refs/convert/parquet-2026-05-01",`
      + `"rule":"network.jinn.source-commitment/1",`
      + `"statementDigest":"${statementDigest(STATEMENT)}"}`;
    expect(sourceCommitmentPreImage(UPSTREAM, STATEMENT))
      .toEqual(new TextEncoder().encode(expected));
  });

  it("is the digest of that pre-image, and is stable across calls", () => {
    const commitment = computeSourceCommitment(UPSTREAM, STATEMENT);
    expect(commitment).toBe(documentDigest(sourceCommitmentPreImage(UPSTREAM, STATEMENT)));
    expect(commitment).toBe(computeSourceCommitment(UPSTREAM, STATEMENT));
    expect(commitment).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("moves when any one of the four inputs moves", () => {
    const base = computeSourceCommitment(UPSTREAM, STATEMENT);
    expect(computeSourceCommitment({ ...UPSTREAM, dataset: "other/dataset" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment({ ...UPSTREAM, revision: "refs/other" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment({ ...UPSTREAM, instanceId: "acme__widget-1235" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment(UPSTREAM, `${STATEMENT} `)).not.toBe(base);
  });

  it("refuses an empty identity component or an empty statement", () => {
    expect(() => computeSourceCommitment({ ...UPSTREAM, dataset: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment({ ...UPSTREAM, revision: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment({ ...UPSTREAM, instanceId: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment(UPSTREAM, "")).toThrow(DerivationError);
  });
});
