import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error This product-private runtime is copied into dist without a public type surface.
import { spawnBounded } from "./verifier-runtime.mjs";

const temporaryDirectories: string[] = [];

/** The fixture child delays its exit this long after SIGTERM, so a cancellation that resolves on
 * the signal rather than on the child's death is measurably faster than one that waits. */
const TERMINATION_DELAY_MS = 50;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Wall clock, so a descheduled worker spends the budget without doing work. 10s matches the order
 * of this suite's 30s per-test bound rather than the 1s that a loaded box can spend just getting a
 * cold Node child to its first write. */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** The child creates the pid file and writes it in two steps, so existence is not readiness: a
 * descheduled child leaves a file that reads back empty, and `Number("")` is 0 — a pid that
 * `process.kill` routes to the whole process group instead of to a child that is already gone. */
function readPid(pidPath: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(pidPath, "utf8").trim();
  } catch {
    return undefined;
  }
  const pid = Number(content);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cancellation waits until the verifier child is terminated and reaped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-inspect-verifier-cancel-"));
  temporaryDirectories.push(directory);
  const pidPath = join(directory, "pid");
  const script = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    `process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${TERMINATION_DELAY_MS}));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const controller = new AbortController();
  const running = spawnBounded(process.execPath, ["-e", script], { LANG: "C.UTF-8" }, controller.signal);
  let reported: number | undefined;
  await waitUntil(() => (reported = readPid(pidPath)) !== undefined, "the verifier fixture process to report its pid");
  if (reported === undefined) throw new Error("unreachable: waitUntil resolved without a pid");
  const pid = reported;

  const abortedAt = process.hrtime.bigint();
  controller.abort();
  await expect(running).rejects.toThrow(/cancelled/u);
  const elapsedMs = Number(process.hrtime.bigint() - abortedAt) / 1e6;

  // Load can only lengthen this, never shorten it: a rejection that arrives before the child's own
  // delayed exit could not have waited for the child. Timer granularity costs at most a millisecond.
  expect(elapsedMs).toBeGreaterThanOrEqual(TERMINATION_DELAY_MS - 1);
  // The child is gone by the time cancellation rejects; polling here only means an assertion
  // failure reports the surviving pid instead of the poll's own timeout.
  await waitUntil(() => !isRunning(pid), `verifier fixture process ${pid} to be reaped`);
  expect(isRunning(pid)).toBe(false);
});
