import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeGitTreeSha } from "./git-tree-sha.js";

let root: string;
let material: string;
let gitDir: string;

/** Hermetic git: no user, global, or system config may reach the fixture. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: material,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(argv: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.fileMode=true", ...argv], {
    cwd: material,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.status !== 0) throw new Error(`git ${argv.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout.trim();
}

/** The expected value is derived by real git, never hardcoded. */
function gitWriteTree(): string {
  git(["init", "-q"]);
  git(["add", "-A"]);
  return git(["write-tree"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-tree-sha-"));
  material = join(root, "tasks");
  gitDir = join(root, "git");
  mkdirSync(material, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("computeGitTreeSha", () => {
  test("matches git write-tree on a nested fixture with executables, prefix collisions, and an empty directory", () => {
    // `a.txt` vs the `a/` tree exercises git's trailing-slash sort key: 0x2e sorts before 0x2f.
    writeFileSync(join(material, "a.txt"), "a\n");
    mkdirSync(join(material, "a"), { recursive: true });
    writeFileSync(join(material, "a", "task.toml"), '[task]\nname = "a"\n');
    mkdirSync(join(material, "a", "environment"), { recursive: true });
    writeFileSync(join(material, "a", "environment", "Dockerfile"), "FROM scratch\n");
    const script = join(material, "a", "environment", "run.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    mkdirSync(join(material, "B"), { recursive: true });
    writeFileSync(join(material, "B", "task.toml"), '[task]\nname = "B"\n');
    writeFileSync(join(material, "zzz"), "");
    // git records no empty tree, so neither may we.
    mkdirSync(join(material, "empty"), { recursive: true });

    expect(computeGitTreeSha(material)).toBe(gitWriteTree());
  });

  test("a one-byte edit changes the tree SHA and still matches git", () => {
    writeFileSync(join(material, "task.toml"), '[task]\nname = "t"\n');
    const before = computeGitTreeSha(material);
    expect(before).toBe(gitWriteTree());
    rmSync(gitDir, { recursive: true, force: true });
    writeFileSync(join(material, "task.toml"), '[task]\nname = "u"\n');
    const after = computeGitTreeSha(material);
    expect(after).not.toBe(before);
    expect(after).toBe(gitWriteTree());
  });

  test("the executable bit is part of the tree SHA", () => {
    const script = join(material, "run.sh");
    writeFileSync(script, "#!/bin/sh\n");
    chmodSync(script, 0o644);
    const plain = computeGitTreeSha(material);
    expect(plain).toBe(gitWriteTree());
    rmSync(gitDir, { recursive: true, force: true });
    chmodSync(script, 0o755);
    const executable = computeGitTreeSha(material);
    expect(executable).not.toBe(plain);
    expect(executable).toBe(gitWriteTree());
  });

  test("an empty directory hashes to git's empty tree and symlinks are refused", () => {
    expect(computeGitTreeSha(material)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    writeFileSync(join(material, "task.toml"), "");
    symlinkSync(join(material, "task.toml"), join(material, "link.toml"));
    expect(() => computeGitTreeSha(material)).toThrow(/refuses symlink/u);
  });
});
