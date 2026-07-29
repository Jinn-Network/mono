import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeDirProvisioner } from "./dir-provisioner.js";
import { ProvisioningRejectedError } from "./dir-provisioner.js";
import type { TaskView, WorkspacePaths } from "./index.js";

const view = { task: { inputs: [] }, profile: { profile: "https://jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;

async function paths(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-workspace-"));
  return Object.fromEntries(["input", "work", "out", "logs", "harnessState", "secrets", "tmp", "meta"].map((name) => [name, join(root, name)]).concat([["root", root]])) as WorkspacePaths;
}

describe("directory provisioner", () => {
  it("creates the complete directory contract with a private secrets directory", async () => {
    const target = await paths();
    await makeDirProvisioner({ sealedTaskBytes: Buffer.from('{"task":true}') }).setup(view, target, []);
    for (const directory of [target.input, target.work, target.out, target.logs, target.harnessState, target.secrets, target.tmp, target.meta]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
    expect((await stat(target.secrets)).mode & 0o777).toBe(0o700);
  });

  it("writes sealed Task bytes verbatim and rejects fetched digest corruption", async () => {
    const target = await paths();
    const bytes = Buffer.from("sealed bytes are material");
    await makeDirProvisioner({ sealedTaskBytes: bytes }).setup(view, target, []);
    expect(await readFile(join(target.input, "task.sealed"))).toEqual(bytes);
    const viewWithInput = { ...view, task: { inputs: [{ name: "source", digest: { sha256: "0".repeat(64) } }] } } as unknown as TaskView;
    await expect(makeDirProvisioner({ fetchInput: async () => Buffer.from("wrong") }).setup(viewWithInput, await paths(), []))
      .rejects.toBeInstanceOf(ProvisioningRejectedError);
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  });
});
