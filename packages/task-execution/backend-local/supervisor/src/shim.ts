// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync, readAtomicFileSync } from "./fs-atomic.js";
import type { SpawnRequest } from "./attempt-identity.js";

/** The shim's `(pid, start-time)` fingerprint plus the attempt nonce (design §6.1 step 3, frozen interface §14 item 2). Every liveness conclusion passes through this — a bare PID is never trusted. */
export interface ShimFingerprint {
  readonly pid: number;
  readonly startTime: number;
  readonly nonce: string;
  /** Supplementary (not part of the required 3-field fingerprint): the harness's own pid, which is also its own pgid (spawned `detached: true`) — the cancellation ladder's direct signal target. */
  readonly harnessPid?: number;
  /** Published exactly once after cancellation handling and the child target are ready. */
  readonly ready?: true;
}

/** `meta/outcome.json` (design §6.1 step 6). */
export interface OutcomeFile {
  readonly attemptId: string;
  readonly nonce: string;
  readonly exitCode: number | null;
  readonly termSignal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly spawnError?: string;
}

function shimJsonPath(metaDir: string): string {
  return join(metaDir, "shim.json");
}
function outcomeJsonPath(metaDir: string): string {
  return join(metaDir, "outcome.json");
}
function heartbeatPath(metaDir: string): string {
  return join(metaDir, "heartbeat");
}
function cancellationCommandPath(metaDir: string): string {
  return join(metaDir, "cancellation-command.json");
}
function cancellationResultPath(metaDir: string): string {
  return join(metaDir, "cancellation-result.json");
}

const NONCE_IDENTITY_PREFIX = "b64url-v1:";

/** Binary-safe process identity for any I-JSON scalar string; never put nonce text in argv/env. */
export function encodeNonceIdentity(nonce: string): string {
  return `${NONCE_IDENTITY_PREFIX}${Buffer.from(nonce, "utf8").toString("base64url")}`;
}

export function decodeNonceIdentity(identity: string): string | null {
  if (!identity.startsWith(NONCE_IDENTITY_PREFIX) || !/^[A-Za-z0-9_-]*$/u.test(identity.slice(NONCE_IDENTITY_PREFIX.length))) return null;
  try {
    const bytes = Buffer.from(identity.slice(NONCE_IDENTITY_PREFIX.length), "base64url");
    const nonce = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return encodeNonceIdentity(nonce) === identity ? nonce : null;
  } catch { return null; }
}

function nativeShimPath(): string {
  const configured = process.env["JINN_NATIVE_CUSTODY_BINARY"];
  if (configured !== undefined) return configured;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "dist", "native", process.env["VITEST"] === undefined ? "jinn-attempt-shim" : "jinn-attempt-shim-test");
}

/** Linux custody is mandatory: a missing/failed native probe is never silently downgraded. */
export function nativeCustodySupport(): { readonly ready: boolean; readonly subreaper: boolean; readonly detail?: string } {
  if (process.platform !== "linux") return { ready: true, subreaper: false, detail: "macOS process-group residual" };
  const binary = nativeShimPath();
  if (!existsSync(binary)) return { ready: false, subreaper: false, detail: "Linux native custody binary is missing; run the package build" };
  const result = spawnSync(binary, ["--probe"], { encoding: "utf8" });
  if (result.status !== 0) return { ready: false, subreaper: false, detail: result.stderr.trim() || "PR_SET_CHILD_SUBREAPER probe failed" };
  try {
    const parsed = JSON.parse(result.stdout) as { ready?: boolean; subreaper?: boolean };
    return parsed.ready === true && parsed.subreaper === true
      ? { ready: true, subreaper: true }
      : { ready: false, subreaper: false, detail: "native custody probe did not confirm subreaper" };
  } catch {
    return { ready: false, subreaper: false, detail: "native custody probe emitted malformed output" };
  }
}

/** Durable, nonce-bound request for the shim to own the harness-subtree termination ladder. */
export interface ShimCancellationCommand {
  readonly nonce: string;
  readonly graceMs: number;
  readonly killPollCeilingMs: number;
}

export interface ShimCancellationResult {
  readonly nonce: string;
  readonly residualPids: readonly number[];
}

export function writeShimCancellationCommand(metaDir: string, command: ShimCancellationCommand): void {
  atomicWriteFileSync(cancellationCommandPath(metaDir), JSON.stringify(command));
}

export function readShimCancellationResult(metaDir: string, expectedNonce: string): ShimCancellationResult | null {
  const raw = readAtomicFileSync(cancellationResultPath(metaDir));
  if (raw === undefined) return null;
  const value = JSON.parse(raw) as ShimCancellationResult;
  return value.nonce === expectedNonce ? value : null;
}

/**
 * Signals only a fingerprint-verified shim after its command is durable. The shim, never the
 * assembly, owns TERM → grace → KILL for the harness process group.
 */
export function requestShimCancellation(metaDir: string, expected: ShimFingerprint): boolean {
  const current = probeShimAlive(metaDir);
  if (current.fingerprint === null || !current.alive
    || current.fingerprint.nonce !== expected.nonce
    || !fingerprintAlive(expected, current.fingerprint)) return false;
  try {
    process.kill(expected.pid, "SIGUSR1");
    return true;
  } catch {
    return false;
  }
}

/** Atomically writes the shim's fingerprint to `meta/shim.json` (design §6.1 step 3). */
export function writeShimFingerprint(metaDir: string, fingerprint: ShimFingerprint): void {
  atomicWriteFileSync(shimJsonPath(metaDir), JSON.stringify({ ...fingerprint, ready: true }));
}

/** Reads `meta/shim.json`, or `null` if the shim has never written one. */
export function readShimFingerprint(metaDir: string): ShimFingerprint | null {
  const raw = readAtomicFileSync(shimJsonPath(metaDir));
  if (raw === undefined) return null;
  const fingerprint = JSON.parse(raw) as ShimFingerprint;
  return fingerprint.ready === true ? fingerprint : null;
}

/**
 * Pure fingerprint comparison (design §6.1 step 3): a fingerprint binds `(pid, start-time)`, so a
 * recycled PID with a DIFFERENT start-time reads as not-alive. `actual` is `undefined` when the
 * pid does not currently exist (or its start time could not be verified) in the process table.
 */
export function fingerprintAlive(
  fingerprint: Pick<ShimFingerprint, "pid" | "startTime">,
  actual: { readonly pid: number; readonly startTime: number } | undefined,
): boolean {
  return actual !== undefined && actual.pid === fingerprint.pid && actual.startTime === fingerprint.startTime;
}

/** Atomically writes `meta/outcome.json` (test/orchestration helper mirroring what the real shim script does internally — the shim script's own copy stays self-contained per its file-level doc comment). */
export function writeOutcomeFile(metaDir: string, outcome: OutcomeFile): void {
  atomicWriteFileSync(outcomeJsonPath(metaDir), JSON.stringify(outcome));
}

/**
 * Reads `meta/outcome.json`. Returns `null` if absent (never a partial parse — the write is
 * atomic, so the file is either whole or missing), or if `expectedNonce` is supplied and does
 * not match the recorded nonce (design §6.4 "stale/foreign" row — treated as absent, never
 * trusted).
 */
export function readOutcome(metaDir: string, expectedNonce?: string): OutcomeFile | null {
  const raw = readAtomicFileSync(outcomeJsonPath(metaDir));
  if (raw === undefined) return null;
  const outcome = JSON.parse(raw) as OutcomeFile;
  if (expectedNonce !== undefined && outcome.nonce !== expectedNonce) return null;
  return outcome;
}

export interface Heartbeat {
  readonly monotonicMs: string;
  readonly wallClock: string;
}

/** Reads `meta/heartbeat`, or `null` if the shim has not touched it yet. */
export function readHeartbeat(metaDir: string): Heartbeat | null {
  const raw = readAtomicFileSync(heartbeatPath(metaDir));
  if (raw === undefined) return null;
  return JSON.parse(raw) as Heartbeat;
}

/**
 * Best-effort OS process-start-time probe (design §6.1: "a bare PID is never trusted"). Linux
 * reads `/proc/<pid>/stat` field 22 (start-time in clock ticks since boot — stable and
 * comparable across two probes of the same running kernel, so no clock-tick-to-wallclock
 * conversion is needed). macOS has no `/proc`; falls back to `ps -o lstart=`, parsed to epoch
 * ms. Returns `undefined` if the pid does not exist or the platform probe fails — callers treat
 * an unverifiable start time as not-alive (fail-safe, matching "never trust a bare PID").
 */
export function readProcessStartTime(pid: number): number | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime) follows the `(comm)` parenthesized field, which may itself contain
      // spaces/parens — split on the LAST `)` to skip past it safely.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim();
      const fields = afterComm.split(/\s+/);
      const starttimeField = fields[19]; // 0-indexed from field 3 (state) => field 22 is index 22-3=19
      if (starttimeField === undefined) return undefined;
      const ticks = Number(starttimeField);
      return Number.isFinite(ticks) ? ticks : undefined;
    }
    // macOS / other POSIX: shell out to `ps`, a standard system utility.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return undefined;
    const ms = new Date(out).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined; // pid not found, or the platform probe is unavailable — unverifiable
  }
}

function linuxProcessGroupId(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim();
    const fields = afterComm.split(/\s+/);
    // Fields after `(comm)` begin at stat field 3 (`state`); pgrp is field 5.
    const value = Number(fields[2]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns every process-table member whose process-group id is `pgid`. Recovery and terminal
 * cleanup use this instead of treating the group leader's bare PID as proof that the whole
 * subtree is empty.
 */
export function listProcessGroupPids(pgid: number): number[] {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return [];
  const members: number[] = [];
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (linuxProcessGroupId(pid) === pgid) members.push(pid);
    }
  } else {
    try {
      const rows = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
      for (const row of rows.split("\n")) {
        const [pidText, groupText] = row.trim().split(/\s+/);
        const pid = Number(pidText);
        const group = Number(groupText);
        if (Number.isSafeInteger(pid) && pid > 0 && group === pgid) members.push(pid);
      }
    } catch {
      return [];
    }
  }
  return members.sort((left, right) => left - right);
}

/** Probes whether the shim recorded at `metaDir` is genuinely alive right now (fingerprint verified against the live process table, not a bare PID check). */
export function probeShimAlive(metaDir: string): { readonly alive: boolean; readonly fingerprint: ShimFingerprint | null } {
  const fingerprint = readShimFingerprint(metaDir);
  if (fingerprint === null) return { alive: false, fingerprint: null };
  const actualStartTime = readProcessStartTime(fingerprint.pid);
  const alive = actualStartTime !== undefined
    && fingerprintAlive(fingerprint, { pid: fingerprint.pid, startTime: actualStartTime });
  return { alive, fingerprint };
}

/**
 * Resolves the shim script's own entry point next to `shim.ts`/`shim.js` — `./shim-script.js`
 * post-build (production), falling back to `./shim-script.ts` pre-build (dev/test, run directly
 * under Node's native TypeScript support; the shim script is import-free so this needs no loader
 * or bundler). Throws if neither exists — a packaging error, not a runtime one.
 */
export function resolveShimScriptEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "shim-script.js");
  if (existsSync(compiled)) return compiled;
  const source = join(here, "shim-script.ts");
  if (existsSync(source)) return source;
  throw new Error(`shim.ts: could not resolve shim-script next to ${here} (looked for shim-script.js and shim-script.ts)`);
}

/** Writes the harness `SpawnRequest` the shim script reads at startup (`env` may carry `secrets/<name>` REFERENCES, resolved by the shim at exec — never resolved here). */
export function writeSpawnRequestSpec(
  metaDir: string,
  nonce: string,
  spawn: SpawnRequest & { readonly stdoutPath?: string; readonly stderrPath?: string },
): string {
  const path = join(metaDir, "spawn-request.json");
  atomicWriteFileSync(path, JSON.stringify({ ...spawn, nonce }));
  return path;
}

function nativeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** Bounded length-delimited internal wire format: no JSON parser/native dependency required. */
function writeNativeSpawnSpec(
  request: BuildShimSpawnRequest,
  harness: SpawnRequest & { readonly stdoutPath?: string; readonly stderrPath?: string },
): string {
  const strings = [request.attemptId, JSON.stringify(request.nonce), encodeNonceIdentity(request.nonce), request.metaDir, request.secretsDir, harness.cwd, harness.stdoutPath ?? "", harness.stderrPath ?? ""];
  const parts: Buffer[] = [Buffer.from("JNSP1", "ascii"), ...strings.map(nativeString)];
  const count = (value: number): void => { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32LE(value, 0); parts.push(bytes); };
  count(request.heartbeatMs ?? 15_000);
  count(harness.argv.length);
  for (const arg of harness.argv) parts.push(nativeString(arg));
  const envEntries = [
    ...Object.entries(harness.env).map(([key, value]) => `${key}=${value}`),
    `JINN_ATTEMPT_ID=${request.attemptId}`,
    `JINN_ATTEMPT_NONCE=${encodeNonceIdentity(request.nonce)}`,
  ];
  count(envEntries.length);
  for (const entry of envEntries) parts.push(nativeString(entry));
  const path = join(request.metaDir, "spawn-request.native");
  atomicWriteFileSync(path, Buffer.concat(parts));
  return path;
}

export interface BuildShimSpawnRequest {
  readonly attemptId: string;
  readonly nonce: string;
  readonly metaDir: string;
  readonly secretsDir: string;
  readonly heartbeatMs?: number;
}

/**
 * Pure: builds the argv/env for spawning the shim process itself — `JINN_ATTEMPT_ID`/
 * `JINN_ATTEMPT_NONCE` are set on the SHIM's OWN environment here, so they are present from the
 * instant the shim process exists (design §6.1: "env-tagged from fork"), not merely passed as an
 * argument the shim would have to parse.
 */
export function buildShimSpawn(request: BuildShimSpawnRequest): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const specPath = join(request.metaDir, "spawn-request.json");
  return {
    command: process.execPath,
    args: [resolveShimScriptEntry(), specPath],
    env: {
      ...(process.env as Record<string, string>),
      JINN_ATTEMPT_ID: request.attemptId,
      JINN_ATTEMPT_NONCE: encodeNonceIdentity(request.nonce),
      JINN_ATTEMPT_META_DIR: request.metaDir,
      JINN_ATTEMPT_SECRETS_DIR: request.secretsDir,
      ...(request.heartbeatMs === undefined ? {} : { JINN_ATTEMPT_HEARTBEAT_MS: String(request.heartbeatMs) }),
    },
  };
}

/**
 * Spawns the real shim process (`setsid`/session+process-group leadership is `detached: true` on
 * POSIX — Node calls `setsid()` for the child before exec, no native addon required). The
 * returned `ChildProcess` is detached and `unref()`'d: it survives the calling process exiting,
 * matching "a restarted supervisor has lost `waitpid` rights over its former children forever;
 * the outcome file is readable regardless of who is alive" (design §6.1).
 */
export function spawnShim(request: BuildShimSpawnRequest, harness: SpawnRequest & { readonly stdoutPath?: string; readonly stderrPath?: string }): ChildProcess {
  if (process.platform === "linux") {
    const support = nativeCustodySupport();
    if (!support.ready) throw new Error(support.detail ?? "Linux native custody is not ready");
    const child = spawn(nativeShimPath(), [writeNativeSpawnSpec(request, harness)], {
      env: {
        ...(process.env as Record<string, string>),
        JINN_ATTEMPT_ID: request.attemptId,
        JINN_ATTEMPT_NONCE: encodeNonceIdentity(request.nonce),
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    return child;
  }
  writeSpawnRequestSpec(request.metaDir, request.nonce, harness);
  const built = buildShimSpawn(request);
  const child = spawn(built.command, built.args as string[], {
    env: built.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}
