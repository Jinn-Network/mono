import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateP5DiskGate,
  P5_MINIMUM_FREE_BYTES,
} from "./p5-disk-gate.mjs";

test("P5 disk gate accepts the exact 40 GiB boundary", () => {
  assert.deepEqual(evaluateP5DiskGate(P5_MINIMUM_FREE_BYTES, "boundary"), {
    availableBytes: P5_MINIMUM_FREE_BYTES.toString(),
    availableGiB: "40.00",
    minimumGiB: "40.00",
  });
});

test("P5 disk gate refuses one byte below the boundary without proposing cleanup", () => {
  assert.throws(
    () => evaluateP5DiskGate(P5_MINIMUM_FREE_BYTES - 1n, "container grading"),
    /refused container grading: 40\.00 GiB free; at least 40\.00 GiB is required\. No caches or user data were deleted\./u,
  );
});

test("P5 disk gate rejects invalid byte counts", () => {
  assert.throws(() => evaluateP5DiskGate(-1n, "invalid"), TypeError);
  assert.throws(() => evaluateP5DiskGate(40, "invalid"), TypeError);
});
