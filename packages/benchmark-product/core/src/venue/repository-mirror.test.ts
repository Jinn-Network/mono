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

/** Adds one more commit to an existing upstream working tree and returns its oid. */
function addCommit(dir: string, filename: string): string {
  writeFileSync(join(dir, filename), `${filename}\n`);
  git(dir, "add", filename);
  git(dir, "commit", "--quiet", "-m", filename);
  return git(dir, "rev-parse", "HEAD");
}

describe("mirrorSlug", () => {
  it("is a filesystem-safe, collision-resistant function of the uri", () => {
    expect(mirrorSlug("https://github.com/astropy/astropy")).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(mirrorSlug("https://github.com/a/b")).not.toBe(mirrorSlug("https://github.com/a/c"));
    expect(mirrorSlug("https://github.com/a/b")).toBe(mirrorSlug("https://github.com/a/b"));
  });

  it("does not collide when the readable tail matches but the host differs", () => {
    // The tail alone (`a/b`) is identical for both — only the sha256 prefix can tell them apart.
    expect(mirrorSlug("https://github.com/a/b")).not.toBe(mirrorSlug("https://gitlab.com/a/b"));
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

  it("serializes concurrent ensure calls for different oids on one uri instead of racing git fetch", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);

    // Warm the mirror first — the realistic SWE-bench-shaped case: one repository, many attempts,
    // each needing a different base commit that arrives *after* the mirror already exists.
    const mirrorDir = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });
    const oidB = addCommit(upstream.dir, "b.txt");
    const oidC = addCommit(upstream.dir, "c.txt");
    const oidD = addCommit(upstream.dir, "d.txt");

    // None of these oids are in the mirror yet, so all three callers must discover that and
    // fetch. Unserialized, this issues concurrent `git fetch` into one bare repo and fails with
    // "Unable to create '.../packed-refs.lock': File exists".
    const results = await Promise.all([
      mirror.ensure({ uri: upstream.uri, oid: oidB }),
      mirror.ensure({ uri: upstream.uri, oid: oidC }),
      mirror.ensure({ uri: upstream.uri, oid: oidD }),
    ]);

    expect(results).toEqual([mirrorDir, mirrorDir, mirrorDir]);
    expect(git(mirrorDir, "cat-file", "-t", oidB)).toBe("commit");
    expect(git(mirrorDir, "cat-file", "-t", oidC)).toBe("commit");
    expect(git(mirrorDir, "cat-file", "-t", oidD)).toBe("commit");
  });

  it("does not let a rejected ensure call poison a concurrent good ensure call on the same uri", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);

    // Kick both off before either settles: the second caller must not be rejected with the
    // first caller's error just because it happened to be queued behind it on the same uri.
    const bad = mirror.ensure({ uri: upstream.uri, oid: "0".repeat(40) });
    const good = mirror.ensure({ uri: upstream.uri, oid: upstream.oid });

    await expect(bad).rejects.toThrow(/does not contain commit/u);
    const path = await good;
    expect(git(path, "cat-file", "-t", upstream.oid)).toBe("commit");
  });

  it("does not let a rejected ensure call poison a later, sequential good ensure call on the same uri", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirror = createGitRepositoryMirror(root);

    await expect(mirror.ensure({ uri: upstream.uri, oid: "0".repeat(40) }))
      .rejects.toThrow(/does not contain commit/u);

    const path = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });
    expect(git(path, "cat-file", "-t", upstream.oid)).toBe("commit");
  });

  it("self-heals when the mirror directory exists but is not a valid bare repository", async () => {
    const upstream = makeUpstream();
    const root = mkdtempSync(join(tmpdir(), "benchmark-product-mirror-"));
    const mirrorDir = join(root, `${mirrorSlug(upstream.uri)}.git`);
    // Simulate a clone interrupted mid-way: the directory exists but has no valid object store.
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "not-a-repo.txt"), "corrupt\n");

    const mirror = createGitRepositoryMirror(root);
    const path = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });

    expect(path).toBe(mirrorDir);
    expect(git(path, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(path, "cat-file", "-t", upstream.oid)).toBe("commit");
  });
});
