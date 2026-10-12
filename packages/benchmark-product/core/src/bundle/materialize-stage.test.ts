/**
 * Staging survives a vanishing parent (issue #4941).
 *
 * A refused `publish` removes the EMPTY `public-bundles` directory on its way out, while a
 * concurrent publisher may be about to stage inside it. Creating the parent and the stage are two
 * filesystem calls, so a removal can land between them and surface as `ENOENT` from the stage's
 * `mkdir`. `node:fs` is wrapped here to raise exactly that error, because the window is
 * microseconds wide and cannot be hit on demand.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunState } from "../run/state.js";
import { materializePublicBundle } from "./materialize.js";

const stageFault = vi.hoisted(() => ({ failNext: 0, stageCalls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      if (String(args[0]).includes(".stage-")) {
        stageFault.stageCalls += 1;
        if (stageFault.failNext > 0) {
          stageFault.failNext -= 1;
          throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${String(args[0])}'`), { code: "ENOENT" });
        }
      }
      return actual.mkdirSync(...args);
    }) as typeof actual.mkdirSync,
  };
});

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-materialize-stage-"));
  stageFault.failNext = 0;
  stageFault.stageCalls = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** A RunState with no sealed identities: staging happens first, then the closure refuses it. */
const UNSEALED_RUN_STATE: RunState = { draftId: "draft-1", specSha256: "0".repeat(64), owner: "did:key:zTest" };

function materializeUnsealed(): void {
  materializePublicBundle({
    workspaceDir,
    draftId: "draft-1",
    benchmarkSha256: "1".repeat(64),
    runState: UNSEALED_RUN_STATE,
  });
}

describe("materializePublicBundle stage directory", () => {
  test("tries again when the parent vanishes between creating it and creating the stage", () => {
    stageFault.failNext = 1;
    // Reaching the closure's own refusal proves the stage was created on the second attempt.
    expect(materializeUnsealed).toThrow(/missing its Run, Matrix, Report/u);
    expect(stageFault.stageCalls).toBe(2);
  });

  test("gives up when the stage can never be created, rather than looping", () => {
    stageFault.failNext = 1_000;
    expect(materializeUnsealed).toThrow(/ENOENT/u);
    expect(stageFault.stageCalls).toBeGreaterThan(1);
    expect(stageFault.stageCalls).toBeLessThan(20);
  });
});
