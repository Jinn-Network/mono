import { describe, expect, it } from "vitest";
import type { SourceChainOutcome, SourceHeadOutcome } from "./outcomes.js";
import {
  SOURCE_HEAD_ORIGIN_PRECHECK_REASON,
  sourceChainRefusalReason,
  sourceHeadRefusalReason,
} from "./outcomes.js";

const REFUSALS = [
  "stale",
  "unauthorized-signer",
  "refresh-by-ceiling",
  "head-issued-ahead",
  "head-origin-mismatch",
  "head-payload-mismatch",
  "invalid-head-envelope",
] as const satisfies readonly Exclude<SourceHeadOutcome["status"], "ok">[];

const SLUGS = {
  stale: "stale-source-head",
  "unauthorized-signer": "unauthorized-source-signer",
  "refresh-by-ceiling": "refresh-by-ceiling",
  "head-issued-ahead": "head-issued-ahead",
  "head-origin-mismatch": "head-origin-mismatch",
  "head-payload-mismatch": "head-payload-mismatch",
  "invalid-head-envelope": "invalid-head-envelope",
} as const;

describe("sourceHeadRefusalReason (#3494)", () => {
  it.each(REFUSALS)("maps %s to the shared consumer slug", (status) => {
    expect(sourceHeadRefusalReason(status)).toBe(SLUGS[status]);
  });

  it("does not reuse the pre-verifier origin slug for the in-procedure origin refusal", () => {
    expect(SOURCE_HEAD_ORIGIN_PRECHECK_REASON).toBe("source-head-origin-mismatch");
    expect(sourceHeadRefusalReason("head-origin-mismatch")).not.toBe(
      SOURCE_HEAD_ORIGIN_PRECHECK_REASON,
    );
    expect(sourceHeadRefusalReason("head-origin-mismatch")).toBe("head-origin-mismatch");
  });
});

const CHAIN_REFUSALS = [
  "stale",
  "forked",
  "broken-chain",
  "unauthorized-signer",
] as const satisfies readonly Exclude<SourceChainOutcome["status"], "ok">[];

const CHAIN_SLUGS = {
  stale: "stale-source-head",
  forked: "forked-source-chain",
  "broken-chain": "discontinuous-source-chain",
  "unauthorized-signer": "unauthorized-source-signer",
} as const;

describe("sourceChainRefusalReason (#3494)", () => {
  it.each(CHAIN_REFUSALS)("maps %s to the shared consumer slug", (status) => {
    expect(sourceChainRefusalReason(status)).toBe(CHAIN_SLUGS[status]);
  });

  it("shares the same slug as the head path for the two faults both procedures can report", () => {
    expect(sourceChainRefusalReason("stale")).toBe(sourceHeadRefusalReason("stale"));
    expect(sourceChainRefusalReason("unauthorized-signer")).toBe(
      sourceHeadRefusalReason("unauthorized-signer"),
    );
  });
});
