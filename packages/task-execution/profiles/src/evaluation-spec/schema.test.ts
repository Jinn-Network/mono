import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../errors.js";
import { evaluateVerdictRule } from "./verdict-rule.js";
import { parseEvaluationSpec, sealEvaluationSpec } from "./seal.js";

const fixture = (relativePath: string) =>
  readFile(new URL(`../../fixtures/evaluation-spec/${relativePath}`, import.meta.url), "utf8");

describe("EvaluationSpec schema + sealing", () => {
  it("round-trips and matches the pinned golden digest", async () => {
    const golden = JSON.parse(await fixture("golden/deterministic-minimal.json"));
    const pinned = (await fixture("golden/deterministic-minimal.sha256")).trim();
    const sealed = sealEvaluationSpec(golden);
    expect(sealed.digest).toBe(pinned);
    expect(parseEvaluationSpec(sealed.bytes)).toEqual(golden);
  });

  it("rejects a spec with the wrong protocol URI", async () => {
    const bad = JSON.parse(await fixture("adversarial/wrong-protocol.json"));
    expect.assertions(2);
    try {
      sealEvaluationSpec(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfilesError);
      expect((error as ProfilesError).code).toBe("invalid-document");
    }
  });

  // MAJOR finding regression (b): a fractional threshold, authored per the §7.14 fractional-
  // as-strings doctrine as a decimal-string `value`, seals to its pinned digest, round-trips
  // parse, AND — end to end — its verdictRule now evaluates correctly against a delivered
  // fractional measurement (the exact scenario the finding reported as silently wrong: a
  // numeric measurement compared against a decimal-string threshold).
  it("a sealed fractional decimal-string threshold seals and evaluates correctly end-to-end", async () => {
    const golden = JSON.parse(await fixture("golden/fractional-threshold.json"));
    const pinned = (await fixture("golden/fractional-threshold.sha256")).trim();
    const sealed = sealEvaluationSpec(golden);
    expect(sealed.digest).toBe(pinned);
    const parsed = parseEvaluationSpec(sealed.bytes);
    expect(parsed).toEqual(golden);
    expect(evaluateVerdictRule(parsed.verdictRule, { score: 0.83 })).toEqual({ verdict: "pass" });
    expect(evaluateVerdictRule(parsed.verdictRule, { score: 0.4 })).toEqual({ verdict: "fail" });
  });
});
