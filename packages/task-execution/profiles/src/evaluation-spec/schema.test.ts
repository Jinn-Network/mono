import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../errors.js";
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
});
