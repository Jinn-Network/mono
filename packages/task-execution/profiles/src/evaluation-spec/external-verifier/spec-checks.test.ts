import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../../errors.js";
import { EVAL_SEMANTICS_VERSION } from "../../identifiers.js";
import { GRADER_FAMILIES, type EvaluationSpec } from "../schema.js";
import { parseEvaluationSpec, sealEvaluationSpec } from "../seal.js";
import { checkMeasurementCoverage } from "../measurements.js";
import { checkVerdictConsistency } from "../verdict-consistency.js";
import { evaluateVerdictRule, type VerdictRule } from "../verdict-rule.js";
import { readExternalVerifierMeasurements } from "./measurements.js";
import { harborPackageContentHash } from "./package-digest.js";
import { checkExternalVerifierSpec } from "./spec-checks.js";

const fixturesRoot = new URL("../../../fixtures/evaluation-spec/", import.meta.url);
const fixture = (relativePath: string) => readFile(new URL(relativePath, fixturesRoot), "utf8");

async function golden(): Promise<EvaluationSpec> {
  return JSON.parse(await fixture("golden/external-verifier-minimal.json")) as EvaluationSpec;
}

function refusalCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof ProfilesError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

/** A rule a benchmark whose verifier writes only 0 or 1 can seal: pass at 1, fail at 0, and
 * inconclusive under a declared class for any other value. */
const GUARDED_RULE: VerdictRule = {
  all: [
    {
      inconclusiveWhen: {
        not: {
          any: [
            { threshold: { measurement: "reward", op: "eq", value: 0 } },
            { threshold: { measurement: "reward", op: "eq", value: 1 } },
          ],
        },
      },
      class: "non-binary-reward",
    },
    { threshold: { measurement: "reward", op: "eq", value: 1 } },
  ],
};

async function guardedSpec(): Promise<EvaluationSpec> {
  return {
    ...(await golden()),
    verdictRule: GUARDED_RULE,
    unscorable: [{ name: "non-binary-reward", disposition: "recorded-inconclusive" }],
  };
}

describe("external-verifier spec checks", () => {
  it("adds the family as the sixth and leaves the first five where they were", () => {
    expect(GRADER_FAMILIES).toEqual([
      "deterministic-process",
      "model-graded",
      "human-review",
      "composite",
      "state-predicate",
      "external-verifier",
    ]);
  });

  it("round-trips the golden spec and seals it to the pinned digest", async () => {
    const spec = await golden();
    const pinned = (await fixture("golden/external-verifier-minimal.sha256")).trim();
    const sealed = sealEvaluationSpec(spec);
    expect(sealed.digest).toBe(pinned);
    expect(pinned).toBe("sha256:7929fd9e8bba524affeeda218bff8146ecfa93de643bdd91d41903ffc037475b");
    expect(parseEvaluationSpec(sealed.bytes)).toEqual(spec);
    expect(checkExternalVerifierSpec(spec)).toEqual({ ok: true });
    expect(spec.semanticsVersion).toBe(EVAL_SEMANTICS_VERSION);
  });

  it("names as its grader the worked two-file package of the family text", async () => {
    const spec = await golden();
    const block = spec.familyBlock as { testMaterial: Array<{ name: string; digest: { sha256: string } }> };
    const grader = spec.grader as { digest: { sha256: string } };
    expect(grader.digest.sha256).toBe(
      harborPackageContentHash([
        { path: "task.toml", sha256: "a".repeat(64) },
        ...block.testMaterial.map((entry) => ({ path: entry.name, sha256: entry.digest.sha256 })),
      ]),
    );
  });

  it("refuses every adversarial external-verifier specification, and an unknown family", async () => {
    const names = (await readdir(new URL("adversarial/", fixturesRoot)))
      .filter((name) => name.startsWith("external-verifier-") || name === "unknown-family.json")
      .sort();
    expect(names).toEqual([
      "external-verifier-boolean-measurement.json",
      "external-verifier-grader-inlined-content.json",
      "external-verifier-grader-list.json",
      "external-verifier-grader-prefixed-digest.json",
      "external-verifier-grader-without-digest.json",
      "external-verifier-no-measurements.json",
      "external-verifier-wrong-block.json",
      "unknown-family.json",
    ]);
    for (const name of names) {
      const text = await fixture(`adversarial/${name}`);
      const spec = JSON.parse(text) as EvaluationSpec;
      expect(refusalCode(() => sealEvaluationSpec(spec)), name).toBe("invalid-document");
      expect(refusalCode(() => parseEvaluationSpec(new TextEncoder().encode(text))), name).toBe("invalid-document");
    }
  });

  it("each adversarial specification differs from the golden one in the fields its name says", async () => {
    const spec = await golden();
    const changed = async (name: string) => {
      const bad = JSON.parse(await fixture(`adversarial/${name}.json`)) as Record<string, unknown>;
      return Object.keys(spec).filter((key) => JSON.stringify(bad[key]) !== JSON.stringify(spec[key as keyof EvaluationSpec]));
    };
    expect(await changed("external-verifier-grader-without-digest")).toEqual(["grader"]);
    expect(await changed("external-verifier-grader-list")).toEqual(["grader"]);
    expect(await changed("external-verifier-grader-prefixed-digest")).toEqual(["grader"]);
    expect(await changed("external-verifier-grader-inlined-content")).toEqual(["grader"]);
    expect(await changed("external-verifier-no-measurements")).toEqual(["measurements", "verdictRule"]);
    expect(await changed("external-verifier-boolean-measurement")).toEqual(["measurements", "verdictRule"]);
    expect(await changed("external-verifier-wrong-block")).toEqual(["familyBlock"]);
    expect(await changed("unknown-family")).toEqual(["family"]);
  });

  it("states the reason for each spec-level refusal", async () => {
    const spec = await golden();
    const grader = spec.grader as Record<string, unknown>;
    const reasonFor = (bad: unknown) => {
      const result = checkExternalVerifierSpec(bad as EvaluationSpec);
      return result.ok ? "accepted" : result.reason;
    };
    expect(reasonFor({ ...spec, family: "deterministic-process" })).toMatch(/expected family "external-verifier"/);
    expect(reasonFor({ ...spec, familyBlock: {} })).toMatch(/block failed schema validation/);
    expect(reasonFor({ ...spec, grader: [grader] })).toMatch(/single/);
    expect(reasonFor({ ...spec, grader: { uri: "https://example.org/packages/sum-two-numbers" } })).toMatch(/digest\.sha256/);
    expect(reasonFor({ ...spec, grader: { digest: { sha256: `sha256:${"a".repeat(64)}` } } })).toMatch(/digest\.sha256/);
    expect(reasonFor({ ...spec, grader: { digest: { sha256: "A".repeat(64) } } })).toMatch(/digest\.sha256/);
    expect(reasonFor({ ...spec, grader: { ...grader, content: "ZWNobyAxCg==" } })).toMatch(/content/);
    expect(reasonFor({ ...spec, measurements: [] })).toMatch(/at least one measurement/);
    expect(reasonFor({ ...spec, measurements: [{ name: "reward", type: "string", required: true }] }))
      .toMatch(/type "number"/);
  });

  it("accepts a grader with no name and a public or private access class", async () => {
    const spec = await golden();
    const digest = (spec.grader as { digest: Record<string, string> }).digest;
    expect(checkExternalVerifierSpec({ ...spec, grader: { digest } })).toEqual({ ok: true });
    expect(checkExternalVerifierSpec({ ...spec, grader: { digest, accessClass: "private" } })).toEqual({ ok: true });
  });

  it("fixes no verdict rule: the guarded rule seals, and so does the plain one", async () => {
    const guarded = await guardedSpec();
    expect(checkExternalVerifierSpec(guarded)).toEqual({ ok: true });
    expect(parseEvaluationSpec(sealEvaluationSpec(guarded).bytes)).toEqual(guarded);
    expect(sealEvaluationSpec(guarded).digest).not.toBe(sealEvaluationSpec(await golden()).digest);
  });

  it("closes the verdict loop on the guarded rule: pass at 1, fail at 0, inconclusive otherwise", async () => {
    const spec = await guardedSpec();
    const inconclusive = { verdict: "inconclusive", inconclusiveClass: "non-binary-reward" };
    expect(evaluateVerdictRule(spec.verdictRule, { reward: 1 })).toEqual({ verdict: "pass" });
    expect(evaluateVerdictRule(spec.verdictRule, { reward: 0 })).toEqual({ verdict: "fail" });
    expect(evaluateVerdictRule(spec.verdictRule, { reward: "1.0" })).toEqual({ verdict: "pass" });
    expect(evaluateVerdictRule(spec.verdictRule, { reward: 2 })).toEqual(inconclusive);
    expect(evaluateVerdictRule(spec.verdictRule, { reward: -1 })).toEqual(inconclusive);
    expect(evaluateVerdictRule(spec.verdictRule, { reward: "0.5" })).toEqual(inconclusive);
    expect(refusalCode(() => evaluateVerdictRule(spec.verdictRule, {}))).toBe("invalid-document");
  });

  it("reads a harbor reward map into the measurements the sealed rule judges", async () => {
    const spec = await guardedSpec();
    const outcome = (rewards: unknown) => {
      const measurements = readExternalVerifierMeasurements({
        harness: "harbor",
        measurements: spec.measurements,
        rewards,
      });
      const coverage = checkMeasurementCoverage(spec, measurements);
      return coverage.ok ? evaluateVerdictRule(spec.verdictRule, measurements) : coverage;
    };
    expect(outcome({ reward: 1.0 })).toEqual({ verdict: "pass" });
    expect(outcome({ reward: 0.0 })).toEqual({ verdict: "fail" });
    expect(outcome({ reward: 0.5 })).toEqual({ verdict: "inconclusive", inconclusiveClass: "non-binary-reward" });
    expect(outcome({ reward: 2 })).toEqual({ verdict: "inconclusive", inconclusiveClass: "non-binary-reward" });
    // No reward key: nothing is defaulted, so the required measurement is reported missing.
    expect(outcome({})).toEqual({ ok: false, missing: ["reward"] });
  });

  it("holds a delivered verdict to the sealed rule", async () => {
    const spec = await guardedSpec();
    expect(checkVerdictConsistency({ spec, delivered: { verdict: "pass" }, measurements: { reward: 1 } }))
      .toEqual({ ok: true });
    expect(checkVerdictConsistency({ spec, delivered: { verdict: "fail" }, measurements: { reward: 0 } }))
      .toEqual({ ok: true });
    expect(checkVerdictConsistency({ spec, delivered: { verdict: "inconclusive" }, measurements: { reward: 2 } }))
      .toEqual({ ok: true });
    expect(checkVerdictConsistency({ spec, delivered: { verdict: "fail" }, measurements: { reward: 2 } }))
      .toMatchObject({ ok: false, code: "invalid-document" });
    expect(checkVerdictConsistency({ spec, delivered: { verdict: "pass" }, measurements: { reward: "0.5" } }))
      .toMatchObject({ ok: false, code: "invalid-document" });
  });

  it("leaves the earlier golden specifications sealing to the digests they had", async () => {
    for (const name of ["deterministic-minimal", "fractional-threshold", "state-predicate-minimal"]) {
      const spec = JSON.parse(await fixture(`golden/${name}.json`)) as EvaluationSpec;
      const pinned = (await fixture(`golden/${name}.sha256`)).trim();
      expect(sealEvaluationSpec(spec).digest, name).toBe(pinned);
    }
  });
});
