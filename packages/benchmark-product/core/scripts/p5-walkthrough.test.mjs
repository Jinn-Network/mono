import assert from "node:assert/strict";
import test from "node:test";
import { runCanonicalP5GreenBaseline } from "./p5-walkthrough.mjs";

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
