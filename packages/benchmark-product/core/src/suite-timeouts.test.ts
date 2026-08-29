// Guards the per-test bound this suite runs under (issue #2766). Vitest's 5000ms default is wall
// clock, so a worker that is descheduled spends it without doing work -- and this suite
// deliberately co-schedules sub-millisecond cases with files that write and spawn real executables
// and with one case that held a worker for 2,165,911ms of a 2,690s CI run. Under that load the
// default produced false reds that wandered across unrelated files with no code change.
//
// `task.timeout` is what actually governs the running test, so that is what is asserted; the
// config text is read only for `hookTimeout`, which has no runtime equivalent to read back.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The bound the suite config commits to, and the floor this gate holds it above. */
const SUITE_TIMEOUT_FLOOR_MS = 30_000;

const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../vitest.config.ts");

describe("suite timeouts (#2766)", () => {
  test("a test runs under a bound raised above Vitest's 5s default", ({ task }) => {
    expect(task.timeout).toBeGreaterThanOrEqual(SUITE_TIMEOUT_FLOOR_MS);
  });

  test("hooks carry the same bound", () => {
    const declared = /hookTimeout:\s*([0-9_]+)/u.exec(readFileSync(configPath, "utf8"))?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared?.replaceAll("_", ""))).toBeGreaterThanOrEqual(SUITE_TIMEOUT_FLOOR_MS);
  });
});
