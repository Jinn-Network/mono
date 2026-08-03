// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readShimFingerprint,
  requestShimCancellation,
  spawnShim,
  writeShimCancellationCommand,
} from "./shim.js";

const dirs: string[] = [];
const waitForJson = async (path: string): Promise<Record<string, unknown>> => {
  for (let index = 0; index < 100; index++) {
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error("shim did not write outcome.json");
};
const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("runs the real shim with fork-time attempt tags and records a natural exit 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-integration-"));
  dirs.push(root);
  const metaDir = join(root, "meta");
  const secretsDir = join(root, "secrets");
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  const child = spawnShim(
    { attemptId: "attempt-1", nonce: "nonce-1", metaDir, secretsDir, heartbeatMs: 5 },
    { argv: [process.execPath, "-e", "if (!process.env.JINN_ATTEMPT_ID || !process.env.JINN_ATTEMPT_NONCE) process.exit(17)"], env: {}, cwd: root },
  );
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  await waitForExit(child);
  expect(outcome).toMatchObject({ attemptId: "attempt-1", nonce: "nonce-1", exitCode: 0, termSignal: null });
});

it("survives SIGTERM aimed at its group and remains the outcome recorder", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-signal-"));
  dirs.push(root);
  const metaDir = join(root, "meta");
  const secretsDir = join(root, "secrets");
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  const child = spawnShim(
    { attemptId: "attempt-2", nonce: "nonce-2", metaDir, secretsDir },
    { argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 40)"], env: {}, cwd: root },
  );
  const fingerprint = await waitForJson(join(metaDir, "shim.json"));
  // The harness is deliberately in a separate group; this direct shim signal proves that its
  // signal trap survives and continues to record the harness's natural result.
  process.kill(Number(fingerprint["pid"]), "SIGTERM");
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  await waitForExit(child);
  expect(outcome).toMatchObject({ exitCode: 0, termSignal: null });
});

it("relays a nonce-bound cancellation command from the shim to the harness subtree", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-cancel-relay-"));
  dirs.push(root);
  const metaDir = join(root, "meta");
  const secretsDir = join(root, "secrets");
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  const child = spawnShim(
    { attemptId: "attempt-3", nonce: "nonce-3", metaDir, secretsDir },
    { argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"], env: {}, cwd: root },
  );
  const fingerprint = await waitForJson(join(metaDir, "shim.json"));
  writeShimCancellationCommand(metaDir, {
    nonce: "nonce-3",
    graceMs: 0,
    killPollCeilingMs: 100,
  });
  expect(requestShimCancellation(metaDir, readShimFingerprint(metaDir)!)).toBe(true);
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  await waitForExit(child);
  expect(outcome).toMatchObject({ attemptId: "attempt-3", nonce: "nonce-3", termSignal: "SIGTERM" });
  expect(Number(fingerprint["pid"])).toBeGreaterThan(0);
});

it("substitutes a declared secret reference with its absolute attempt-local path without changing file bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-secret-path-"));
  dirs.push(root);
  const metaDir = join(root, "meta"); const secretsDir = join(root, "secrets"); const seen = join(root, "seen");
  mkdirSync(metaDir, { recursive: true }); mkdirSync(secretsDir, { recursive: true });
  const bytes = Buffer.from([0, 255, 10, 32]);
  writeFileSync(join(secretsDir, "credential"), bytes, { mode: 0o600 });
  const child = spawnShim(
    { attemptId: "attempt-secret-path", nonce: "nonce-secret-path", metaDir, secretsDir },
    { argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(seen)},process.env.CREDENTIAL_PATH)`], env: { CREDENTIAL_PATH: "secrets/credential" }, cwd: root },
  );
  await waitForJson(join(metaDir, "outcome.json"));
  await waitForExit(child);
  expect(readFileSync(seen, "utf8")).toBe(realpathSync(join(secretsDir, "credential")));
  expect(readFileSync(join(secretsDir, "credential"))).toEqual(bytes);
});

it("round-trips an escaped binary-safe nonce through fingerprint and outcome while child env receives only its encoded identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-nonce-"));
  dirs.push(root);
  const metaDir = join(root, "meta"); const secretsDir = join(root, "secrets"); const seen = join(root, "nonce-env");
  mkdirSync(metaDir, { recursive: true }); mkdirSync(secretsDir, { recursive: true });
  const nonce = "nul-\u0000-quote-\"-slash-\\-control-\u0001-supplementary-😀";
  const child = spawnShim(
    { attemptId: "attempt-nonce-binary", nonce, metaDir, secretsDir },
    { argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(seen)},process.env.JINN_ATTEMPT_NONCE)`], env: {}, cwd: root },
  );
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  await waitForExit(child);
  const fingerprint = await waitForJson(join(metaDir, "shim.json"));
  expect(outcome["nonce"]).toBe(nonce);
  expect(fingerprint["nonce"]).toBe(nonce);
  expect(readFileSync(seen, "utf8")).toMatch(/^b64url-v1:[A-Za-z0-9_-]+$/u);
});
