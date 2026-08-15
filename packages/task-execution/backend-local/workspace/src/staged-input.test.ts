import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeDirProvisioner } from "./dir-provisioner.js";
import {
  STAGED_DISPATCH_CONTEXT_FILENAME,
  STAGED_SEALED_TASK_FILENAME,
} from "./staged-input.js";
import type { TaskView } from "./task-view.js";
import type { WorkspacePaths } from "./contract.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("staged input contract (#2538)", () => {
  /**
   * The constant is the single source, but its VALUE is not free. `evidence-join` records the
   * staged Task under the entity id `input/task.sealed`, so the string appears in published
   * evidence records; changing it is an evidence-format change, not a rename. This pin makes that
   * a deliberate edit rather than a silent one.
   */
  it("pins the staged filenames the evidence record embeds", () => {
    expect(STAGED_SEALED_TASK_FILENAME).toBe("task.sealed");
    expect(STAGED_DISPATCH_CONTEXT_FILENAME).toBe("dispatch-context.json");
  });

  it("stages the sealed Task at exactly the contracted names", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-staged-input-"));
    roots.push(root);
    const paths = {
      root,
      input: join(root, "input"),
      work: join(root, "work"),
      out: join(root, "out"),
      logs: join(root, "logs"),
      harnessState: join(root, "harness-state"),
      secrets: join(root, "secrets"),
      tmp: join(root, "tmp"),
      meta: join(root, "meta"),
    } as WorkspacePaths;
    await makeDirProvisioner({
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      runtime: { assertHarnessGroupEmpty: () => undefined, ensureMetaReserve: () => undefined },
    }).setup({ task: { instructions: "x", outputs: [] } } as unknown as TaskView, paths, []);

    expect((await readdir(paths.input)).sort()).toStrictEqual(
      [STAGED_DISPATCH_CONTEXT_FILENAME, STAGED_SEALED_TASK_FILENAME].sort(),
    );
  });
});
