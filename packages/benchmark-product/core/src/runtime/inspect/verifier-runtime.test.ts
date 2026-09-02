import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error This product-private runtime is copied into dist without a public type surface.
import { spawnBounded } from "./verifier-runtime.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Waits for a fixture-process side effect. The bound is scaffolding, not the subject: it was 100
 * attempts at 10ms, an effective 1s ceiling that a descheduled worker can spend without the
 * fixture getting any CPU (#3354). A wall-clock deadline of 20s leaves room under Vitest's 30s
 * bound for this error — which names what it was waiting for — to be the one that surfaces.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for verifier fixture process: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("cancellation waits until the verifier child is terminated and reaped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-inspect-verifier-cancel-"));
  temporaryDirectories.push(directory);
  const pidPath = join(directory, "pid");
  const script = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const controller = new AbortController();
  const running = spawnBounded(process.execPath, ["-e", script], { LANG: "C.UTF-8" }, controller.signal);
  await waitUntil(() => existsSync(pidPath), `the fixture never wrote its pid file at ${pidPath}`);
  const pid = Number(readFileSync(pidPath, "utf8"));

  controller.abort();
  await expect(running).rejects.toThrow(/cancelled/u);
  expect(() => process.kill(pid, 0)).toThrow();
});
