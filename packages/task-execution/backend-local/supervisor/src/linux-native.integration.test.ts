// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeCustodySupport,
  readOutcome,
  readShimFingerprint,
  requestShimCancellation,
  spawnShim,
  writeShimCancellationCommand,
} from "./shim.js";

const dirs: string[] = [];
const residualPids: number[] = [];
const linux = process.platform === "linux";
const waitFor = async <T>(fn: () => T | undefined, label: string): Promise<T> => {
  for (let index = 0; index < 300; index += 1) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
};

// A recursive `rmSync` walks the tree as readdir -> unlink -> rmdir, so a file that lands in a
// directory between its readdir and its rmdir makes the rmdir fail with ENOTEMPTY; `force: true`
// suppresses only ENOENT. Every case below hands `meta/` to the shim, which is a separate process
// that keeps publishing there after the one artifact the case awaited -- `custody.json` and
// `cancellation-result.json` arrive later -- so teardown races it, and that race turned a green
// run red on an unrelated markdown-only pull request (issue #2678).
//
// `rmSync`'s own `maxRetries`/`retryDelay` do NOT cover it, which is the whole reason this loop
// exists. Measured on Node 22: when the internal rimraf meets ENOTEMPTY it removes the children it
// read, then retries the bare `rmdir` on its retry schedule WITHOUT re-reading the directory, so
// an entry created after that readdir is never unlinked and every retry fails on it. At
// `maxRetries: 60, retryDelay: 50` a 300ms writer produced a throw after 92 seconds of retrying --
// slower and no more correct. Re-entering `rmSync` from the top is what re-reads the directory.
//
// One budget for the WHOLE hook, not one per directory. The hostile-documents case registers
// eight trees, so a per-directory budget multiplies by eight and a hook that overruns Vitest's
// 10s default hook timeout is the same false red this change exists to remove. Every tree still
// gets at least one attempt whatever the clock says, because the deadline is only consulted after
// a failure.
const REMOVE_BUDGET_MS = 4_000;
const REMOVE_POLL_MS = 20;

// `afterEach` is synchronous, and a worker may block: a bounded synchronous wait keeps the
// teardown one statement instead of making every caller async. One buffer, since nothing ever
// stores into it and the wait therefore always runs to its timeout.
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(waitCell, 0, 0, ms);
};

/**
 * Removes one attempt tree, re-entering `rmSync` until it succeeds or `deadline` passes.
 *
 * Never throws: the assertions have already passed by the time this runs, so failing the file here
 * reports a defect the test did not find. It is warned about instead -- and nothing leaks either
 * way, because `$TMPDIR` is the managed root that `test-support/tmp-isolation` sweeps when the run
 * ends. Same contract as `sweepManagedTree` in that seam, which this file cannot import: every
 * package tsconfig here sets `rootDir: "src"`.
 */
const removeAttemptTree = (dir: string, deadline = Date.now() + REMOVE_BUDGET_MS): void => {
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        console.warn(`[jinn-test] could not remove attempt tree ${dir}:`, error);
        return;
      }
      sleepSync(REMOVE_POLL_MS);
    }
  }
};

afterEach(() => {
  for (const pid of residualPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  const deadline = Date.now() + REMOVE_BUDGET_MS;
  for (const dir of dirs.splice(0)) removeAttemptTree(dir, deadline);
});

describe.runIf(linux)("Linux native custody shim", () => {
  it("fails closed when the native custody probe cannot establish mandatory subreaper support", () => {
    const support = nativeCustodySupport();
    expect(support.ready).toBe(true);
    expect(support.subreaper).toBe(true);
  });

  it("fails closed without throwing when the probe binary is non-executable garbage (artifact bit loss / ENOEXEC)", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-probe-"));
    dirs.push(root);
    const bogus = join(root, "not-a-shim");
    writeFileSync(bogus, "");
    const previous = process.env["JINN_NATIVE_CUSTODY_BINARY"];
    process.env["JINN_NATIVE_CUSTODY_BINARY"] = bogus;
    try {
      let support: ReturnType<typeof nativeCustodySupport> | undefined;
      expect(() => {
        support = nativeCustodySupport();
      }).not.toThrow();
      expect(support?.ready).toBe(false);
      expect(support?.subreaper).toBe(false);
      expect(typeof support?.detail).toBe("string");
    } finally {
      if (previous === undefined) delete process.env["JINN_NATIVE_CUSTODY_BINARY"];
      else process.env["JINN_NATIVE_CUSTODY_BINARY"] = previous;
    }
  });

  it("does not require a secrets directory when the launch declares no secret forwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-no-secrets-"));
    dirs.push(root);
    const meta = join(root, "meta");
    const secrets = join(root, "secrets-not-materialized");
    const seen = join(root, "seen");
    mkdirSync(meta, { recursive: true });
    spawnShim({ attemptId: "attempt-no-secrets", nonce: "nonce-no-secrets", metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(seen)},'ok')`],
      env: {},
      cwd: root,
    });
    await waitFor(() => readOutcome(meta, "nonce-no-secrets") ?? undefined, "no-secrets outcome");
    expect(readFileSync(seen, "utf8")).toBe("ok");
  });

  it("adopts an orphan and retains the exited leader until the stubborn group descendant is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-"));
    dirs.push(root);
    const meta = join(root, "meta");
    const secrets = join(root, "secrets");
    mkdirSync(meta, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    const orphanPid = join(root, "orphan.pid");
    const stubbornChild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const program = [
      "const {spawn}=require('node:child_process');",
      `const out=${JSON.stringify(orphanPid)};`,
      `const kid=spawn(process.execPath,['-e',${JSON.stringify(stubbornChild)}],{detached:false,stdio:'ignore'});`,
      "require('node:fs').writeFileSync(out,String(kid.pid)); process.exit(0);",
    ].join("");
    spawnShim({ attemptId: "attempt-linux", nonce: "nonce-linux", metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", program], env: {}, cwd: root,
    });
    const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, "ready fingerprint");
    await waitFor(() => {
      try { return Number(readFileSync(orphanPid, "utf8")); } catch { return undefined; }
    }, "orphan pid");
    writeShimCancellationCommand(meta, { nonce: "nonce-linux", graceMs: 0, killPollCeilingMs: 2_000 });
    expect(requestShimCancellation(meta, fingerprint)).toBe(true);
    const outcome = await waitFor(() => readOutcome(meta, "nonce-linux") ?? undefined, "native outcome");
    expect(outcome.termSignal).toBeNull();
    expect(Number.isFinite(Date.parse(outcome.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(outcome.finishedAt))).toBe(true);
    expect(Date.parse(outcome.finishedAt)).toBeGreaterThanOrEqual(Date.parse(outcome.startedAt));
    const custody = await waitFor(() => {
      try { return JSON.parse(readFileSync(join(meta, "custody.json"), "utf8")) as Record<string, unknown>; } catch { return undefined; }
    }, "native custody outcome");
    expect(custody["subreaper"]).toBe(true);
    let cgroupWritable = true;
    try { accessSync("/sys/fs/cgroup", constants.W_OK); } catch { cgroupWritable = false; }
    expect(custody["cgroup"]).toBe(cgroupWritable ? "delegated" : "residual");
    expect(custody["leaderReapedAfterGroupEmpty"]).toBe(true);
    expect(custody["adoptedChildrenReaped"]).toBeGreaterThanOrEqual(1);
    expect(custody["groupEmpty"]).toBe(true);
  });

  it("kills and reaps session-escaped and double-fork descendants through the complete custody domain", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-escape-"));
    dirs.push(root);
    const meta = join(root, "meta"); const secrets = join(root, "secrets"); const pidsPath = join(root, "escaped.json");
    mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
    const sleeper = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const doubleForkProgram = [
      "const {spawn}=require('node:child_process');const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{detached:true,stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(`${pidsPath}.double`)},String(child.pid));child.unref();process.exit(0);`,
    ].join("");
    const program = [
      "process.on('SIGTERM',()=>{});",
      "const {spawn}=require('node:child_process');const fs=require('node:fs');",
      `const file=${JSON.stringify(pidsPath)};const code=${JSON.stringify(sleeper)};`,
      "const session=spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'});session.unref();",
      `spawn(process.execPath,['-e',${JSON.stringify(doubleForkProgram)}],{stdio:'ignore'});`,
      "const writeEscaped=()=>{try{const double=Number(fs.readFileSync(file+'.double','utf8'));fs.writeFileSync(file,JSON.stringify({session:session.pid,double}));}catch{setTimeout(writeEscaped,5);}};",
      "setTimeout(writeEscaped,0);setInterval(()=>{},1000);",
    ].join("");
    spawnShim({ attemptId: "attempt-escape", nonce: "nonce-escape", metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", program], env: {}, cwd: root,
    });
    const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, "ready fingerprint");
    const escaped = await waitFor(() => {
      try { return JSON.parse(readFileSync(pidsPath, "utf8")) as { session: number; double: number }; } catch { return undefined; }
    }, "escaped descendant pids");
    writeShimCancellationCommand(meta, { nonce: "nonce-escape", graceMs: 0, killPollCeilingMs: 2_000 });
    expect(requestShimCancellation(meta, fingerprint)).toBe(true);
    const outcome = await waitFor(() => readOutcome(meta, "nonce-escape") ?? undefined, "escape outcome");
    expect({ attemptId: outcome.attemptId, nonce: outcome.nonce, exitCode: outcome.exitCode, termSignal: outcome.termSignal }).toEqual({ attemptId: "attempt-escape", nonce: "nonce-escape", exitCode: null, termSignal: "SIGKILL" });
    for (const pid of [escaped.session, escaped.double]) expect(() => process.kill(pid, 0)).toThrow();
    const custody = await waitFor(() => {
      try { return JSON.parse(readFileSync(join(meta, "custody.json"), "utf8")) as Record<string, unknown>; } catch { return undefined; }
    }, "escape custody outcome");
    expect({ subreaper: custody["subreaper"], leaderReapedAfterGroupEmpty: custody["leaderReapedAfterGroupEmpty"], groupEmpty: custody["groupEmpty"] }).toEqual({ subreaper: true, leaderReapedAfterGroupEmpty: true, groupEmpty: true });
    expect(custody["adoptedChildrenReaped"]).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it("does not relay a nonce-mismatched durable command", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-nonce-"));
    dirs.push(root);
    const meta = join(root, "meta");
    const secrets = join(root, "secrets");
    mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
    spawnShim({ attemptId: "attempt-nonce", nonce: "nonce-good", metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", "setTimeout(()=>process.exit(0),1_000)"], env: {}, cwd: root,
    });
    const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, "ready fingerprint");
    writeShimCancellationCommand(meta, { nonce: "nonce-wrong", graceMs: 0, killPollCeilingMs: 100 });
    expect(requestShimCancellation(meta, fingerprint)).toBe(true);
    const outcome = await waitFor(() => readOutcome(meta, "nonce-good") ?? undefined, "natural outcome");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.termSignal).toBeNull();
  });

  it("admits only a complete root cancellation command and round-trips every legal nonce byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-json-"));
    dirs.push(root);
    const meta = join(root, "meta"); const secrets = join(root, "secrets");
    mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
    const nonce = "nul-\u0000-control-\u0001-quote-\"-slash-\\-supplementary-😀";
    spawnShim({ attemptId: "attempt-json", nonce, metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], env: {}, cwd: root,
    });
    const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, "ready fingerprint");
    writeFileSync(
      join(meta, "cancellation-command.json"),
      '{"nonce":"nul-\\u0000-control-\\u0001-quote-\\"-slash-\\\\-supplementary-\\ud83d\\ude00","graceMs":0,"killPollCeilingMs":500}',
    );
    expect(requestShimCancellation(meta, fingerprint)).toBe(true);
    const outcome = await waitFor(() => readOutcome(meta, nonce) ?? undefined, "unicode cancellation outcome");
    expect({ attemptId: outcome.attemptId, nonce: outcome.nonce, exitCode: outcome.exitCode, termSignal: outcome.termSignal }).toEqual({ attemptId: "attempt-json", nonce, exitCode: null, termSignal: "SIGTERM" });
  });

  it("rejects hostile cancellation documents without matching keys inside strings or nested objects", async () => {
    const hostileDocuments = [
      '{"note":"\\\"nonce\\\":\\\"nonce-good\\\"","graceMs":0,"killPollCeilingMs":1}',
      '{"nonce":"nonce-good","nonce":"nonce-good","graceMs":0,"killPollCeilingMs":1}',
      '{"nonce":"nonce-good","graceMs":0,"killPollCeilingMs":1,"extra":true}',
      '{"nonce":{"nonce":"nonce-good"},"graceMs":0,"killPollCeilingMs":1}',
      '{"nonce":"\\ud800","graceMs":0,"killPollCeilingMs":1}',
      '{"nonce":"nonce-good","graceMs":00,"killPollCeilingMs":1}',
      '{"nonce":"nonce-good","graceMs":0,"killPollCeilingMs":1,}',
      '{"nonce":"nonce-good","graceMs":0,"killPollCeilingMs":1',
    ] as const;
    for (const [index, document] of hostileDocuments.entries()) {
      const root = mkdtempSync(join(tmpdir(), `jinn-linux-native-hostile-${index}-`));
      dirs.push(root);
      const meta = join(root, "meta"); const secrets = join(root, "secrets");
      mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
      spawnShim({ attemptId: `attempt-hostile-${index}`, nonce: "nonce-good", metaDir: meta, secretsDir: secrets }, {
        // Keep the leader alive long enough for a loaded CI runner to signal the shim after its
        // fingerprint is published. The command must still be rejected and the leader must exit
        // naturally, so extending this window does not weaken the hostile-document assertion.
        argv: [process.execPath, "-e", "setTimeout(()=>process.exit(0),1000)"], env: {}, cwd: root,
      });
      const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, `ready fingerprint ${index}`);
      writeFileSync(join(meta, "cancellation-command.json"), document);
      expect(requestShimCancellation(meta, fingerprint)).toBe(true);
      const outcome = await waitFor(() => readOutcome(meta, "nonce-good") ?? undefined, `natural hostile outcome ${index}`);
      expect({ attemptId: outcome.attemptId, nonce: outcome.nonce, exitCode: outcome.exitCode, termSignal: outcome.termSignal }).toEqual({ attemptId: `attempt-hostile-${index}`, nonce: "nonce-good", exitCode: 0, termSignal: null });
    }
  }, 20_000);

  it("forwards a declared secret as its verified attempt-local absolute path without reading its bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-secret-"));
    dirs.push(root);
    const meta = join(root, "meta"); const secrets = join(root, "secrets"); const seen = join(root, "seen");
    mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
    const bytes = Buffer.from([0, 255, 10, 32]);
    writeFileSync(join(secrets, "forward"), bytes, { mode: 0o600 });
    spawnShim({ attemptId: "attempt-secret", nonce: "nonce-secret", metaDir: meta, secretsDir: secrets }, {
      argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(seen)},process.env.SECRET_PATH)`],
      env: { SECRET_PATH: "secrets/forward" }, cwd: root,
    });
    await waitFor(() => readOutcome(meta, "nonce-secret") ?? undefined, "secret-forward outcome");
    expect(readFileSync(seen, "utf8")).toBe(join(secrets, "forward"));
    expect(readFileSync(join(secrets, "forward"))).toEqual(bytes);
  });

  it("persists actual live residual pids when the bounded group cleanup expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-linux-native-residual-"));
    dirs.push(root);
    const meta = join(root, "meta"); const secrets = join(root, "secrets");
    mkdirSync(meta, { recursive: true }); mkdirSync(secrets, { recursive: true });
    const childPid = join(root, "stubborn.pid");
    const leaderProgram = `const kid=require('node:child_process').spawn('/bin/sh',['-c',${JSON.stringify("trap '' TERM; while :; do sleep 1; done")}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(childPid)},String(kid.pid));setInterval(()=>{},1000)`;
    const prior = process.env["JINN_NATIVE_CUSTODY_TEST_SKIP_KILL"];
    process.env["JINN_NATIVE_CUSTODY_TEST_SKIP_KILL"] = "1";
    try {
      spawnShim({ attemptId: "attempt-residual", nonce: "nonce-residual", metaDir: meta, secretsDir: secrets }, {
        argv: [process.execPath, "-e", leaderProgram], env: {}, cwd: root,
      });
      const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, "ready fingerprint");
      await waitFor(() => { try { return Number(readFileSync(childPid, "utf8")); } catch { return undefined; } }, "stubborn descendant");
      const started = performance.now();
      writeShimCancellationCommand(meta, { nonce: "nonce-residual", graceMs: 0, killPollCeilingMs: 30 });
      expect(requestShimCancellation(meta, fingerprint)).toBe(true);
      const result = await waitFor(() => {
        try { return JSON.parse(readFileSync(join(meta, "cancellation-result.json"), "utf8")) as { residualPids: number[] }; } catch { return undefined; }
      }, "residual result");
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(1_000);
      expect([...result.residualPids].sort((left, right) => left - right)).toEqual(result.residualPids);
      expect(result.residualPids).toContain(fingerprint.harnessPid!);
      expect(result.residualPids).toContain(Number(readFileSync(childPid, "utf8")));
      for (const pid of result.residualPids) { process.kill(pid, 0); residualPids.push(pid); }
      const outcome = await waitFor(() => readOutcome(meta, "nonce-residual") ?? undefined, "terminal residual outcome");
      expect({ attemptId: outcome.attemptId, nonce: outcome.nonce, exitCode: outcome.exitCode, termSignal: outcome.termSignal }).toEqual({ attemptId: "attempt-residual", nonce: "nonce-residual", exitCode: null, termSignal: null });
      const custody = await waitFor(() => {
        try { return JSON.parse(readFileSync(join(meta, "custody.json"), "utf8")) as Record<string, unknown>; } catch { return undefined; }
      }, "residual custody outcome");
      expect(custody["leaderReapedAfterGroupEmpty"]).toBe(false);
      expect(custody["groupEmpty"]).toBe(false);
    } finally {
      if (prior === undefined) delete process.env["JINN_NATIVE_CUSTODY_TEST_SKIP_KILL"];
      else process.env["JINN_NATIVE_CUSTODY_TEST_SKIP_KILL"] = prior;
    }
  }, 10_000);
});

// Teardown coverage for the removal above. Not gated on Linux: the shim cases are, but the
// ENOTEMPTY race is a property of recursive removal against a live writer and reproduces on any
// platform, so gating it would leave the regression unproven everywhere else the suite runs.
describe("attempt tree teardown", () => {
  // A tight synchronous writer, bounded by wall clock so a loaded runner does not lengthen it, and
  // a directory pre-filled deeply enough that the readdir -> unlink phase takes long enough for a
  // new entry to land before the rmdir. That is the shim's shape -- a separate process still
  // publishing into `meta/` after the artifact a case awaited -- and against the pre-fix teardown
  // (a bare recursive `rmSync`) it raises ENOTEMPTY on `meta` in most trials.
  const WRITER_WINDOW_MS = 300;
  const PRE_EXISTING_ENTRIES = 400;
  const CONSECUTIVE_CYCLES = 25;
  const RACE_TRIALS = 5;
  const writerProgram = [
    "const {writeFileSync}=require('node:fs');const {join}=require('node:path');",
    "const dir=process.argv[1];let index=0;",
    `const deadline=Date.now()+${WRITER_WINDOW_MS};`,
    "while(Date.now()<deadline){index+=1;try{writeFileSync(join(dir,`late-${index}.json`),'{}');}catch{}}",
  ].join("");

  it(`removes the tree on every one of ${CONSECUTIVE_CYCLES} consecutive cycles`, () => {
    for (let cycle = 0; cycle < CONSECUTIVE_CYCLES; cycle += 1) {
      const root = mkdtempSync(join(tmpdir(), "jinn-teardown-cycle-"));
      dirs.push(root);
      const meta = join(root, "meta");
      mkdirSync(meta, { recursive: true });
      writeFileSync(join(meta, "outcome.json"), "{}");
      removeAttemptTree(root);
      expect(existsSync(root)).toBe(false);
    }
  });

  it("removes the tree without throwing while another process is still writing into it", async () => {
    for (let trial = 0; trial < RACE_TRIALS; trial += 1) {
      const root = mkdtempSync(join(tmpdir(), "jinn-teardown-race-"));
      // Registered like every other case: an assertion that fails below leaves the tree to the
      // shared teardown rather than to the end-of-run sweep.
      dirs.push(root);
      const meta = join(root, "meta");
      mkdirSync(meta, { recursive: true });
      for (let entry = 0; entry < PRE_EXISTING_ENTRIES; entry += 1) {
        writeFileSync(join(meta, `pre-${entry}.json`), "{}");
      }
      const writer = spawn(process.execPath, ["-e", writerProgram, meta], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Two separate claims. Not throwing is what keeps a passing test body from going red; the
      // tree actually being gone is what proves the retries outlasted the writer rather than the
      // catch merely swallowing the error. The retry budget covers several times the writer's
      // window, so the second claim does not race the first.
      expect(() => removeAttemptTree(root)).not.toThrow();
      expect(existsSync(root)).toBe(false);
      // `once` never resolves for a child that has already exited, and this one exits on its own
      // deadline -- usually before the removal returns. Check before awaiting, as
      // `shim.integration.test.ts` does.
      writer.kill("SIGKILL");
      if (writer.exitCode === null && writer.signalCode === null) await once(writer, "exit");
    }
  }, 30_000);
});
