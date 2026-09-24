// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOVE_BUDGET_MS, removeAttemptTree } from "./attempt-tree-teardown.js";

const dirs: string[] = [];

afterEach(() => {
  const deadline = Date.now() + REMOVE_BUDGET_MS;
  for (const dir of dirs.splice(0)) removeAttemptTree(dir, deadline);
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
