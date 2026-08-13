import assert from "node:assert/strict";
import test from "node:test";
import { p5ArmPinning, runCanonicalP5GreenBaseline } from "./p5-walkthrough.mjs";

test("canonical walkthrough always wires v2 pre-stage stop capture with attempt identity", async () => {
  let received;
  const expected = { transcript: { passed: false } };
  const result = await runCanonicalP5GreenBaseline({
    runRoot: "/immutable/p5-output",
    dockerPath: "/gated/docker",
    runGreenBaseline: async (options) => {
      received = options;
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(received, {
    dockerPath: "/gated/docker",
    output: "/immutable/p5-output/green-baseline.json",
    stopOutput: "/immutable/p5-output/green-baseline-prestage-stop.json",
    attempt: 1,
  });
});

test("arm pinning omits the submission-baseline isolation key and preserves every arm-owned pin", () => {
  const loadout = { kind: "jinn.skill.v1", name: "SKILL.md", digest: { sha256: "a".repeat(64) } };
  assert.deepEqual(p5ArmPinning({
    harness: { id: "claude-code", version: "2.1.222" },
    model: { id: "claude-haiku-4-5-20251001" },
    effort: "high",
    isolationPolicy: "unrestricted",
    loadout,
  }), {
    harness: { id: "claude-code", version: "2.1.222" },
    model: { id: "claude-haiku-4-5-20251001" },
    effort: "high",
    loadout,
  });
});

test("arm pinning refuses an unexpected effective isolation policy", () => {
  assert.throws(
    () => p5ArmPinning({ harness: "claude-code", isolationPolicy: "oci-container" }),
    /expected unrestricted isolation policy/u,
  );
});
