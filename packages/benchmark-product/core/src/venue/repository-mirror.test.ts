import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRepositoryMirror, mirrorSlug } from "./repository-mirror.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/** A real, offline upstream repository with one commit. Returns `{uri, oid}`. */
function makeUpstream(): { uri: string; oid: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-product-upstream-"));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "upstream\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "initial");
  return { uri: `file://${dir}`, oid: git(dir, "rev-parse", "HEAD"), dir };
}

describe("mirrorSlug", () => {
  it("is a filesystem-safe, collision-resistant function of the uri", () => {
    expect(mirrorSlug("https://github.com/astropy/astropy")).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(mirrorSlug("https://github.com/a/b")).not.toBe(mirrorSlug("https://github.com/a/c"));
    expect(mirrorSlug("https://github.com/a/b")).toBe(mirrorSlug("https://github.com/a/b"));
  });
});

describe("createGitRepositoryMirror", () => {
  it("clones a bare mirror that contains the requested oid", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);

    const path = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });

    expect(git(path, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(path, "cat-file", "-t", upstream.oid)).toBe("commit");
  });

  it("reuses the same mirror directory on a second call for the same uri", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);

    const first = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });
    const second = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });

    expect(second).toBe(first);
  });

  it("refuses an oid that is not 40 lowercase hex characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);
    await expect(mirror.ensure({ uri: "file:///nowhere", oid: "HEAD" }))
      .rejects.toThrow(/40 lowercase hex/u);
  });

  it("refuses when the fetched mirror does not contain the requested oid", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);
    await expect(mirror.ensure({ uri: upstream.uri, oid: "0".repeat(40) }))
      .rejects.toThrow(/does not contain commit/u);
  });

  it("refuses a uri that is not http(s) or file", async () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);
    await expect(mirror.ensure({ uri: "ext::sh -c whoami", oid: "a".repeat(40) }))
      .rejects.toThrow(/unsupported repository uri scheme/u);
  });
});
