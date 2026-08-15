import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest } from "./harvest.js";
import type { WorkspacePaths } from "./contract.js";

async function workspace(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-harvest-"));
  const result = Object.fromEntries(["input", "work", "out", "logs", "harnessState", "secrets", "tmp", "meta"].map((name) => [name, join(root, name)]).concat([["root", root]])) as WorkspacePaths;
  await Promise.all([result.out, result.input, result.work, result.logs, result.harnessState, result.secrets, result.tmp, result.meta].map((path) => mkdir(path, { recursive: true })));
  return result;
}

describe("harvest", () => {
  it("records omissions and never dereferences a symlink escaping out", async () => {
    const paths = await workspace();
    await symlink(join(paths.secrets, "token"), join(paths.out, "creds"));
    const result = await harvest(paths, [{ name: "missing", mediaType: "text/plain", required: true }]);
    expect(result.omissions).toEqual(["missing"]);
    expect(result.integrityViolations).toEqual([{ path: "creds", reason: "symlink-escape" }]);
    expect(result.manifest).toEqual([]);
  });

  it("carries the Task-declared media type onto a harvested output", async () => {
    const paths = await workspace();
    await writeFile(join(paths.out, "patch"), "diff --git a/a b/a\n");

    const result = await harvest(paths, [
      { name: "patch", mediaType: "text/x-diff", required: true },
    ]);

    expect(result.manifest).toEqual([
      expect.objectContaining({ path: "patch", mediaType: "text/x-diff" }),
    ]);
  });

  it("is deterministic and sorts artifact paths by code unit", async () => {
    const paths = await workspace();
    await writeFile(join(paths.out, "a"), "a"); await writeFile(join(paths.out, "Z"), "z");
    expect((await harvest(paths, [])).manifest.map((entry) => entry.path)).toEqual(["Z", "a"]);
    expect(await harvest(paths, [])).toEqual(await harvest(paths, []));
  });

  it("recursively collects nested outputs and backend-owned logs as first-class artifacts", async () => {
    const paths = await workspace();
    await mkdir(join(paths.out, "nested"));
    await writeFile(join(paths.out, "nested", "answer.txt"), "answer");
    await writeFile(join(paths.logs, "stdout.log"), "out");
    await writeFile(join(paths.logs, "stderr.log"), "err");
    await writeFile(join(paths.logs, "transcript.ndjson"), "{}\n");
    expect((await harvest(paths, [])).manifest.map((entry) => entry.path)).toEqual([
      "logs/stderr.log", "logs/stdout.log", "logs/transcript.ndjson", "nested/answer.txt",
    ]);
  });

  it("rejects a nested escaping symlink without dereferencing it", async () => {
    const paths = await workspace();
    await mkdir(join(paths.out, "nested"));
    await writeFile(join(paths.secrets, "token"), "must-not-leak");
    await symlink(join(paths.secrets, "token"), join(paths.out, "nested", "token"));
    const result = await harvest(paths, [{ name: "nested/missing", mediaType: "text/plain", required: true }]);
    expect(result.integrityViolations).toContainEqual({ path: "nested/token", reason: "symlink-escape" });
    expect(result.omissions).toEqual(["nested/missing"]);
    expect(result.manifest).toEqual([]);
  });
});
