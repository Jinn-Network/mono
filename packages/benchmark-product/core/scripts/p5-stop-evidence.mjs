import { spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const P5_PRESTAGE_STOP_SCHEMA = "demo1.p5-green-baseline-stop/2";

const TIMEOUT_CLASSIFICATIONS = new Set([
  "child-timeout-kill-observed",
  "child-exit-before-timeout",
  "child-process-error",
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
  if (!Number.isInteger(record.childTimeoutSeconds)
    || record.childTimeoutSeconds < 1
    || record.childTimeoutSeconds > record.configuredTimeoutSeconds) {
    throw new TypeError("childTimeoutSeconds must be a positive bound within configuredTimeoutSeconds");
  }
  if (typeof record.timedOut !== "boolean") {
    throw new TypeError("timedOut must be a directly captured boolean");
  }
  if (!TIMEOUT_CLASSIFICATIONS.has(record.timeoutClassification)) {
    throw new TypeError("timeoutClassification is not a direct child outcome");
  }
  if (record.timedOut && record.timeoutClassification !== "child-timeout-kill-observed") {
    throw new TypeError("a timed-out child requires child-timeout-kill-observed");
  }
  if (!record.timedOut && record.timeoutClassification === "child-timeout-kill-observed") {
    throw new TypeError("a non-timeout child cannot claim child-timeout-kill-observed");
  }
  if (record.timeoutClassification === "child-process-error") {
    if (record.processError?.name === undefined || "exitCode" in record) {
      throw new TypeError("child-process-error requires typed processError and no exitCode");
    }
  } else if (record.processError !== undefined || !("exitCode" in record)) {
    throw new TypeError("child exit classifications require exitCode and no processError");
  }
  if (record.timedOut
    && record.monotonicElapsedMs < record.childTimeoutSeconds * 1_000) {
    throw new TypeError("a timed-out stop cannot complete before its child bound");
  }
  return record;
}

/**
 * Wrap the grader's injected process seam so every image-prestage child stop records the exact
 * SIGKILL timeout action, process-error-vs-exit outcome, and monotonic elapsed time. Wall-clock
 * timestamps are descriptive only; duration and classification come from direct child events.
 */
export function createP5ObservedDockerSpawner({
  dockerPath,
  spawn = nodeSpawn,
  wallNow = () => new Date(),
  monotonicNow = () => performance.now(),
} = {}) {
  let childObservation;

  function observedSpawn(command, args) {
    const observation = {
      operation: args[0] === "pull" ? "pull" : args.slice(0, 2).join(" "),
      startedAt: wallNow().toISOString(),
      startedMonotonicMs: monotonicNow(),
      timeoutKillObserved: false,
    };
    childObservation = observation;
    let child;
    try {
      child = spawn(dockerPath ?? command, [...args], {
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
    } catch (error) {
      finishChild({ kind: "process-error", error });
      throw error;
    }

    function finishChild(outcome) {
      if (observation.completedAt !== undefined) return;
      observation.completedAt = wallNow().toISOString();
      observation.monotonicElapsedMs = Math.max(
        0,
        monotonicNow() - observation.startedMonotonicMs,
      );
      observation.outcome = outcome;
    }

    const wrapped = {
      get pid() {
        return child.pid;
      },
      on(event, listener) {
        if (event === "exit") {
          child.on("exit", (code) => {
            finishChild({ kind: "exit", exitCode: code });
            listener(code);
          });
        } else {
          child.on("error", (error) => {
            finishChild({ kind: "process-error", error });
            listener(error);
          });
        }
        return wrapped;
      },
      kill(signal) {
        if (signal === "SIGKILL") {
          observation.timeoutKillObserved = true;
        }
        return child.kill(signal);
      },
    };
    return wrapped;
  }

  function completedPrestageEvidence(configuredTimeoutSeconds) {
    if (childObservation?.completedAt === undefined
      || childObservation.monotonicElapsedMs === undefined
      || childObservation.outcome === undefined) {
      return undefined;
    }
    const timedOut = childObservation.timeoutKillObserved;
    const processErrored = !timedOut && childObservation.outcome.kind === "process-error";
    const evidence = {
      schema: P5_PRESTAGE_STOP_SCHEMA,
      startedAt: childObservation.startedAt,
      completedAt: childObservation.completedAt,
      monotonicElapsedMs: childObservation.monotonicElapsedMs,
      configuredTimeoutSeconds,
      childTimeoutSeconds: childObservation.operation === "pull"
        ? configuredTimeoutSeconds
        : Math.min(30, configuredTimeoutSeconds),
      operation: childObservation.operation,
      timedOut,
      timeoutClassification: timedOut
        ? "child-timeout-kill-observed"
        : (processErrored ? "child-process-error" : "child-exit-before-timeout"),
      ...(processErrored
        ? {
            processError: {
              name: childObservation.outcome.error instanceof Error
                ? childObservation.outcome.error.name
                : "UnknownProcessError",
              ...(typeof childObservation.outcome.error?.code === "string"
                ? { code: childObservation.outcome.error.code }
                : {}),
            },
          }
        : { exitCode: childObservation.outcome.exitCode }),
    };
    return assertP5PrestageStopEvidence(evidence);
  }

  return { spawn: observedSpawn, completedPrestageEvidence };
}
