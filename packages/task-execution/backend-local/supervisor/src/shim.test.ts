// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  buildShimSpawn, fingerprintAlive, listProcessGroupPids, readOutcome, readProcessStartTime, readShimFingerprint,
  resolveShimScriptEntry, writeOutcomeFile, writeShimFingerprint,
} from "./shim.js";

const tempDirs: string[] = [];
function tempMetaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jinn-supervisor-shim-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fingerprint round trip", () => {
  it("writes and reads back the shim fingerprint atomically", () => {
    const metaDir = tempMetaDir();
    writeShimFingerprint(metaDir, { pid: 4242, startTime: 111, nonce: "n1" });
    expect(readShimFingerprint(metaDir)).toEqual({ pid: 4242, startTime: 111, nonce: "n1", ready: true });
  });

  it("returns null when no fingerprint has been written", () => {
    expect(readShimFingerprint(tempMetaDir())).toBeNull();
  });
});

describe("fingerprintAlive", () => {
  it("a matching (pid, start-time) pair is alive", () => {
    expect(fingerprintAlive({ pid: 4242, startTime: 111 }, { pid: 4242, startTime: 111 })).toBe(true);
  });

  it("a recycled PID with a different start-time reads as not-alive", () => {
    const fp = { pid: 4242, startTime: 111 };
    expect(fingerprintAlive(fp, { pid: 4242, startTime: 999 })).toBe(false);
  });

  it("an unverifiable (undefined) process-table entry reads as not-alive — a bare PID is never trusted", () => {
    expect(fingerprintAlive({ pid: 4242, startTime: 111 }, undefined)).toBe(false);
  });
});

describe("outcome-file atomicity", () => {
  it("a crash between temp-write and rename leaves no outcome.json — readOutcome returns null, never a partial parse", () => {
    const metaDir = tempMetaDir();
    const outcomePath = join(metaDir, "outcome.json");
    expect(() => atomicWriteFileSync(outcomePath, JSON.stringify({ attemptId: "a1", nonce: "n1", exitCode: 0, termSignal: null, startedAt: "t0", finishedAt: "t1" }), {
      beforeRename: () => {
        throw new Error("simulated kill -9 between temp-fsync and rename");
      },
    })).toThrow(/simulated kill -9/);

    expect(existsSync(outcomePath)).toBe(false);
    expect(readOutcome(metaDir)).toBeNull();
    // the temp file is a harmless leftover — present or absent, readOutcome never sees it because
    // it reads the exact destination path, never a directory scan.
    const leftovers = readdirSync(metaDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers.length).toBeGreaterThanOrEqual(0);
  });

  it("a completed write is read back whole", () => {
    const metaDir = tempMetaDir();
    writeOutcomeFile(metaDir, { attemptId: "a1", nonce: "n1", exitCode: 0, termSignal: null, startedAt: "t0", finishedAt: "t1" });
    expect(readOutcome(metaDir)).toEqual({ attemptId: "a1", nonce: "n1", exitCode: 0, termSignal: null, startedAt: "t0", finishedAt: "t1" });
  });
});

describe("readOutcome nonce checking", () => {
  it("rejects an outcome whose nonce mismatches the attempt (design §6.4 stale/foreign row) — returns null", () => {
    const metaDir = tempMetaDir();
    writeOutcomeFile(metaDir, { attemptId: "a1", nonce: "nonce-a", exitCode: 0, termSignal: null, startedAt: "t0", finishedAt: "t1" });
    expect(readOutcome(metaDir, "nonce-b")).toBeNull();
    expect(readOutcome(metaDir, "nonce-a")).not.toBeNull();
  });

  it("with no expected nonce supplied, returns the outcome as-is", () => {
    const metaDir = tempMetaDir();
    writeOutcomeFile(metaDir, { attemptId: "a1", nonce: "nonce-a", exitCode: 0, termSignal: null, startedAt: "t0", finishedAt: "t1" });
    expect(readOutcome(metaDir)?.nonce).toBe("nonce-a");
  });
});

describe("readProcessStartTime", () => {
  it("returns a finite value for the current process (this test's own pid)", () => {
    const startTime = readProcessStartTime(process.pid);
    expect(startTime).toBeDefined();
    expect(Number.isFinite(startTime)).toBe(true);
  });

  it("returns undefined for a pid that plausibly does not exist", () => {
    // A very large pid unlikely to be live on any real system.
    expect(readProcessStartTime(2_147_483_647)).toBeUndefined();
  });

  it("two probes of the SAME live pid agree", () => {
    const first = readProcessStartTime(process.pid);
    const second = readProcessStartTime(process.pid);
    expect(first).toBe(second);
  });
});

describe("process-group scanning", () => {
  it("finds a real process-group member from the process table", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 30000)"],
      { detached: true, stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("fixture child has no PID");
    try {
      expect(listProcessGroupPids(child.pid)).toContain(child.pid);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH is an allowed fixture-exit race.
      }
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});

describe("resolveShimScriptEntry", () => {
  it("resolves to an existing sibling file (shim-script.ts in dev/test, shim-script.js post-build)", () => {
    const entry = resolveShimScriptEntry();
    expect(existsSync(entry)).toBe(true);
    expect(entry).toMatch(/shim-script\.(?:js|ts)$/);
  });
});

describe("buildShimSpawn", () => {
  it("tags JINN_ATTEMPT_ID/NONCE/META_DIR/SECRETS_DIR on the shim's OWN env — present from fork", () => {
    const built = buildShimSpawn({
      attemptId: "urn:uuid:00000000-0000-0000-0000-000000000201",
      nonce: "n1",
      metaDir: "/attempts/x/meta",
      secretsDir: "/attempts/x/secrets",
    });
    expect(built.command).toBe(process.execPath);
    expect(built.env["JINN_ATTEMPT_ID"]).toBe("urn:uuid:00000000-0000-0000-0000-000000000201");
    expect(built.env["JINN_ATTEMPT_NONCE"]).toBe("n1");
    expect(built.env["JINN_ATTEMPT_META_DIR"]).toBe("/attempts/x/meta");
    expect(built.env["JINN_ATTEMPT_SECRETS_DIR"]).toBe("/attempts/x/secrets");
    expect(built.args[1]).toBe(join("/attempts/x/meta", "spawn-request.json"));
  });

  it("is a pure function of its inputs — identical inputs produce a deep-equal spawn spec", () => {
    const request = {
      attemptId: "urn:uuid:00000000-0000-0000-0000-000000000202", nonce: "n2",
      metaDir: "/attempts/y/meta", secretsDir: "/attempts/y/secrets",
    };
    expect(buildShimSpawn(request)).toEqual(buildShimSpawn(request));
  });
});
