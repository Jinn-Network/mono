// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnShim } from "./shim.js";

const dirs: string[] = [];
const waitForJson = async (path: string): Promise<Record<string, unknown>> => {
  for (let index = 0; index < 100; index++) {
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error("shim did not write outcome.json");
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("runs the real shim with fork-time attempt tags and records a natural exit 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-integration-"));
  dirs.push(root);
  const metaDir = join(root, "meta");
  const secretsDir = join(root, "secrets");
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  spawnShim(
    { attemptId: "attempt-1", nonce: "nonce-1", metaDir, secretsDir, heartbeatMs: 5 },
    { argv: [process.execPath, "-e", "if (!process.env.JINN_ATTEMPT_ID || !process.env.JINN_ATTEMPT_NONCE) process.exit(17)"], env: {}, cwd: root },
  );
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  expect(outcome).toMatchObject({ attemptId: "attempt-1", nonce: "nonce-1", exitCode: 0, termSignal: null });
});

it("survives SIGTERM aimed at its group and remains the outcome recorder", async () => {
  const root = mkdtempSync(join(tmpdir(), "jinn-shim-signal-"));
  dirs.push(root);
  const metaDir = join(root, "meta");
  const secretsDir = join(root, "secrets");
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  spawnShim(
    { attemptId: "attempt-2", nonce: "nonce-2", metaDir, secretsDir },
    { argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 40)"], env: {}, cwd: root },
  );
  const fingerprint = await waitForJson(join(metaDir, "shim.json"));
  // The harness is deliberately in a separate group; this direct shim signal proves that its
  // signal trap survives and continues to record the harness's natural result.
  process.kill(Number(fingerprint["pid"]), "SIGTERM");
  const outcome = await waitForJson(join(metaDir, "outcome.json"));
  expect(outcome).toMatchObject({ exitCode: 0, termSignal: null });
});
