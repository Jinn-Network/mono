import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeDirProvisioner } from "./dir-provisioner.js";
import { ProvisioningRejectedError } from "./dir-provisioner.js";
import type { TaskView, WorkspacePaths } from "./index.js";

const view = { task: { inputs: [] }, profile: { profile: "https://jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const runtime = { assertHarnessGroupEmpty: () => undefined, ensureMetaReserve: () => undefined };

async function paths(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-workspace-"));
  return Object.fromEntries(["input", "work", "out", "logs", "harnessState", "secrets", "tmp", "meta"].map((name) => [name, join(root, name)]).concat([["root", root]])) as WorkspacePaths;
}

describe("directory provisioner", () => {
  it("creates the complete directory contract with a private secrets directory", async () => {
    const target = await paths();
    await makeDirProvisioner({ sealedTaskBytes: Buffer.from('{"task":true}'), dispatchContextBytes: Buffer.from("{}"), runtime }).setup(view, target, []);
    for (const directory of [target.input, target.work, target.out, target.logs, target.harnessState, target.secrets, target.tmp, target.meta]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
    expect((await stat(target.secrets)).mode & 0o777).toBe(0o700);
  });

  it("writes sealed Task bytes verbatim and rejects fetched digest corruption", async () => {
    const target = await paths();
    const bytes = Buffer.from("sealed bytes are material");
    await makeDirProvisioner({ sealedTaskBytes: bytes, dispatchContextBytes: Buffer.from("{}"), runtime }).setup(view, target, []);
    expect(await readFile(join(target.input, "task.sealed"))).toEqual(bytes);
    const viewWithInput = { ...view, task: { inputs: [{ name: "source", digest: { sha256: "0".repeat(64) } }] } } as unknown as TaskView;
    await expect(makeDirProvisioner({ sealedTaskBytes: bytes, dispatchContextBytes: Buffer.from("{}"), runtime, fetchInput: async () => Buffer.from("wrong") }).setup(viewWithInput, await paths(), []))
      .rejects.toBeInstanceOf(ProvisioningRejectedError);
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  });

  it("gates harvest and reports input mutation from its setup snapshot", async () => {
    const target = await paths();
    let empty = false;
    const provisioner = makeDirProvisioner({ sealedTaskBytes: Buffer.from("sealed"), dispatchContextBytes: Buffer.from("{}"), runtime: { assertHarnessGroupEmpty: () => { if (!empty) throw new Error("group-live"); }, ensureMetaReserve: () => undefined } });
    await provisioner.setup(view, target, []);
    await expect(provisioner.harvest(target, [])).rejects.toThrow("group-live");
    empty = true;
    await chmod(join(target.input, "task.sealed"), 0o600);
    await writeFile(join(target.input, "task.sealed"), "mutated");
    expect((await provisioner.harvest(target, [])).integrityViolations).toContainEqual({ path: "task.sealed", reason: "input-mutated" });
  });
});
