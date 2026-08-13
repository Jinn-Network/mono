import { describe, expect, test } from "vitest";
import { checkedRequirementsDigest, verifyRunPinning } from "./pinning.js";

const deployment = {
  executable: { path: "/opt/jinn/bin/claude", digest: "a".repeat(64) },
  async probe() {
    return {
      ready: true,
      executable: { path: "/opt/jinn/bin/claude", digest: "a".repeat(64) },
      harnessVersions: ["1.2.3"],
      models: ["opus"],
      loadouts: [{ kind: "jinn.skill.v1" as const, name: "review-skill", digest: "b".repeat(64) }],
    };
  },
};

describe("verifyRunPinning", () => {
  test("requires the exact executable and every requested pin", async () => {
    const requirements = {
      harness: { id: "claude-code", version: "1.2.3", digest: "a".repeat(64) },
      model: { id: "opus" },
      loadout: { kind: "jinn.skill.v1", name: "review-skill", digest: { sha256: "b".repeat(64) } },
    };
    await expect(verifyRunPinning(deployment, requirements)).resolves.toEqual({
      ready: true,
      checkedRequirementsDigest: checkedRequirementsDigest(requirements),
    });
  });

  test("accepts a jinn.harness-state.v1 pin against a matching sha256:-prefixed readiness entry (F9)", async () => {
    const harnessStateDeployment = {
      ...deployment,
      async probe() {
        return {
          ...(await deployment.probe()),
          loadouts: [
            { kind: "jinn.harness-state.v1" as const, name: "learner-state", digest: `sha256:${"c".repeat(64)}` },
          ],
        };
      },
    };
    const requirements = {
      harness: { id: "claude-code", version: "1.2.3", digest: "a".repeat(64) },
      model: { id: "opus" },
      loadout: { kind: "jinn.harness-state.v1", name: "learner-state", digest: `sha256:${"c".repeat(64)}` },
    };
    await expect(verifyRunPinning(harnessStateDeployment, requirements)).resolves.toEqual({
      ready: true,
      checkedRequirementsDigest: checkedRequirementsDigest(requirements),
    });
  });

  test("refuses a jinn.harness-state.v1 pin the readiness probe does not carry", async () => {
    await expect(verifyRunPinning(deployment, {
      harness: { id: "claude-code", version: "1.2.3", digest: "a".repeat(64) },
      model: { id: "opus" },
      loadout: { kind: "jinn.harness-state.v1", name: "learner-state", digest: `sha256:${"c".repeat(64)}` },
    })).resolves.toMatchObject({ ready: false, detail: "loadout digest mismatch" });
  });

  test("refuses an executable swap, model mismatch, and digest/path-mismatched loadout", async () => {
    await expect(verifyRunPinning({
      ...deployment,
      async probe() { return { ...(await deployment.probe()), executable: { path: "/tmp/claude", digest: "a".repeat(64) } }; },
    }, {})).resolves.toMatchObject({ ready: false, detail: "executable identity mismatch" });
    await expect(verifyRunPinning(deployment, { model: { id: "other" } }))
      .resolves.toMatchObject({ ready: false, detail: "model pin mismatch" });
    await expect(verifyRunPinning(deployment, {
      loadout: { kind: "jinn.skill.v1", name: "../escape", digest: { sha256: "b".repeat(64) } },
    })).resolves.toMatchObject({ ready: false, detail: "loadout path is not contained" });
  });
});
