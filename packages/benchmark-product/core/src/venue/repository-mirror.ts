/**
 * The venue's bare-repository mirror cache (P1). A `repository-work` Task declares its repository
 * as a `ResourceDescriptor` carrying `uri` plus `annotations.ref` and nothing else — no `content`,
 * no `digest` (`@jinn-network/task-execution-profiles`'s `sweRebenchRowToTaskAndSpec`). The
 * platform's `materializeInput` writes a single FILE per descriptor, which is not a thing a coding
 * agent can work in, so the venue resolves the descriptor itself: one bare clone per upstream URI,
 * reused across every attempt, from which each attempt cuts its own detached worktree.
 *
 * The cache is keyed by URI and lives under the venue directory, so a run that touches the same
 * repository N times pays the clone once. `ensure` is the sole network-touching operation in the
 * venue; it is deliberately explicit rather than hidden behind an input-fetch port, because a
 * benchmark that silently reaches the network is a benchmark whose provenance nobody can audit.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OID_PATTERN = /^[0-9a-f]{40}$/u;
const SUPPORTED_SCHEMES = ["https://", "http://", "file://"];

export interface RepositoryMirrorPort {
  /** Absolute path to a bare git repository that contains `oid`. */
  ensure(input: { readonly uri: string; readonly oid: string }): Promise<string>;
}

/**
 * A filesystem-safe directory name for one upstream URI. The readable tail is convenience only;
 * the sha256 prefix is what makes it collision-resistant, so two upstreams that normalize to the
 * same tail still get separate mirrors.
 */
export function mirrorSlug(uri: string): string {
  const digest = createHash("sha256").update(uri).digest("hex").slice(0, 16);
  const tail = uri.replace(/\.git$/u, "").split("/").filter((part) => part.length > 0).pop() ?? "repo";
  return `${tail.replace(/[^A-Za-z0-9._-]/gu, "-")}-${digest}`;
}

/** Never through a shell: `execFile` with an argv array, so a URI can never become a command. */
async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function containsCommit(mirrorDir: string, oid: string): Promise<boolean> {
  try {
    return (await git(["-C", mirrorDir, "cat-file", "-t", oid])) === "commit";
  } catch {
    return false;
  }
}

/**
 * A directory only counts as a usable mirror if it is actually a bare git repository. A clone
 * interrupted mid-way (process killed, disk full) leaves a directory that exists but has no valid
 * object store and possibly no `origin` remote — `existsSync` alone can't tell the difference.
 */
async function isValidBareMirror(mirrorDir: string): Promise<boolean> {
  if (!existsSync(mirrorDir)) return false;
  try {
    return (await git(["-C", mirrorDir, "rev-parse", "--is-bare-repository"])) === "true";
  } catch {
    return false;
  }
}

export function createGitRepositoryMirror(rootDir: string): RepositoryMirrorPort {
  // Per-URI promise chain: every `resolve` call for a given URI — clone AND fetch — runs strictly
  // after the previous one settles, regardless of whether it succeeded or failed. This is what
  // keeps concurrent `ensure` calls for different oids on the same repository from running two
  // `git fetch` processes against one bare repo at once (they'd otherwise contend on
  // `packed-refs.lock`), while making sure one caller's failure (e.g. a bad oid) never poisons a
  // later caller asking for a different, valid oid on the same URI.
  const queues = new Map<string, Promise<unknown>>();
  function serialized<T>(uri: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(uri) ?? Promise.resolve();
    const next = previous.then(fn, fn); // run regardless of the previous outcome
    queues.set(
      uri,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function resolve(uri: string, oid: string): Promise<string> {
    const mirrorDir = join(rootDir, `${mirrorSlug(uri)}.git`);
    if (!(await isValidBareMirror(mirrorDir))) {
      if (existsSync(mirrorDir)) {
        // Not a valid bare repo (interrupted clone, stray directory): self-heal by re-cloning.
        await rm(mirrorDir, { recursive: true, force: true });
      }
      await mkdir(rootDir, { recursive: true });
      await git(["clone", "--bare", "--quiet", uri, mirrorDir]);
    }
    if (!(await containsCommit(mirrorDir, oid))) {
      // A mirror cloned before the commit existed upstream: refresh every head once, then re-check.
      await git(["-C", mirrorDir, "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
    }
    if (!(await containsCommit(mirrorDir, oid))) {
      throw new Error(`repository mirror for "${uri}" does not contain commit ${oid}`);
    }
    return mirrorDir;
  }

  return {
    async ensure({ uri, oid }) {
      if (!OID_PATTERN.test(oid)) {
        throw new Error(`repository-state ref must be exactly 40 lowercase hex characters, got "${oid}"`);
      }
      if (!SUPPORTED_SCHEMES.some((scheme) => uri.startsWith(scheme))) {
        throw new Error(`unsupported repository uri scheme: "${uri}"`);
      }
      return serialized(uri, () => resolve(uri, oid));
    },
  };
}
