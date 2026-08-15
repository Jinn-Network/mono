import { describe, expect, it } from "vitest";
import { ChainAdmissionRefusalError } from "./chain-refusals.js";
import { readStatePredicateSpec } from "./chain-spec-reader.js";

const RECORD_HEX = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECORD_DIGEST = `sha256:${RECORD_HEX}` as const;

function statePredicateSpec(overrides: {
  readonly family?: string;
  readonly environmentHex?: string;
  readonly successPredicates?: readonly unknown[];
  readonly safetyConstraints?: readonly unknown[];
  readonly predicateSemanticsVersion?: string;
} = {}): unknown {
  return {
    family: overrides.family ?? "state-predicate",
    familyBlock: {
      environmentRecord: {
        digest: { sha256: overrides.environmentHex ?? RECORD_HEX },
        mediaType: "application/vnd.jinn.crypto-environment.v1+json",
      },
      predicateSemanticsVersion: overrides.predicateSemanticsVersion ?? "1",
      successPredicates: overrides.successPredicates ?? [
        { kind: "txOutcome", label: "tx-success", selector: { all: true }, status: "success" },
      ],
      safetyConstraints: overrides.safetyConstraints ?? [
        { kind: "approvalConstraint", label: "no-unlimited", noUnlimited: true },
      ],
      measurements: [],
      timeout: 600,
    },
  };
}

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ChainAdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("readStatePredicateSpec", () => {
  it("reads the family-discriminating fields from a state-predicate EvaluationSpec", () => {
    expect(readStatePredicateSpec(statePredicateSpec())).toStrictEqual({
      family: "state-predicate",
      environmentRecordDigest: RECORD_DIGEST,
      successPredicateIds: ["tx-success"],
      safetyConstraintIds: ["no-unlimited"],
      semanticsVersion: "1",
    });
  });

  it("converts bare DigestSet hex to sha256:-prefixed spelling", () => {
    const view = readStatePredicateSpec(statePredicateSpec({ environmentHex: RECORD_HEX }));
    expect(view.environmentRecordDigest).toBe(RECORD_DIGEST);
    expect(view.environmentRecordDigest.startsWith("sha256:")).toBe(true);
  });

  it("refuses a non-object EvaluationSpec", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(null));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("not a { family, familyBlock } document");
  });

  it("refuses deterministic-process specs at the chain entry point", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(statePredicateSpec({ family: "deterministic-process" })));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain('not "deterministic-process"');
  });

  it("refuses a missing environmentRecord digest", () => {
    const refusal = refusalOf(() => readStatePredicateSpec({
      family: "state-predicate",
      familyBlock: {
        predicateSemanticsVersion: "1",
        successPredicates: [{ kind: "txOutcome", label: "a", selector: { all: true }, status: "success" }],
        safetyConstraints: [],
        measurements: [],
        timeout: 600,
      },
    }));
    expect(refusal.code).toBe("invalid-candidate");
  });

  it("refuses a prefixed environmentRecord digest on the wire", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(statePredicateSpec({
      environmentHex: `sha256:${RECORD_HEX}`,
    })));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("bare lowercase hex");
  });

  it("refuses an empty successPredicates list", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(statePredicateSpec({ successPredicates: [] })));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("no success predicates");
  });

  it("refuses a repeated predicate id within successPredicates", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(statePredicateSpec({
      successPredicates: [
        { kind: "txOutcome", label: "dup", selector: { all: true }, status: "success" },
        { kind: "budget", label: "dup", metric: "gasTotal", cmp: "lte", value: "1" },
      ],
    })));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("repeats predicate id dup");
  });

  it("refuses a predicate without a label", () => {
    const refusal = refusalOf(() => readStatePredicateSpec(statePredicateSpec({
      successPredicates: [{ kind: "txOutcome", selector: { all: true }, status: "success" }],
    })));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("no predicate label");
  });
});
