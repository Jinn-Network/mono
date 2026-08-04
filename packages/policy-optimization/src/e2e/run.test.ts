// SPDX-License-Identifier: MIT

/**
 * The operator entry point, exercised (program §6 touchpoint 3).
 *
 * `campaign.test.ts` owns the campaign's properties. This file owns one narrower claim: the
 * command a human is told to type actually runs, and its output carries the four things a reader
 * needs — the stages, the digests, the paths, and what the run does not prove. An entry point no
 * test drives is an entry point that is broken the next time anything moves.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { HONESTY_RESIDUALS } from "./campaign.js";
import {
  parseE2ECampaignArgs,
  runE2ECampaignCli,
  USAGE,
  type E2ECampaignCliOptions,
} from "./run.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "jinn-c9-cli-"));
  roots.push(root);
  return join(root, "campaign");
}

const lines: string[] = [];
const directory = scratchDirectory();
const exitCode = await runE2ECampaignCli({
  directory,
  write: (line) => lines.push(line),
});
const output = lines.join("\n");

describe("`yarn e2e:campaign` runs the whole campaign and says so", () => {
  test("it exits zero", () => {
    expect(exitCode).toBe(0);
  });

  test("every stage is narrated, in order, with its facts", () => {
    const numbered = lines.filter((line) => /^\[\s*\d+] /.test(line));
    expect(numbered.length).toBeGreaterThanOrEqual(10);
    expect(numbered.map((line) => Number(/^\[\s*(\d+)]/.exec(line)![1])))
      .toEqual(numbered.map((_, index) => index + 1));
  });

  test("the reader is given the artifacts, by path", () => {
    expect(output).toContain(join(directory, "journal.jsonl"));
    expect(output).toContain(join(directory, "archive", "derived", "projection.json"));
    expect(output).toContain(join(directory, "archive", "adoption.json"));
  });

  test("the result names a recommendation, its basis, and the closed phase", () => {
    expect(output).toMatch(/recommended policy : \S/);
    expect(output).toMatch(/basis {14}: signed Report sha256:[0-9a-f]{64}/);
    expect(output).toContain("campaign phase     : CLOSED");
  });

  test("the run prints what it does not prove, in full", () => {
    expect(output).toContain("What this run does NOT prove");
    // Wrapped for the terminal, so compare on collapsed whitespace rather than on the raw lines.
    const collapsed = output.replace(/\s+/g, " ");
    for (const residual of HONESTY_RESIDUALS) {
      expect(collapsed).toContain(residual.replace(/\s+/g, " "));
    }
  });

  test("no emoji reaches an operator surface (BRAND.md)", () => {
    expect(output).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(USAGE).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the arguments the usage text promises are the arguments it takes", () => {
  const options = (argv: readonly string[]): E2ECampaignCliOptions => {
    const parsed = parseE2ECampaignArgs(argv);
    if (parsed === "help") throw new Error(`${argv.join(" ")} asked for help`);
    return parsed;
  };

  test("--help short-circuits", () => {
    expect(parseE2ECampaignArgs(["--help"])).toBe("help");
    expect(parseE2ECampaignArgs(["-h"])).toBe("help");
  });

  test("--dir accepts both spellings and resolves to an absolute path", () => {
    expect(options(["--dir", "x"]).directory).toBe(join(process.cwd(), "x"));
    expect(options(["--dir=x"]).directory).toBe(join(process.cwd(), "x"));
  });

  test("--without-learner is a flag", () => {
    expect(options(["--without-learner"]).withoutLearner).toBe(true);
    expect(options([])).toEqual({});
  });

  test("an unrecognized argument refuses rather than being ignored", () => {
    expect(() => parseE2ECampaignArgs(["--dir"])).toThrow(/--dir needs a path/);
    expect(() => parseE2ECampaignArgs(["--wat"])).toThrow(/unrecognized argument/);
  });
});

describe("the campaign runs without the learner's candidate too", () => {
  test("the reference proposer alone still closes the loop", async () => {
    const only: string[] = [];
    const code = await runE2ECampaignCli({
      directory: scratchDirectory(),
      withoutLearner: true,
      write: (line) => only.push(line),
    });
    expect(code).toBe(0);
    expect(only.join("\n")).toContain("campaign phase     : CLOSED");
  });
});
