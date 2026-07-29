// SPDX-License-Identifier: Apache-2.0
//
// The attempt shim (design §6.1, frozen interface §14 item 2) — the one new process the design
// introduces. THIS FILE IS DELIBERATELY SELF-CONTAINED: no relative imports, `node:` builtins
// only. It is spawned directly (compiled to `dist/shim-script.js` in production; run in place
// under Node's native TypeScript support in dev/test — see `resolveShimScriptEntry` in
// `shim.ts`), so it must resolve and run with zero dependency on the rest of this package or any
// workspace/bundler wiring — the containerd-shim pattern for plain processes.
//
// Invocation: `node shim-script.js <specPath>`, with `JINN_ATTEMPT_ID`, `JINN_ATTEMPT_NONCE`,
// `JINN_ATTEMPT_META_DIR`, and `JINN_ATTEMPT_SECRETS_DIR` already present in this process's OWN
// environment (set by the supervisor at spawn, inherited across fork — present from the instant
// this process exists, closing the invisible-orphan gap between fork and exec, §6.1). `specPath`
// names a JSON file (written by the supervisor into `metaDir` before spawning the shim) holding
// the harness's `SpawnRequest` (`{argv, env, cwd}`) — `env` values may be secret REFERENCES of
// the form `secrets/<name>`, resolved against `JINN_ATTEMPT_SECRETS_DIR` here, at exec, and never
// written back to `metaDir` (§6.1 step 4).

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

// NOTE on the Linux cgroup-delegation + child-subreaper residual (design §6.1/§12): v1's
// pure-JS shim cannot call `prctl(PR_SET_CHILD_SUBREAPER)` or delegate a cgroup without either a
// native addon or shelling out with elevated permissions this process is not guaranteed to have;
// this is a named, honest residual — "best-effort, not absolute" (design §12) — not a silent
// gap. Group-kill (below) still runs regardless; the escape is detectable-not-always-killable on
// platforms where this residual applies.

interface ShimSpawnRequest {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Optional stdout/stderr redirect targets under `logs/` (the shim never lets the harness inherit its own stdio — design §7.1: `logs/` is backend-written, outside the executor's write surface). */
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

function atomicWriteFileSync(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function resolveSecretReferences(env: Readonly<Record<string, string>>, secretsDir: string | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^secrets\/(.+)$/.exec(value);
    if (match && secretsDir) {
      resolved[key] = readFileSync(join(secretsDir, match[1]!), "utf8").trim();
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function openLogFd(path: string | undefined): number | "ignore" {
  if (path === undefined) return "ignore";
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, "a");
}

/** Uses the same native process-table marker as recovery; never mix wall time with kernel ticks. */
function ownProcessStartTime(): number {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const value = Number(afterComm[19]);
    if (Number.isFinite(value)) return value;
  }
  const output = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  const value = new Date(output).getTime();
  if (Number.isFinite(value)) return value;
  throw new Error("cannot determine shim process start marker");
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write("shim-script: missing spec path argument\n");
    process.exit(78); // EX_CONFIG-ish
  }

  const attemptId = process.env["JINN_ATTEMPT_ID"] ?? "";
  const nonce = process.env["JINN_ATTEMPT_NONCE"] ?? "";
  const metaDir = process.env["JINN_ATTEMPT_META_DIR"] ?? "";
  const secretsDir = process.env["JINN_ATTEMPT_SECRETS_DIR"];
  const heartbeatMs = Number(process.env["JINN_ATTEMPT_HEARTBEAT_MS"] ?? "15000");

  const spec = JSON.parse(readFileSync(specPath!, "utf8")) as ShimSpawnRequest;

  // Step 2 (design §6.1): ignore SIGTERM/SIGINT/SIGHUP at the shim's OWN level — the shim is a
  // process-group member and must survive signals aimed loosely at its surroundings, because it
  // is the sole outcome recorder on every path. The harness runs in ITS OWN session/group
  // (spawned with `detached: true` below), so the cancellation ladder (`cancellation.ts`) signals
  // the harness's own recorded pid/group directly — it never needs to route a signal through the
  // shim's process at all, which is what lets "traps and ignores" be this simple.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      /* survive: the sole outcome recorder never dies to a signal aimed at its surroundings */
    });
  }

  // Step 3: write the fingerprint atomically, BEFORE spawning the harness. Its marker comes
  // from the same native process-table representation recovery probes.
  const startTime = ownProcessStartTime();
  const shimJsonPath = join(metaDir, "shim.json");
  atomicWriteFileSync(shimJsonPath, JSON.stringify({ pid: process.pid, startTime, nonce }));

  // Step 4: resolve secret references AT EXEC (never written to metaDir) and spawn the harness.
  // `detached: true` makes the harness its own session/process-group leader — this is what lets
  // the cancellation ladder signal the harness subtree (by its own pgid) without ever touching
  // the shim's group, and is the mechanism that satisfies "the harness's fate is bound to the
  // attempt" without literally requiring the shim's own group to absorb a kill signal.
  const resolvedEnv = {
    ...resolveSecretReferences(spec.env, secretsDir),
    JINN_ATTEMPT_ID: attemptId,
    JINN_ATTEMPT_NONCE: nonce,
  };
  const stdout = openLogFd(spec.stdoutPath);
  const stderr = openLogFd(spec.stderrPath);
  const harness = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: resolvedEnv,
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });

  // Supplementary metadata (not part of the required 3-field fingerprint): the harness's own pid
  // IS its own pgid (detached: true makes it a session/group leader), so cancellation code can
  // target it directly without re-deriving it. Written as a second atomic update, immediately
  // after spawn — the fingerprint proper was already durable before this point.
  atomicWriteFileSync(shimJsonPath, JSON.stringify({ pid: process.pid, startTime, nonce, harnessPid: harness.pid }));

  // Step 5: heartbeat loop — a monotonic timestamp touched periodically (default 15s, §6.6).
  const heartbeatTimer = setInterval(() => {
    atomicWriteFileSync(join(metaDir, "heartbeat"), JSON.stringify({ monotonicMs: process.hrtime.bigint().toString(), wallClock: new Date().toISOString() }));
  }, heartbeatMs);
  heartbeatTimer.unref();

  const startedAt = new Date().toISOString();

  harness.on("exit", (exitCode, termSignal) => {
    const finishedAt = new Date().toISOString();
    clearInterval(heartbeatTimer);
    if (typeof stdout === "number") closeSync(stdout);
    if (typeof stderr === "number") closeSync(stderr);

    // Step 6: courtesy-kill any remaining descendants in the harness's own group FIRST — Node
    // has already reaped the harness leader by the time this handler runs (libuv performs the
    // wait() internally before delivering 'exit'), so true zombie-pinning (deferring the reap
    // past the group signal) is not achievable from pure JS without a native addon; this is a
    // named, honest residual (design §12's "best-effort, not absolute" framing) — signaling
    // immediately, before writing the outcome file, minimizes (but does not eliminate) the
    // window in which a straggler could theoretically be missed if the pgid were reused.
    if (harness.pid !== undefined) {
      try {
        process.kill(-harness.pid, "SIGKILL");
      } catch {
        /* ESRCH: nothing left alive in the group — expected on the common path */
      }
    }

    atomicWriteFileSync(join(metaDir, "outcome.json"), JSON.stringify({
      attemptId, nonce, exitCode: exitCode ?? null, termSignal: termSignal ?? null, startedAt, finishedAt,
    }));

    process.exit(0);
  });

  harness.on("error", (error) => {
    clearInterval(heartbeatTimer);
    const finishedAt = new Date().toISOString();
    atomicWriteFileSync(join(metaDir, "outcome.json"), JSON.stringify({
      attemptId, nonce, exitCode: null, termSignal: null, startedAt, finishedAt,
      spawnError: String((error as Error).message ?? error),
    }));
    process.exit(0);
  });
}

void main();
