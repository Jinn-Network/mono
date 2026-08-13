import { spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const P5_PRESTAGE_STOP_SCHEMA = "demo1.p5-green-baseline-stop/2";

const TIMEOUT_CLASSIFICATIONS = new Set([
  "child-timeout-kill-observed",
  "child-exit-before-timeout",
]);

function exactIsoTimestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

/**
 * Validate the machine-captured timing contract for every future P5 image-prestage stop.
 * This is a local operational artifact schema, not a new evidence record kind.
 */
export function assertP5PrestageStopEvidence(record) {
  if (record?.schema !== P5_PRESTAGE_STOP_SCHEMA) {
    throw new TypeError(`schema must be ${P5_PRESTAGE_STOP_SCHEMA}`);
  }
  const startedAt = exactIsoTimestamp(record.startedAt, "startedAt");
  const completedAt = exactIsoTimestamp(record.completedAt, "completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new TypeError("completedAt must not precede startedAt");
  }
  if (!Number.isFinite(record.monotonicElapsedMs) || record.monotonicElapsedMs < 0) {
    throw new TypeError("monotonicElapsedMs must be a non-negative finite number");
  }
  if (record.configuredTimeoutSeconds !== 1_800) {
    throw new TypeError("configuredTimeoutSeconds must equal the sealed P5 bound of 1800");
  }
  if (typeof record.timedOut !== "boolean") {
    throw new TypeError("timedOut must be a directly captured boolean");
  }
  if (!TIMEOUT_CLASSIFICATIONS.has(record.timeoutClassification)) {
    throw new TypeError("timeoutClassification is not a direct child outcome");
  }
  const expectedClassification = record.timedOut
    ? "child-timeout-kill-observed"
    : "child-exit-before-timeout";
  if (record.timeoutClassification !== expectedClassification) {
    throw new TypeError("timedOut and timeoutClassification disagree");
  }
  if (record.timedOut
    && record.monotonicElapsedMs < record.configuredTimeoutSeconds * 1_000) {
    throw new TypeError("a timed-out stop cannot complete before its configured bound");
  }
  return record;
}

/**
 * Wrap the grader's injected process seam so a pull stop records the exact SIGKILL timeout
 * action and monotonic elapsed time. Wall-clock timestamps are descriptive only; duration and
 * timeout classification come from the monotonic clock and the observed child control action.
 */
export function createP5ObservedDockerSpawner({
  dockerPath,
  spawn = nodeSpawn,
  wallNow = () => new Date(),
  monotonicNow = () => performance.now(),
} = {}) {
  let pullObservation;

  function observedSpawn(command, args) {
    const child = spawn(dockerPath ?? command, [...args], {
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const observesPull = args[0] === "pull";
    if (observesPull) {
      pullObservation = {
        startedAt: wallNow().toISOString(),
        startedMonotonicMs: monotonicNow(),
        timeoutKillObserved: false,
      };
    }

    const finishPull = (exitCode) => {
      if (!observesPull || pullObservation?.completedAt !== undefined) return;
      pullObservation.completedAt = wallNow().toISOString();
      pullObservation.monotonicElapsedMs = Math.max(
        0,
        monotonicNow() - pullObservation.startedMonotonicMs,
      );
      pullObservation.exitCode = exitCode;
    };

    const wrapped = {
      get pid() {
        return child.pid;
      },
      on(event, listener) {
        if (event === "exit") {
          child.on("exit", (code) => {
            finishPull(code);
            listener(code);
          });
        } else {
          child.on("error", (error) => {
            finishPull(null);
            listener(error);
          });
        }
        return wrapped;
      },
      kill(signal) {
        if (observesPull && signal === "SIGKILL" && pullObservation !== undefined) {
          pullObservation.timeoutKillObserved = true;
        }
        return child.kill(signal);
      },
    };
    return wrapped;
  }

  function completedPullEvidence(configuredTimeoutSeconds) {
    if (pullObservation?.completedAt === undefined
      || pullObservation.monotonicElapsedMs === undefined) {
      return undefined;
    }
    const evidence = {
      schema: P5_PRESTAGE_STOP_SCHEMA,
      startedAt: pullObservation.startedAt,
      completedAt: pullObservation.completedAt,
      monotonicElapsedMs: pullObservation.monotonicElapsedMs,
      configuredTimeoutSeconds,
      timedOut: pullObservation.timeoutKillObserved,
      timeoutClassification: pullObservation.timeoutKillObserved
        ? "child-timeout-kill-observed"
        : "child-exit-before-timeout",
      exitCode: pullObservation.exitCode,
    };
    return assertP5PrestageStopEvidence(evidence);
  }

  return { spawn: observedSpawn, completedPullEvidence };
}
