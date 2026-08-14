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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for verifier fixture process");
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
  await waitUntil(() => existsSync(pidPath));
  const pid = Number(readFileSync(pidPath, "utf8"));

  controller.abort();
  await expect(running).rejects.toThrow(/cancelled/u);
  expect(() => process.kill(pid, 0)).toThrow();
});
