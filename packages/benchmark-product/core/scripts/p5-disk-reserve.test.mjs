import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocateP5ReserveFile,
  createP5DiskReserve,
  inspectP5DiskReserve,
  P5_RECOVERY_LOG,
  P5_RESERVE_BYTES,
  P5_RESERVE_STATE,
  recoverP5DiskCapacity,
  releaseP5DiskReserve,
} from "./p5-disk-reserve.mjs";

const GIB = 1024n * 1024n * 1024n;
const sparseAllocate = (path, bytes) => {
  writeFileSync(path, new Uint8Array(), { flag: "wx" });
  truncateSync(path, Number(bytes));
};

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "p5-reserve-test-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("P5 establishes a run-owned 16 GiB reserve only at the 60 GiB start gate", () => withRoot((root) => {
  const readings = [60n * GIB, 44n * GIB];
  const result = createP5DiskReserve(root, {
    available: () => readings.shift(),
    allocate: sparseAllocate,
  });
  assert.equal(result.reserveBytes, Number(P5_RESERVE_BYTES));
  assert.equal(result.before.availableGiB, "60.00");
  assert.equal(result.after.availableGiB, "44.00");
  assert.equal(inspectP5DiskReserve(root).currentBytes, Number(P5_RESERVE_BYTES));
  assert.equal(JSON.parse(readFileSync(join(root, P5_RESERVE_STATE), "utf8")).reserveFile, "p5-disk-reserve.bin");
}));

test("macOS reserve allocation resolves mkfile through PATH instead of an obsolete absolute path", () => {
  let invocation;
  allocateP5ReserveFile("/run-owned/p5-disk-reserve.bin", 16n * GIB, {
    platform: "darwin",
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: Buffer.from("") };
    },
  });
  assert.deepEqual(invocation, {
    command: "mkfile",
    args: ["16g", "/run-owned/p5-disk-reserve.bin"],
    options: { stdio: "pipe" },
  });
});

test("P5 refuses to begin below 60 GiB and never invokes allocation", () => withRoot((root) => {
  let allocated = false;
  assert.throws(() => createP5DiskReserve(root, {
    available: () => 60n * GIB - 1n,
    allocate: () => { allocated = true; },
  }), /60\.00 GiB is required.*No caches or user data were deleted/u);
  assert.equal(allocated, false);
}));

test("P5 releases only enough reserve to restore 44 GiB and logs exact scope", () => withRoot((root) => {
  const initial = [60n * GIB, 44n * GIB];
  createP5DiskReserve(root, {
    available: () => initial.shift(),
    allocate: sparseAllocate,
  });
  const readings = [41n * GIB, 44n * GIB];
  const event = recoverP5DiskCapacity(root, "before grader", {
    availableBytes: () => readings.shift(),
  });
  assert.equal(event.releasedBytes, String(3n * GIB));
  assert.equal(event.reserveRemainingBytes, String(13n * GIB));
  assert.equal(event.cleanupScope, "run-owned-reserve-only");
  assert.equal(event.safeTargetRestored, true);
  assert.equal(inspectP5DiskReserve(root).currentBytes, Number(13n * GIB));
  const log = readFileSync(join(root, P5_RECOVERY_LOG), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(log, [event]);
}));

test("P5 resumes an announced reserve resize after interruption following truncate", () => withRoot((root) => {
  const initial = [60n * GIB, 44n * GIB];
  createP5DiskReserve(root, {
    available: () => initial.shift(),
    allocate: sparseAllocate,
  });
  assert.throws(() => recoverP5DiskCapacity(root, "before interrupted grader", {
    availableBytes: () => 41n * GIB,
    resize(path, bytes) {
      truncateSync(path, bytes);
      throw new Error("simulated process stop after truncate");
    },
  }), /simulated process stop after truncate/u);

  // Inspection authenticates the announced transition instead of treating the smaller reserve
  // as foreign mutation. The next recovery call durably closes the original event exactly once.
  assert.equal(inspectP5DiskReserve(root).currentBytes, Number(13n * GIB));
  recoverP5DiskCapacity(root, "resume preflight", { availableBytes: () => 44n * GIB });
  const events = readFileSync(join(root, P5_RECOVERY_LOG), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events[0].label, "before interrupted grader");
  assert.equal(events[0].releasedBytes, String(3n * GIB));
  assert.equal(events[0].reserveRemainingBytes, String(13n * GIB));
  assert.equal(events.filter((event) => event.operationId === events[0].operationId).length, 1);
}));

test("P5 state replacement ignores a stale temporary file from an earlier interruption", () => withRoot((root) => {
  const initial = [60n * GIB, 44n * GIB];
  createP5DiskReserve(root, {
    available: () => initial.shift(),
    allocate: sparseAllocate,
  });
  writeFileSync(join(root, `${P5_RESERVE_STATE}.tmp`), "stale partial state\n", { flag: "wx" });
  const readings = [41n * GIB, 44n * GIB];
  assert.doesNotThrow(() => recoverP5DiskCapacity(root, "after stale temp", {
    availableBytes: () => readings.shift(),
  }));
  assert.equal(inspectP5DiskReserve(root).currentBytes, Number(13n * GIB));
}));

test("P5 returns the unused reserve after cold verification", () => withRoot((root) => {
  const initial = [60n * GIB, 44n * GIB];
  createP5DiskReserve(root, {
    available: () => initial.shift(),
    allocate: sparseAllocate,
  });
  const released = releaseP5DiskReserve(root);
  assert.equal(released.releasedBytes, String(P5_RESERVE_BYTES));
  assert.equal(inspectP5DiskReserve(root).currentBytes, 0);
  assert.deepEqual(releaseP5DiskReserve(root), released);
  assert.equal(readFileSync(join(root, P5_RECOVERY_LOG), "utf8").trim().split("\n").length, 1);
}));

test("P5 resumes final reserve release after interruption following truncate", () => withRoot((root) => {
  const initial = [60n * GIB, 44n * GIB];
  createP5DiskReserve(root, {
    available: () => initial.shift(),
    allocate: sparseAllocate,
  });
  assert.throws(() => releaseP5DiskReserve(root, "cold bundle verified", {
    availableBytes: () => 44n * GIB,
    resize(path, bytes) {
      truncateSync(path, bytes);
      throw new Error("simulated stop during final release");
    },
  }), /simulated stop during final release/u);
  assert.equal(inspectP5DiskReserve(root).currentBytes, 0);
  const recovered = releaseP5DiskReserve(root, "cold bundle verified", {
    availableBytes: () => 60n * GIB,
  });
  assert.equal(recovered.releasedBytes, String(P5_RESERVE_BYTES));
  assert.equal(recovered.reserveRemainingBytes, "0");
  const events = readFileSync(join(root, P5_RECOVERY_LOG), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].operationId, recovered.operationId);
}));
