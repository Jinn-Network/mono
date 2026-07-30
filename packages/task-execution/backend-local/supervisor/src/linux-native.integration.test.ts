// SPDX-License-Identifier: Apache-2.0

import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

afterEach(() => {
  for (const pid of residualPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(linux)("Linux native custody shim", () => {
  it("fails closed when the native custody probe cannot establish mandatory subreaper support", () => {
    const support = nativeCustodySupport();
    expect(support.ready).toBe(true);
    expect(support.subreaper).toBe(true);
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
    const custody = JSON.parse(readFileSync(join(meta, "custody.json"), "utf8")) as Record<string, unknown>;
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
    const custody = JSON.parse(readFileSync(join(meta, "custody.json"), "utf8")) as Record<string, unknown>;
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
        argv: [process.execPath, "-e", "setTimeout(()=>process.exit(0),100)"], env: {}, cwd: root,
      });
      const fingerprint = await waitFor(() => readShimFingerprint(meta) ?? undefined, `ready fingerprint ${index}`);
      writeFileSync(join(meta, "cancellation-command.json"), document);
      expect(requestShimCancellation(meta, fingerprint)).toBe(true);
      const outcome = await waitFor(() => readOutcome(meta, "nonce-good") ?? undefined, `natural hostile outcome ${index}`);
      expect({ attemptId: outcome.attemptId, nonce: outcome.nonce, exitCode: outcome.exitCode, termSignal: outcome.termSignal }).toEqual({ attemptId: `attempt-hostile-${index}`, nonce: "nonce-good", exitCode: 0, termSignal: null });
    }
  }, 15_000);

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
