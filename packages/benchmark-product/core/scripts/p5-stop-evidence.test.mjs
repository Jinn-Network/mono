import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertP5PrestageStopEvidence,
  createP5ObservedDockerSpawner,
  P5_PRESTAGE_STOP_SCHEMA,
} from "./p5-stop-evidence.mjs";

const artifactRoot = new URL(
  "../../../../docs/superpowers/plans/demo-report-1/p5-artifacts/",
  import.meta.url,
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeChild() {
  const events = new EventEmitter();
  return {
    pid: 42,
    on: events.on.bind(events),
    kill(signal) {
      assert.equal(signal, "SIGKILL");
      events.emit("exit", null);
      return true;
    },
    exit(code) {
      events.emit("exit", code);
    },
  };
}

test("future pre-stage stops directly capture timeout kill and monotonic elapsed", async () => {
  const child = fakeChild();
  const wallTimes = [
    new Date("2026-08-13T03:00:00.000Z"),
    new Date("2026-08-13T03:30:00.005Z"),
  ];
  const monotonicTimes = [100, 1_800_105];
  const observer = createP5ObservedDockerSpawner({
    dockerPath: "/host/docker",
    spawn(command, args, options) {
      assert.equal(command, "/host/docker");
      assert.deepEqual(args, ["pull", "--platform", "linux/amd64", "repo@sha256:digest"]);
      assert.equal(options.stdio, "ignore");
      return child;
    },
    wallNow: () => wallTimes.shift(),
    monotonicNow: () => monotonicTimes.shift(),
  });
  const process = observer.spawn("docker", [
    "pull", "--platform", "linux/amd64", "repo@sha256:digest",
  ]);
  const exited = new Promise((resolve) => process.on("exit", resolve));
  process.kill("SIGKILL");
  await exited;

  assert.deepEqual(observer.completedPullEvidence(1_800), {
    schema: P5_PRESTAGE_STOP_SCHEMA,
    startedAt: "2026-08-13T03:00:00.000Z",
    completedAt: "2026-08-13T03:30:00.005Z",
    monotonicElapsedMs: 1_800_005,
    configuredTimeoutSeconds: 1_800,
    timedOut: true,
    timeoutClassification: "child-timeout-kill-observed",
    exitCode: null,
  });
});

test("future pre-stage stops distinguish a nonzero child exit before timeout", async () => {
  const child = fakeChild();
  const wallTimes = [
    new Date("2026-08-13T03:00:00.000Z"),
    new Date("2026-08-13T03:00:04.000Z"),
  ];
  const monotonicTimes = [10, 4_010];
  const observer = createP5ObservedDockerSpawner({
    spawn: () => child,
    wallNow: () => wallTimes.shift(),
    monotonicNow: () => monotonicTimes.shift(),
  });
  const process = observer.spawn("docker", ["pull", "--platform", "linux/amd64", "image"]);
  const exited = new Promise((resolve) => process.on("exit", resolve));
  child.exit(1);
  await exited;

  assert.deepEqual(observer.completedPullEvidence(1_800), {
    schema: P5_PRESTAGE_STOP_SCHEMA,
    startedAt: "2026-08-13T03:00:00.000Z",
    completedAt: "2026-08-13T03:00:04.000Z",
    monotonicElapsedMs: 4_000,
    configuredTimeoutSeconds: 1_800,
    timedOut: false,
    timeoutClassification: "child-exit-before-timeout",
    exitCode: 1,
  });
});

test("future stop schema rejects missing or inferred timeout evidence", () => {
  const valid = {
    schema: P5_PRESTAGE_STOP_SCHEMA,
    startedAt: "2026-08-13T03:00:00.000Z",
    completedAt: "2026-08-13T03:30:00.000Z",
    monotonicElapsedMs: 1_800_000,
    configuredTimeoutSeconds: 1_800,
    timedOut: true,
    timeoutClassification: "child-timeout-kill-observed",
  };
  assert.equal(assertP5PrestageStopEvidence(valid), valid);
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, startedAt: undefined }),
    /startedAt/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, completedAt: undefined }),
    /completedAt/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, monotonicElapsedMs: undefined }),
    /monotonicElapsedMs/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, timedOut: undefined }),
    /timedOut/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, timedOut: false }),
    /disagree/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, monotonicElapsedMs: 1_799_999 }),
    /configured bound/u,
  );
  assert.throws(
    () => assertP5PrestageStopEvidence({ ...valid, configuredTimeoutSeconds: 1_799 }),
    /sealed P5 bound/u,
  );
});

test("historical stops preserve machine facts while qualifying timeout as operator-attested", () => {
  for (const attempt of [1, 2]) {
    const stopBytes = readFileSync(new URL(`green-baseline-attempt-${attempt}-stop.json`, artifactRoot));
    const stop = JSON.parse(stopBytes);
    const excerptBytes = readFileSync(new URL(stop.sessionExcerpt.path, artifactRoot));
    const excerpt = JSON.parse(excerptBytes);

    assert.equal(stop.attempt, attempt);
    assert.equal(stop.timeoutSeconds, 1_800);
    assert.equal(stop.timeoutClaim.classification, "operator-attested-configured-bound-expiry");
    assert.equal(stop.timeoutClaim.machineTimedOut, null);
    assert.equal(Object.hasOwn(stop, "timedOut"), false);
    assert.equal(stop.result.canonicalCode, "UNAVAILABLE");
    assert.equal(stop.exactDigestPresentAfterAttempt, false);
    assert.equal(stop.goldOrEmptyGradeStarted, false);
    assert.equal(stop.claudeCellStarted, false);
    assert.equal(stop.fallbackAttempted, false);
    assert.equal(sha256(excerptBytes), stop.sessionExcerpt.sha256);
    assert.equal(excerpt.attempt, attempt);
    assert.match(excerpt.limitation, /does not expose boundedExit\.timedOut/u);
    assert.equal(
      excerpt.events.find((event) => event.kind === "terminal-result-observed")?.canonicalCode,
      "UNAVAILABLE",
    );
    assert.equal(
      excerpt.events.find((event) => event.kind === "post-attempt-image-inspect")?.exactDigestPresent,
      false,
    );
  }
});
