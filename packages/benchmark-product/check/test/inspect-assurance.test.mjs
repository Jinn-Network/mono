import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveInspectEvaluationStrategy,
  inspectLogVerifierMethod,
} from "../dist/profile/inspect-assurance.js";

const selection = {
  runtime: {
    adapterVersion: "1.2.3",
    workerSha256: "a".repeat(64),
    inspectVersion: "0.3.0",
  },
};

test("reader embeds only the exact disclosed singleton assurance", () => {
  assert.equal(deriveInspectEvaluationStrategy(undefined), "embedded");
  assert.equal(deriveInspectEvaluationStrategy({
    independence: "disclosed",
    minVerdicts: 1,
    distinctEvaluator: false,
    verdictRule: "sole",
  }), "embedded");
  for (const assurance of [
    { independence: "gating" },
    { minVerdicts: 2 },
    { distinctEvaluator: true },
    { verdictRule: "majority" },
  ]) {
    assert.equal(deriveInspectEvaluationStrategy(assurance), "separate-log-verification");
  }
});

test("reader derives a deterministic selection-bound Inspect verifier method", () => {
  const first = inspectLogVerifierMethod(selection, "b".repeat(64));
  const second = inspectLogVerifierMethod(selection, "b".repeat(64));
  assert.deepEqual(first, second);
  assert.equal(first.name, "benchmark-product-inspect-log-verifier");
  assert.match(first.digest.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    first.digest.sha256,
    inspectLogVerifierMethod(selection, "c".repeat(64)).digest.sha256,
  );
});
