// Guards the per-test bound this suite runs under (issue #2766). Vitest's 5000ms default is wall
// clock, so a worker that is descheduled spends it without doing work — and this suite
// deliberately co-schedules sub-millisecond cases with files that write and spawn real executables
// and with one case that held a worker for 2,165,911ms of a 2,690s CI run. Under that load the
// default produced false reds that wandered across unrelated files with no code change.
//
// `task.timeout` is what actually governs the running test, so that is what is asserted.
// `hookTimeout` has no runtime equivalent to read back and the config cannot be imported from
// here (it sits outside this package's `rootDir`), so it is read out of the config source — as a
// declaration line, not as a token, so a commented-out setting cannot satisfy this.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The bound the suite config commits to, and the floor this gate holds it above. */
const SUITE_TIMEOUT_FLOOR_MS = 30_000;

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(sourceRoot, "../vitest.config.ts");

/** A per-test bound that only restates the config's own default, with where to delete it. */
interface RedundantBound {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Every `.test.ts` under this package's `src`. Resolved from this file's own directory — which
 * *is* `src` — rather than from `cwd`, so the scan is the same whether vitest is invoked from
 * the package root or the repo root. The config's other include,
 * `../../../test-support/tmp-isolation/*.test.ts`, is shared code outside this package and is
 * deliberately out of scope: this rule is about the bound *this* config declares.
 */
function packageTestFiles(): readonly string[] {
  return readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort();
}

/**
 * The two spellings a redundant bound arrives in, both anchored to a whole line:
 *
 *     }, 30_000);          // A — the closing argument of a single-line `test(…)` call
 *         30_000,          // B — the final argument on its own line of a multiline call
 *
 * Anchoring is the whole design. A bare numeric literal alone on a line is only ever a call
 * argument, so the shapes that carry this literal legitimately are excluded structurally rather
 * than by luck: `const CONTAINER_REAP_BUDGET_MS = 30_000;` has a declaration, `timeout: 30_000,`
 * and `solveStartDelayMsForTesting: 30_000,` have a key, and `urn:uuid:30000000-…` has
 * neighbors. All four live in the scanned tree today, which is what makes this test passing on
 * a clean tree the negative proof rather than an assumption.
 *
 * Both shapes tolerate a trailing line comment, and that is not cosmetic. Anchoring hard at
 * `$` would mean the single most natural way of re-adding a bound — writing the justification
 * next to it, `}, 30_000); // flaky on CI` — slipped past both patterns, which is the one
 * spelling this guard most needs to catch. Tolerating the comment is also what gives the pin
 * below its teeth: without it the marker would be redundant, because any comment at all already
 * bought an exemption.
 *
 * The gap, stated rather than left to be assumed: the options-object spelling
 * `test("n", { timeout: 30_000 }, fn)` evades both patterns. No test here uses it and every
 * instance of this class has arrived as A or B, so covering a spelling with no history would be
 * speculation. A bare `30_000,` argument to some non-test helper is the symmetric residual, and
 * the pin below is its one-line answer.
 */
function redundantBoundPatterns(value: number): readonly RegExp[] {
  const literal = `(?:${value}|${String(value).replace(/\B(?=(\d{3})+$)/gu, "_")})`;
  const trailing = String.raw`\s*(?://.*)?$`;
  return [
    new RegExp(`^\\s*\\}, *${literal}\\);?${trailing}`, "u"),
    new RegExp(`^\\s*${literal},?${trailing}`, "u"),
  ];
}

/**
 * An escape hatch, because a guard with none gets deleted the first time someone genuinely needs
 * a bound of exactly the suite default. It sits on the offending line so it cannot drift from
 * what it excuses, and it takes a reason:
 *
 *     }, 30_000); // suite-timeout-pin: <why this bound must be exactly the suite default>
 */
const PIN_MARKER = "suite-timeout-pin:";

function findRedundantBounds(value: number): readonly RedundantBound[] {
  const patterns = redundantBoundPatterns(value);
  const found: RedundantBound[] = [];
  for (const file of packageTestFiles()) {
    const lines = readFileSync(join(sourceRoot, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (text.includes(PIN_MARKER)) return;
      if (patterns.some((pattern) => pattern.test(text))) {
        found.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

function declaredTimeout(source: string, key: string): number {
  const declared = new RegExp(`^\\s*${key}:\\s*([0-9_]+),$`, "mu").exec(source)?.[1];
  expect(declared).toBeDefined();
  return Number(declared?.replaceAll("_", ""));
}

describe("suite timeouts (#2766)", () => {
  test("a test runs under a bound raised above Vitest's 5s default", ({ task }) => {
    expect(task.timeout).toBeGreaterThanOrEqual(SUITE_TIMEOUT_FLOOR_MS);
  });

  test("hooks carry the same bound", () => {
    const declared = /^\s*hookTimeout:\s*([0-9_]+),$/mu.exec(readFileSync(configPath, "utf8"))?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared?.replaceAll("_", ""))).toBeGreaterThanOrEqual(SUITE_TIMEOUT_FLOOR_MS);
  });

  // The class this config exists to end reaccumulates: #3358 hoisted 114 overrides into
  // `testTimeout`, #3703 swept the survivors, and 35 more had arrived by 2026-09-06 — a dozen of
  // them after that sweep merged. Restating the default per test is not merely redundant, it
  // re-pins 7 files to a number the config can no longer move for them. So the comparison value
  // is read from the config source rather than hardcoded: raise the config to 45s and this
  // starts failing `45_000` overrides, while a `30_000` bound becomes a legitimate tightening
  // below the default and correctly stops being one.
  test("no test restates the suite default as its own bound", () => {
    const declared = declaredTimeout(readFileSync(configPath, "utf8"), "testTimeout");
    const files = packageTestFiles();
    // Without this the assertion below passes vacuously if the scan ever stops finding the tree.
    expect(files.length).toBeGreaterThan(100);
    const redundant = findRedundantBounds(declared);
    // Every offender by `file:line`, because the fix is per site rather than a count.
    expect(redundant.map(({ file, line, text }) => `src/${file}:${line}: ${text}`)).toEqual([]);
  });
});
