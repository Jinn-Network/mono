import { describe, expect, test } from "vitest";
import { verifyRunPinning } from "./pinning.js";

const deployment = {
  executable: { path: "/opt/jinn/bin/claude", digest: "a".repeat(64) },
  async probe() {
    return {
      ready: true,
      executable: { path: "/opt/jinn/bin/claude", digest: "a".repeat(64) },
      harnessVersions: ["1.2.3"],
      models: ["opus"],
      loadouts: [{ path: "/attempt/input/review-skill", digest: "b".repeat(64) }],
    };
  },
};

describe("verifyRunPinning", () => {
  test("requires the exact executable and every requested pin", async () => {
    await expect(verifyRunPinning(deployment, {
      harness: { id: "claude-code", version: "1.2.3", digest: "a".repeat(64) },
      model: { id: "opus" },
      loadout: { kind: "jinn.skill.v1", name: "review-skill", digest: { sha256: "b".repeat(64) } },
    }, "/attempt/input")).resolves.toEqual({ ready: true });
  });

  test("refuses an executable swap, model mismatch, and digest/path-mismatched loadout", async () => {
    await expect(verifyRunPinning({
      ...deployment,
      async probe() { return { ...(await deployment.probe()), executable: { path: "/tmp/claude", digest: "a".repeat(64) } }; },
    }, {}, "/attempt/input")).resolves.toMatchObject({ ready: false, detail: "executable identity mismatch" });
    await expect(verifyRunPinning(deployment, { model: { id: "other" } }, "/attempt/input"))
      .resolves.toMatchObject({ ready: false, detail: "model pin mismatch" });
    await expect(verifyRunPinning(deployment, {
      loadout: { kind: "jinn.skill.v1", name: "../escape", digest: { sha256: "b".repeat(64) } },
    }, "/attempt/input")).resolves.toMatchObject({ ready: false, detail: "loadout path is not contained" });
  });
});
