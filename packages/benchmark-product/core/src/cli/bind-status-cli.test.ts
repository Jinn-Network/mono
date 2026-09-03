// SPDX-License-Identifier: Apache-2.0

/**
 * The human-readable `status` surface's binding halves (issue #3428).
 *
 * `--json` has carried `binding` and `bindableBeaconRounds` since #2976 and #3322; the text
 * rendering carried neither, so the affordance the web bind form got did not reach the CLI. The
 * assertions below are about the RENDERING only -- what the projection contains is
 * `../operations/run-bind.test.ts`'s subject -- so the workspace is driven to each of the two
 * states through the operations, and only `status` goes through `runCli`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { requiredBeaconRound } from "@colophon-claims/verify";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runBind } from "../operations/run-bind.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { sampleInit } from "../operations/sample.js";
import { readRunState } from "../run/state.js";
import { runCli } from "./main.js";

const VALUE = "b".repeat(64);

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bind-status-cli-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function opContext(clock: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock };
}

/** The locked, unlaunched, unbound draft both cases start from, and the round its seal names. */
async function setUpLockedDraft(clock: () => string): Promise<number> {
  initWorkspace(opContext(clock));
  createDraft(opContext(clock), { draftId: "draft-1", name: "Bind Status Test" });
  await sampleInit(opContext(clock), { draftId: "draft-1" });
  armAdd(opContext(clock), {
    draftId: "draft-1",
    armId: "baseline",
    pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } },
  });
  expect((await runQuote(opContext(clock), { draftId: "draft-1" })).ok).toBe(true);
  const locked = runLock(opContext(clock), { draftId: "draft-1" });
  if (!locked.ok) throw new Error("lock failed");
  const lockedAt = readRunState(workspaceDir, "draft-1")?.lockedAt;
  if (lockedAt === undefined) throw new Error("lock recorded no instant");
  return requiredBeaconRound("drand/quicknet", lockedAt)!.round;
}

const status = async (clock: () => string): Promise<string> =>
  (await runCli(["status", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1"], {
    cwd: workspaceDir,
    clock,
  })).stdout;

test("renders the bindable rounds while the run is locked, unlaunched and unbound", async () => {
  const clock = makeClock();
  const round = await setUpLockedDraft(clock);
  const stdout = await status(clock);
  // Naming the round is the whole affordance: a guess one round too low is refused for
  // postdating, and that refusal does not name the round the seal requires.
  expect(stdout).toContain(`bindable\tdrand/quicknet\tround ${round}`);
  expect(stdout).toMatch(/bindable\tdrand\/quicknet\tround \d+\tpublished 20\d\d-/u);
  expect(stdout).not.toContain("binding beacon-");
});

test("renders the binding statement once the run has bound, and drops the offer", async () => {
  const clock = makeClock();
  const round = await setUpLockedDraft(clock);
  const bound = runBind(opContext(clock), {
    draftId: "draft-1",
    beacon: { source: "drand/quicknet", round, value: VALUE },
  });
  if (!bound.ok) throw new Error("bind failed");

  const stdout = await status(clock);
  expect(stdout).toContain("binding beacon-ordering-only: ");
  // The face's own words, not a paraphrase -- an operator reading status sees the sentence a
  // reader of the run sees.
  expect(stdout).toContain(bound.result.statement);
  expect(stdout).not.toContain("bindable\t");
});
