# P1 — Venue Profile Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the benchmark product's local venue admit `repository-work/1.0` Tasks end-to-end for solve legs — resolve the profile, advertise it in capabilities, select a provisioner that materializes a real checked-out repository, run a real subprocess arm against it, and harvest the declared `patch` output — while the prediction-forecast sample stays byte-for-byte identical.

**Architecture:** The venue's profile seam is five sites (profile resolution, provisioner capabilities, provisioner selection, launcher `taskProfiles`, and the backend's intersection of the last two). Today only two profile URIs pass all five. This packet adds a third by: (1) a product-owned repository-work provisioner that materializes the Task's declared `repository-state` descriptor as a detached git worktree at `paths.work` via a venue-held bare-repo mirror cache; (2) a product-bundled hermetic `sample-repository-work` launcher, mirroring the blessed `sample-uniform` precedent, so the profile has a CI-safe arm with no external binary; (3) the five-site wiring in `venue.ts`. The evaluation leg for repository-work is deliberately out of scope (P3 owns container grading) and must refuse typed, not crash.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22, Vitest 4, Yarn 4.13.0 workspaces with `portal:` cross-tree deps. Platform packages consumed: `@jinn-network/task-execution-{protocol,profiles,workspace,launchers,backend-local,supervisor}`.

## Global Constraints

- **Base branch:** `integration/evidence-v1`. Packet branch: `claude/demo1-p1-venue-profiles`. One PR, title prefix `feat(benchmark-product):`.
- **Verified baseline (head `04f309de8`):** the 22-package portal chain from `.github/workflows/benchmark-product-ci.yml:67-92` builds green; `packages/benchmark-product/core` `yarn typecheck` + `yarn test` is **green with zero pre-existing failures**. Any red is ours.
- **American English** in identifiers, file names, and user-facing copy.
- **Never touch** `packages/benchmark-product/core/src/intake/swebench.ts` or `packages/benchmarking/interop/src/import/swebench.ts` — C4's P0-interop packet owns them (cluster-key fix, product-side spec re-seal, `created_at` threading). Consume them read-only.
- **Never assert a sealed Task digest produced by the SWE-bench importer.** C4's in-flight changes will move those digests. Tests that need a `repository-work` Task build it directly with `sealTask` + `buildRepositoryWorkProfile`.
- **No new env vars.** Configuration is explicit options only.
- **Prediction sample byte-stability is an acceptance criterion, not a hope.** `venue.integration.test.ts`, `run-quote.test.ts`, `quote-presentation.test.ts`, `run-path.integration.test.ts`, `cli-lifecycle.integration.test.ts`, `public-quickstart.test.ts` must pass **unmodified**.
- **Commands run from `packages/benchmark-product/core`** unless stated. Targeted test form (matches CI's own usage at `benchmark-product-ci.yml:90`): `yarn vitest run <path>`.
- **No agent self-merge.** The operator merges the packet PR after independent review.

## Deviation from the approved D1 design — read before Task 3

The approved recon recommendation was "mirror-cache **+ delegate to `makeWorktreeProvisioner`**, including authoring production `WorkspaceRuntimePorts`." Closer reading of the delegation target changes that call, and this plan implements the leaner alternative:

- `makeWorktreeProvisioner` (`packages/task-execution/backend-local/workspace/src/worktree-provisioner.ts:17-37`) is `makeDirProvisioner` plus a `setup` override. Reaching it drags in `DirProvisionerOptions.runtime: WorkspaceRuntimePorts` (`dir-provisioner.ts:21-28`), whose `assertHarnessGroupEmpty` and `ensureMetaReserve` have real process-group and disk-reserve semantics the product has no business implementing. **No production implementation of those ports exists anywhere in the repo** — the only ones are test doubles in `packages/task-execution/testing/`.
- Worse, `makeDirProvisioner.setup` materializes `view.task.inputs` through `materializeInput` (`dir-provisioner.ts:113`), which writes a **single file** per descriptor. Our `repository-state` descriptor would land as a junk file at `input/repository-state` unless the view is filtered before delegation.
- The product's two existing provisioner contracts are already hand-built for exactly this reason — see the `venue/provisioner.ts` module header and the `sample-uniform.ts` header ("the platform intentionally exposes no non-public helpers to import, so this is a small, self-contained reimplementation rather than a reuse of platform internals").

**Decision:** reimplement the ~12 lines of git checkout logic in the product, matching the established in-tree precedent, and drop the `WorkspaceRuntimePorts` task entirely. This is a scope *reduction* (≈ −0.5 agent-days) and removes a class of runtime-semantics risk. It has been flagged to the program coordinator; if overruled, Task 3 changes shape and Task 0 (author production `WorkspaceRuntimePorts`) is added back.

## File Structure

**Create:**
- `packages/benchmark-product/core/src/venue/repository-mirror.ts` — the `RepositoryMirrorPort` interface and `createGitRepositoryMirror`, a bare-clone cache keyed by descriptor URI. Sole responsibility: turn `{uri, oid}` into a local path to a bare repo that contains `oid`.
- `packages/benchmark-product/core/src/venue/repository-mirror.test.ts`
- `packages/benchmark-product/core/src/venue/sample-repository-work.ts` — the hermetic `sample-repository-work` launcher. Sole responsibility: a real `node -e` subprocess that proves the worktree materialized and emits a deterministic `patch`.
- `packages/benchmark-product/core/src/venue/sample-repository-work.test.ts`
- `packages/benchmark-product/core/src/venue/repository-work.integration.test.ts` — venue-level solve leg: submit → dispatch → deliver → harvested `patch`.

**Modify:**
- `packages/benchmark-product/core/src/venue/provisioner.ts` — add `repositoryWorkProvisionerContract` and the site-C selector arm.
- `packages/benchmark-product/core/src/venue/venue.ts` — sites A, B, and the launcher + `launcherDeployments` registration that makes site E's intersection non-empty.
- `packages/benchmark-product/core/src/venue/venue.test.ts` — profile resolution accepts repository-work, still refuses unknown.
- `packages/benchmark-product/core/src/operations/quote-presentation.test.ts` — extend the coverage↔errors cross-check to a repository-work arm.

**Read-only, do not edit:** `intake/swebench.ts`, `interop/src/import/swebench.ts`, every platform package.

---

### Task 1: Repository mirror port

**Files:**
- Create: `packages/benchmark-product/core/src/venue/repository-mirror.ts`
- Test: `packages/benchmark-product/core/src/venue/repository-mirror.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface RepositoryMirrorPort { ensure(input: { readonly uri: string; readonly oid: string }): Promise<string>; }` — resolves to an absolute path to a **bare** git repository containing `oid`.
  - `export function createGitRepositoryMirror(rootDir: string): RepositoryMirrorPort`
  - `export function mirrorSlug(uri: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/benchmark-product/core/src/venue/repository-mirror.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/venue/repository-mirror.test.ts`
Expected: FAIL — `Failed to resolve import "./repository-mirror.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/benchmark-product/core/src/venue/repository-mirror.ts`:

```ts
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
import { mkdir } from "node:fs/promises";
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

export function createGitRepositoryMirror(rootDir: string): RepositoryMirrorPort {
  const inFlight = new Map<string, Promise<string>>();

  async function resolve(uri: string, oid: string): Promise<string> {
    const mirrorDir = join(rootDir, `${mirrorSlug(uri)}.git`);
    if (!existsSync(mirrorDir)) {
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
      // One clone per URI even when several attempts race for the same repository.
      const pending = inFlight.get(uri);
      if (pending !== undefined) {
        const path = await pending;
        return (await containsCommit(path, oid)) ? path : resolve(uri, oid);
      }
      const started = resolve(uri, oid);
      inFlight.set(uri, started);
      try {
        return await started;
      } catch (error) {
        inFlight.delete(uri);
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/venue/repository-mirror.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/venue/repository-mirror.ts packages/benchmark-product/core/src/venue/repository-mirror.test.ts
git commit -m "feat(benchmark-product): venue bare-repository mirror cache for repository-work inputs"
```

---

### Task 2: The hermetic `sample-repository-work` launcher

**Files:**
- Create: `packages/benchmark-product/core/src/venue/sample-repository-work.ts`
- Test: `packages/benchmark-product/core/src/venue/sample-repository-work.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const SAMPLE_REPOSITORY_WORK_LAUNCHER_ID = "sample-repository-work"`
  - `export const SAMPLE_REPOSITORY_WORK_HARNESS_VERSION = "0.1.0"`
  - `export const SAMPLE_REPOSITORY_WORK_RUNNER_SOURCE: string`
  - `export function makeSampleRepositoryWorkLauncher(options?: { readonly probe?: () => Promise<ProbeResult> }): LauncherContract`
  - `export const sampleRepositoryWorkLauncher: LauncherContract`

**Why this exists:** site E (`packages/task-execution/backend-local/assembly/src/capabilities.ts:63-75`) intersects the provisioner's `taskProfiles` with the union of the registered launchers'. Every launcher the venue registers today declares prediction-forecast or evaluation-task only, so `repository-work/1.0` would never reach capabilities no matter what site B says. The platform's real coding-agent launchers do declare it (`launchers/src/planning.ts:70-78`), but they need an external binary and are P2's subject. This is the CI-safe arm that lets P1 be verified on its own, and it doubles as P5's control arm. It mirrors `./sample-uniform.ts` exactly.

- [ ] **Step 1: Write the failing test**

Create `packages/benchmark-product/core/src/venue/sample-repository-work.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { REPOSITORY_WORK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  makeSampleRepositoryWorkLauncher,
  SAMPLE_REPOSITORY_WORK_HARNESS_VERSION,
  SAMPLE_REPOSITORY_WORK_LAUNCHER_ID,
} from "./sample-repository-work.js";

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000000",
  nonce: "n",
  attemptNumber: 1,
};

function paths(root: string): WorkspacePaths {
  return {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
}

function view(effectiveRequirements: Record<string, unknown>): TaskView {
  return { task: {} as TaskView["task"], effectiveRequirements, profile: {} as TaskView["profile"] };
}

/** Runs the launcher's real planned argv, exactly as the supervisor would. */
function runPlan(root: string, sealedTask: unknown, workFiles: Record<string, string>) {
  const p = paths(root);
  for (const dir of [p.input, p.work, p.out, p.logs, p.meta, p.tmp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(p.input, "task.sealed"), JSON.stringify(sealedTask));
  for (const [name, contents] of Object.entries(workFiles)) writeFileSync(join(p.work, name), contents);

  const plan = makeSampleRepositoryWorkLauncher().plan(view({}), p, ATTEMPT);
  const result = execFileSync(plan.argv[0]!, plan.argv.slice(1), {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { paths: p, stdout: result };
}

const REPOSITORY_WORK_TASK = { profile: { uri: REPOSITORY_WORK_PROFILE_URI }, payload: { instance_id: "demo__demo-1" } };

describe("makeSampleRepositoryWorkLauncher", () => {
  it("has the expected id and static capabilities", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(launcher.id).toBe(SAMPLE_REPOSITORY_WORK_LAUNCHER_ID);
    const capabilities = launcher.capabilities();
    expect(capabilities.taskProfiles).toEqual([REPOSITORY_WORK_PROFILE_URI]);
    expect(capabilities.outputMediaTypes).toContain("text/x-diff");
    expect(capabilities.runPinning.keys).toEqual([
      { key: "harness", inventory: [SAMPLE_REPOSITORY_WORK_LAUNCHER_ID], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
    ]);
  });

  it("defaults probe to ready:true when not configured", async () => {
    await expect(makeSampleRepositoryWorkLauncher().probe!()).resolves.toEqual({ ready: true });
  });

  it("plans a node -e invocation whose cwd is the work tree", () => {
    const plan = makeSampleRepositoryWorkLauncher().plan(view({}), paths("/x"), ATTEMPT);
    expect(plan.argv[0]).toBe(process.execPath);
    expect(plan.argv[1]).toBe("-e");
    expect(typeof plan.argv[2]).toBe("string");
    expect(plan.cwd).toBe("/x/work");
  });

  it("throws when a harness pin selects a different launcher", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(() => launcher.plan(view({ harness: { id: "sample-uniform" } }), paths("/x"), ATTEMPT))
      .toThrow(/harness pin does not select this launcher/u);
  });

  it("throws on an unsupported isolationPolicy", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(() => launcher.plan(view({ isolationPolicy: "sandboxed" }), paths("/x"), ATTEMPT))
      .toThrow(/unsupported isolationPolicy/u);
  });

  it("writes a unified diff to out/patch and a structured envelope alongside it", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-"));
    const { paths: p } = runPlan(root, REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });

    const patch = readFileSync(join(p.out, "patch"), "utf8");
    expect(patch).toContain("--- a/README.md");
    expect(patch).toContain("+++ b/README.md");
    expect(patch).toContain("+sample-repository-work");

    const envelope = JSON.parse(readFileSync(join(p.out, "structured-output.json"), "utf8")) as {
      status: string; harnessVersion: string;
    };
    expect(envelope.status).toBe("success");
    expect(envelope.harnessVersion).toBe(SAMPLE_REPOSITORY_WORK_HARNESS_VERSION);
  });

  it("is deterministic: the same work tree produces byte-identical patches", () => {
    const first = runPlan(mkdtempSync(join(tmpdir(), "srw-a-")), REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });
    const second = runPlan(mkdtempSync(join(tmpdir(), "srw-b-")), REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });
    expect(readFileSync(join(first.paths.out, "patch"), "utf8"))
      .toBe(readFileSync(join(second.paths.out, "patch"), "utf8"));
  });

  it("exits non-zero when the work tree was never materialized", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-empty-"));
    expect(() => runPlan(root, REPOSITORY_WORK_TASK, {})).toThrow();
  });

  it("exits non-zero when the staged Task is not a repository-work Task", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-wrong-"));
    expect(() => runPlan(root, { profile: { uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0" } }, { "README.md": "x\n" }))
      .toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/venue/sample-repository-work.test.ts`
Expected: FAIL — `Failed to resolve import "./sample-repository-work.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/benchmark-product/core/src/venue/sample-repository-work.ts`:

```ts
/**
 * The product-bundled hermetic `repository-work` arm (P1), the exact counterpart of
 * `./sample-uniform.ts` for the repository-work profile: a REAL `node -e` subprocess, honestly
 * labeled as a trivial baseline rather than a coding agent. It appends one line to the
 * lexicographically-first regular file in the materialized work tree and emits the corresponding
 * unified diff as the Task's declared `patch` output.
 *
 * It exists because the backend's capability assembly intersects the provisioner's task profiles
 * with the union of the registered launchers'
 * (`packages/task-execution/backend-local/assembly/src/capabilities.ts:63-75`): without at least
 * one registered launcher declaring `repository-work/1.0`, the profile can never reach
 * capabilities. The platform's real coding-agent launchers declare it but require an external
 * binary; this one requires nothing but Node, so P1 is verifiable in CI on its own and the demo
 * gets a zero-capability control arm for free.
 *
 * Guard logic is a small self-contained reimplementation rather than a reuse of platform
 * internals, for the same reason `./sample-uniform.ts` gives: the platform's `requireHarness` /
 * `isolation` / `baseEnv` planning helpers are deliberately not exported.
 */

import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
  ProbeResult,
} from "@jinn-network/task-execution-launchers";
import { REPOSITORY_WORK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import {
  STAGED_SEALED_TASK_FILENAME,
  type TaskView,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export const SAMPLE_REPOSITORY_WORK_LAUNCHER_ID = "sample-repository-work";
export const SAMPLE_REPOSITORY_WORK_HARNESS_VERSION = "0.1.0";

/** The marker line this arm appends. Fixed, so every attempt's patch is byte-identical. */
const APPENDED_LINE = "sample-repository-work";

/**
 * The inline runner. It reads the ONE staged path the product's provisioner contract writes
 * (`input/${STAGED_SEALED_TASK_FILENAME}`) and checks only the profile URI — full Task validity is
 * the platform's job. Reading the work tree is the point, not incidental: an empty `work/` means
 * provisioning did not materialize the repository, and this arm must fail loudly rather than
 * emit a patch against nothing.
 */
export const SAMPLE_REPOSITORY_WORK_RUNNER_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
const work = process.env.JINN_ATTEMPT_WORK;
const PROFILE_URI = '${REPOSITORY_WORK_PROFILE_URI}';
const TASK_FILE = ${JSON.stringify(STAGED_SEALED_TASK_FILENAME)};
const APPENDED = ${JSON.stringify(APPENDED_LINE)};
let doc;
try {
  doc = JSON.parse(fs.readFileSync(path.join(input, TASK_FILE), 'utf8'));
} catch (error) {
  console.error('sample-repository-work: could not read input/' + TASK_FILE + ': ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
}
if (!doc || !doc.profile || doc.profile.uri !== PROFILE_URI) {
  console.error('sample-repository-work: input/' + TASK_FILE + ' is not a repository-work Task');
  process.exit(2);
}
let entries;
try {
  entries = fs.readdirSync(work, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.git')
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  console.error('sample-repository-work: work tree is unreadable: ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
}
const target = entries[0];
if (target === undefined) {
  console.error('sample-repository-work: work tree contains no regular file -- the repository was never materialized');
  process.exit(2);
}
const before = fs.readFileSync(path.join(work, target), 'utf8');
const beforeLines = before.length === 0 ? [] : before.replace(/\\n$/, '').split('\\n');
const patch = [
  'diff --git a/' + target + ' b/' + target,
  '--- a/' + target,
  '+++ b/' + target,
  '@@ -1,' + beforeLines.length + ' +1,' + (beforeLines.length + 1) + ' @@',
  ...beforeLines.map((line) => ' ' + line),
  '+' + APPENDED,
  '',
].join('\\n');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'patch'), patch);
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success',
  structuredOutput: { changedFile: target, appended: APPENDED },
  harnessVersion: '${SAMPLE_REPOSITORY_WORK_HARNESS_VERSION}',
  sessionId: process.env.JINN_ATTEMPT_ID || 'sample-repository-work',
}));
process.exit(0);
`;

function requireHarness(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["harness"];
  if (value === undefined) return;
  if (
    typeof value !== "object" || value === null
    || (value as { id?: unknown }).id !== SAMPLE_REPOSITORY_WORK_LAUNCHER_ID
  ) {
    throw new Error(`${SAMPLE_REPOSITORY_WORK_LAUNCHER_ID}: harness pin does not select this launcher`);
  }
}

function requireIsolation(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["isolationPolicy"];
  if (value === undefined) return;
  if (value !== "unrestricted") throw new Error(`unsupported isolationPolicy ${String(value)}`);
}

export function makeSampleRepositoryWorkLauncher(
  options: { readonly probe?: () => Promise<ProbeResult> } = {},
): LauncherContract {
  return {
    id: SAMPLE_REPOSITORY_WORK_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: [REPOSITORY_WORK_PROFILE_URI],
      inputMediaTypes: ["application/json", "text/plain"],
      outputMediaTypes: ["application/json", "text/plain", "text/x-diff", "text/markdown"],
      structuredOutput: true,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "harness", inventory: [SAMPLE_REPOSITORY_WORK_LAUNCHER_ID], posture: "enforced" },
          { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
        ],
      },
    }),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      requireHarness(view);
      requireIsolation(view);
      return {
        argv: [process.execPath, "-e", SAMPLE_REPOSITORY_WORK_RUNNER_SOURCE],
        cwd: paths.work,
        env: {
          JINN_ATTEMPT_ID: attempt.attemptUri,
          JINN_ATTEMPT_INPUT: paths.input,
          JINN_ATTEMPT_WORK: paths.work,
          JINN_ATTEMPT_OUT: paths.out,
          JINN_ATTEMPT_LOGS: paths.logs,
          JINN_ATTEMPT_META: paths.meta,
          TMPDIR: paths.tmp,
        },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: {
          envelopeFormat: "sample-repository-work-json",
          structuredOutputArtifact: "out/structured-output.json",
          correlationFields: ["harnessVersion", "sessionId"],
        },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}

export const sampleRepositoryWorkLauncher: LauncherContract = makeSampleRepositoryWorkLauncher();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/venue/sample-repository-work.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/venue/sample-repository-work.ts packages/benchmark-product/core/src/venue/sample-repository-work.test.ts
git commit -m "feat(benchmark-product): hermetic sample-repository-work launcher"
```

---

### Task 3: The repository-work provisioner arm (site C)

**Files:**
- Modify: `packages/benchmark-product/core/src/venue/provisioner.ts` (add a contract factory after the evaluation-cell section at `:229`; extend the selector at `:263-295`)
- Test: `packages/benchmark-product/core/src/venue/provisioner.test.ts`

**Interfaces:**
- Consumes: `RepositoryMirrorPort` from Task 1.
- Produces:
  - `CreateLocalProvisionerOptions` gains `readonly repositoryMirror?: RepositoryMirrorPort;`
  - a selector arm returning `{ id: "benchmark-product-repository-work-worktree-v1", contract }`.

**Design notes for the implementer:**
- The Task's repository descriptor is `task.inputs.find((i) => i.name === "repository-state")`, carrying `uri` and `annotations.ref`. The profile requires both (`packages/task-execution/profiles/src/documents/repository-work-1.0.ts:44`).
- Read the head-commit constraints straight from the platform: 40 lowercase hex, verified after checkout, and the worktree must be detached (`worktree-provisioner.ts:18,26-29`). Reimplement, do not import — see the deviation note above.
- Harvest ordering matters: rename **before** calling `workspaceHarvest`, because `harvest` walks `out/` and stamps `mediaType` from the declared slot whose `name` equals the artifact path (`harvest.ts:110-114`, changed by PR #2556). An artifact still named `patch.diff` gets no mediaType.
- `structured-output.json` must leave `out/` or it lands in the signed Delivery's outputs — exactly the reasoning already written at `provisioner.ts:121-128`.

- [ ] **Step 1: Write the failing test**

Append to `packages/benchmark-product/core/src/venue/provisioner.test.ts`:

```ts
describe("createLocalProvisioner — repository-work cells", () => {
  function repositoryWorkTask(uri: string, oid: string) {
    return {
      profile: { uri: REPOSITORY_WORK_PROFILE_URI },
      inputs: [{ name: "repository-state", uri, annotations: { ref: oid } }],
      outputs: [
        { name: "patch", mediaType: "text/x-diff", required: true },
        { name: "summary", mediaType: "text/markdown", required: false },
      ],
    } as unknown as TaskSpecification;
  }

  it("selects the repository-work provisioner for a repository-work Task", () => {
    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: { ensure: async () => "/unused" },
    })({
      task: repositoryWorkTask("file:///upstream", "a".repeat(40)),
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    expect(selected.id).toBe("benchmark-product-repository-work-worktree-v1");
    expect(selected.contract.workspaceKind({} as never)).toBe("worktree");
  });

  it("materializes a detached worktree at paths.work and stages the sealed Task", async () => {
    const upstream = makeUpstreamRepository();
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-"));
    const paths = workspacePathsFor(root);
    const sealed = new TextEncoder().encode(JSON.stringify({ profile: { uri: REPOSITORY_WORK_PROFILE_URI } }));

    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: createGitRepositoryMirror(join(root, "mirrors")),
    })({
      task: repositoryWorkTask(upstream.uri, upstream.oid),
      sealedTaskBytes: sealed,
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await selected.contract.setup({} as never, paths, []);

    expect(readFileSync(join(paths.input, "task.sealed"))).toEqual(Buffer.from(sealed));
    expect(existsSync(join(paths.work, "README.md"))).toBe(true);
    expect(gitIn(paths.work, "rev-parse", "HEAD")).toBe(upstream.oid);
    expect(() => gitIn(paths.work, "symbolic-ref", "-q", "HEAD")).toThrow();
  });

  it("refuses a Task with no repository-state input", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-missing-"));
    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: { ensure: async () => "/unused" },
    })({
      task: { profile: { uri: REPOSITORY_WORK_PROFILE_URI }, inputs: [], outputs: [] } as unknown as TaskSpecification,
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await expect(selected.contract.setup({} as never, workspacePathsFor(root), []))
      .rejects.toThrow(/no "repository-state" input/u);
  });

  it("refuses when no repository mirror is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-nomirror-"));
    const selected = createLocalProvisioner({ registry: createEvaluationCellRegistry(), evaluators: [] })({
      task: repositoryWorkTask("file:///upstream", "a".repeat(40)),
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await expect(selected.contract.setup({} as never, workspacePathsFor(root), []))
      .rejects.toThrow(/no repository mirror is configured/u);
  });

  it("normalizes harvest to the declared slots and moves the structured envelope to meta/", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-harvest-"));
    const paths = workspacePathsFor(root);
    for (const dir of [paths.input, paths.work, paths.out, paths.logs, paths.meta, paths.tmp, paths.secrets]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(paths.out, "patch.diff"), "--- a/x\n+++ b/x\n");
    writeFileSync(join(paths.out, "structured-output.json"), "{}");
    writeFileSync(join(paths.out, "scratch.txt"), "noise");

    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: { ensure: async () => "/unused" },
    })({
      task: repositoryWorkTask("file:///upstream", "a".repeat(40)),
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    const result = await selected.contract.harvest(paths, [
      { name: "patch", mediaType: "text/x-diff", required: true },
      { name: "summary", mediaType: "text/markdown", required: false },
    ] as never);

    expect(result.manifest.map((entry) => entry.path)).toEqual(["patch"]);
    expect(result.manifest[0]!.mediaType).toBe("text/x-diff");
    expect(result.omissions).toEqual(["summary"]);
    expect(existsSync(join(paths.meta, "structured-output.json"))).toBe(true);
    expect(existsSync(join(paths.out, "structured-output.json"))).toBe(false);
  });
});
```

Add at the top of the file the imports and helpers these tests use (`REPOSITORY_WORK_PROFILE_URI` from `@jinn-network/task-execution-profiles`; `createGitRepositoryMirror` from `./repository-mirror.js`; `TaskSpecification` from `@jinn-network/task-execution-protocol`; node `fs`/`os`/`path`/`child_process`), plus the two local helpers:

```ts
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function makeUpstreamRepository(): { uri: string; oid: string } {
  const dir = mkdtempSync(join(tmpdir(), "provisioner-upstream-"));
  gitIn(dir, "init", "--quiet", "--initial-branch", "main");
  gitIn(dir, "config", "user.email", "test@example.invalid");
  gitIn(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "upstream\n");
  gitIn(dir, "add", "README.md");
  gitIn(dir, "commit", "--quiet", "-m", "initial");
  return { uri: `file://${dir}`, oid: gitIn(dir, "rev-parse", "HEAD") };
}

function workspacePathsFor(root: string): WorkspacePaths {
  return {
    root,
    input: join(root, "input"), work: join(root, "work"), out: join(root, "out"),
    logs: join(root, "logs"), harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"), tmp: join(root, "tmp"), meta: join(root, "meta"),
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/venue/provisioner.test.ts`
Expected: FAIL — the selector returns `benchmark-product-unsupported-dir-v1`, whose `setup` throws `has no provisioner for task profile`.

- [ ] **Step 3: Write minimal implementation**

In `provisioner.ts`, add `REPOSITORY_WORK_PROFILE_URI` to the existing `@jinn-network/task-execution-profiles` import, add `import { execFile } from "node:child_process";` / `import { promisify } from "node:util";` / `import type { RepositoryMirrorPort } from "./repository-mirror.js";` / `import type { ResourceDescriptor, TaskSpecification } from "@jinn-network/task-execution-protocol";`, and insert this section immediately before the `── unsupported profiles` divider:

```ts
// ── repository-work cells ────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const REPOSITORY_OID_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * Not a reuse of the platform's `makeWorktreeProvisioner`: reaching it would require the product
 * to implement `WorkspaceRuntimePorts` (process-group gating, meta reserve) it has no business
 * owning, and its inherited `makeDirProvisioner.setup` would materialize the `repository-state`
 * descriptor as a junk FILE via `materializeInput`. Same reasoning as `./sample-uniform.ts`'s
 * self-contained planning guards. The checkout constraints below are the platform's, verbatim:
 * 40-hex oid, HEAD equals the requested oid, and the worktree is detached.
 */
async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

interface RepositoryWorkProvisionerOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly mirror: RepositoryMirrorPort | undefined;
}

/** The Task's declared repository descriptor (`repository-work/1.0` inputConventions). */
function repositoryStateDescriptor(task: TaskSpecification): { uri: string; oid: string } {
  const descriptor = (task.inputs ?? []).find(
    (input: ResourceDescriptor) => input.name === "repository-state",
  );
  if (descriptor === undefined) {
    throw new Error(
      'benchmark-product local venue: repository-work Task declares no "repository-state" input',
    );
  }
  const uri = descriptor.uri;
  const oid = (descriptor.annotations as { ref?: unknown } | undefined)?.ref;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error('benchmark-product local venue: "repository-state" input carries no uri');
  }
  if (typeof oid !== "string" || !REPOSITORY_OID_PATTERN.test(oid)) {
    throw new Error(
      'benchmark-product local venue: "repository-state" annotations.ref must be exactly 40 lowercase hex characters',
    );
  }
  return { uri, oid };
}

function repositoryWorkProvisionerContract(
  options: RepositoryWorkProvisionerOptions,
): ProvisionerContract {
  return {
    workspaceKind: (): WorkspaceKind => "worktree",
    async setup(_view, paths) {
      const { uri, oid } = repositoryStateDescriptor(options.task);
      if (options.mirror === undefined) {
        throw new Error(
          "benchmark-product local venue cannot provision a repository-work cell: no repository mirror is configured",
        );
      }
      await ensureWorkspaceDirectories(paths);
      await Promise.all([
        writeFile(join(paths.input, STAGED_SEALED_TASK_FILENAME), options.sealedTaskBytes),
        writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes),
      ]);
      const mirrorDir = await options.mirror.ensure({ uri, oid });
      // git refuses a worktree destination that already exists.
      await rm(paths.work, { recursive: true, force: true });
      await git(["-C", mirrorDir, "worktree", "add", "--detach", paths.work, oid]);
      const actual = await git(["-C", paths.work, "rev-parse", "HEAD"]);
      if (actual !== oid) throw new Error(`worktree resolved ${actual}, expected ${oid}`);
      const branch = await git(["-C", paths.work, "symbolic-ref", "-q", "HEAD"]).catch(() => "");
      if (branch !== "") throw new Error(`worktree is attached to ${branch}`);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      // Same normalization contract as the solve path above, for this profile's declared slots.
      // Renames run BEFORE `workspaceHarvest` because harvest stamps each artifact's mediaType
      // from the declared slot whose name equals its path -- an artifact still called
      // "patch.diff" would be collected untyped.
      const structuredOutputPath = join(paths.out, "structured-output.json");
      if (existsSync(structuredOutputPath)) {
        await rename(structuredOutputPath, join(paths.meta, "structured-output.json"));
      }
      for (const slot of declaredOutputs) {
        for (const suffix of [".diff", ".patch", ".md", ".json", ".txt"]) {
          const candidate = join(paths.out, `${slot.name}${suffix}`);
          if (!existsSync(join(paths.out, slot.name)) && existsSync(candidate)) {
            await rename(candidate, join(paths.out, slot.name));
          }
        }
      }
      const declared = new Set(declaredOutputs.map((slot) => slot.name));
      const result = await workspaceHarvest(paths, declaredOutputs);
      const manifest = result.manifest.filter((entry) => declared.has(entry.path));
      await wipeScratch(paths);
      return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
    },
  };
}
```

Then extend `CreateLocalProvisionerOptions` with:

```ts
  /** Resolves a repository-work Task's `repository-state` descriptor to a local bare mirror.
   * Absent on venues that serve no repository-work cells; a repository-work cell then refuses
   * typed at setup rather than silently provisioning an empty work tree. */
  readonly repositoryMirror?: RepositoryMirrorPort;
```

and add the selector arm inside `createLocalProvisioner`'s returned closure, after the `EVALUATION_TASK_PROFILE_URI` branch:

```ts
    if (profileUri === REPOSITORY_WORK_PROFILE_URI) {
      return {
        id: "benchmark-product-repository-work-worktree-v1",
        contract: repositoryWorkProvisionerContract({
          sealedTaskBytes: input.sealedTaskBytes,
          dispatchContextBytes: input.dispatchContextBytes,
          task: input.task,
          mirror: options.repositoryMirror,
        }),
      };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/venue/provisioner.test.ts`
Expected: PASS — the pre-existing prediction and evaluation cases plus 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/venue/provisioner.ts packages/benchmark-product/core/src/venue/provisioner.test.ts
git commit -m "feat(benchmark-product): repository-work worktree provisioner arm"
```

---

### Task 4: Venue wiring — sites A, B, D and E

**Files:**
- Modify: `packages/benchmark-product/core/src/venue/venue.ts` (`:143-146`, `:330-343`, `:376-382`, `:484-515`, `:517-523`, `:531`)
- Test: `packages/benchmark-product/core/src/venue/venue.test.ts`

**Interfaces:**
- Consumes: `makeSampleRepositoryWorkLauncher`, `SAMPLE_REPOSITORY_WORK_LAUNCHER_ID`, `SAMPLE_REPOSITORY_WORK_HARNESS_VERSION` (Task 2); `createGitRepositoryMirror` (Task 1); `repositoryMirror` option (Task 3).
- Produces: `SOLVE_HARNESS_PINS["sample-repository-work"]`; a venue whose `backend.capabilities().taskProfiles` contains `repository-work/1.0`.

- [ ] **Step 1: Write the failing test**

Append to `packages/benchmark-product/core/src/venue/venue.test.ts`:

```ts
describe("createLocalVenue task-profile admission", () => {
  it("advertises all three served profiles in backend capabilities", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "venue-profiles-"));
    mkdirSync(join(workspaceDir, "venue"), { recursive: true });
    const venue = createLocalVenue({ workspaceDir, now: NOW });
    try {
      const capabilities = await venue.backend.capabilities();
      expect([...capabilities.taskProfiles].sort()).toEqual([
        "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
        "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
        "https://spec.jinn.network/task-profiles/repository-work/1.0",
      ]);
      const harness = capabilities.runPinning.keys.find((key) => key.key === "harness");
      expect(harness?.inventory).toContain(SAMPLE_REPOSITORY_WORK_LAUNCHER_ID);
    } finally {
      await venue.shutdown();
    }
  });

  it("still refuses an unknown task profile, typed", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "venue-profiles-unknown-"));
    mkdirSync(join(workspaceDir, "venue"), { recursive: true });
    const venue = createLocalVenue({ workspaceDir, now: NOW });
    try {
      // The venue's `resolveTaskProfile` is the backend's sole profile resolver; an unserved URI
      // must refuse rather than fall through to a default.
      await expect(
        venue.backend.preflight({ taskProfile: "https://spec.jinn.network/task-profiles/nope/1.0" }),
      ).resolves.toMatchObject({ ready: false });
    } finally {
      await venue.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/venue/venue.test.ts`
Expected: FAIL — `taskProfiles` has two entries, not three, and the harness inventory lacks `sample-repository-work`.

- [ ] **Step 3: Write minimal implementation**

In `venue.ts`:

1. Extend the profiles import with `buildRepositoryWorkProfile` and `REPOSITORY_WORK_PROFILE_URI`; add `import { makeSampleRepositoryWorkLauncher, SAMPLE_REPOSITORY_WORK_HARNESS_VERSION, SAMPLE_REPOSITORY_WORK_LAUNCHER_ID } from "./sample-repository-work.js";` and `import { createGitRepositoryMirror } from "./repository-mirror.js";`.

2. Extend `SOLVE_HARNESS_PINS` (`:143-146`):

```ts
export const SOLVE_HARNESS_PINS = {
  "prediction-v1-baseline": { id: "prediction-v1-baseline", version: "1.0.0" },
  "sample-uniform": { id: SAMPLE_UNIFORM_LAUNCHER_ID, version: SAMPLE_UNIFORM_HARNESS_VERSION },
  "sample-repository-work": { id: SAMPLE_REPOSITORY_WORK_LAUNCHER_ID, version: SAMPLE_REPOSITORY_WORK_HARNESS_VERSION },
} as const;
```

3. Site A — replace `resolveTaskProfileFor` (`:330-343`) with a three-arm resolver:

```ts
function resolveTaskProfileFor(
  predictionProfile: TaskProfileDocument,
  evaluationProfile: TaskProfileDocument,
  repositoryWorkProfile: TaskProfileDocument,
): (descriptor: TaskSpecification["profile"]) => TaskProfileDocument {
  return (descriptor) => {
    if (descriptor.uri === PREDICTION_FORECAST_PROFILE_URI) return predictionProfile;
    if (descriptor.uri === EVALUATION_TASK_PROFILE_URI) return evaluationProfile;
    if (descriptor.uri === REPOSITORY_WORK_PROFILE_URI) return repositoryWorkProfile;
    return refuse(
      "execution",
      "task.profile.uri",
      `local venue cannot resolve task profile "${String(descriptor.uri)}"`,
    );
  };
}
```

4. In `createLocalVenue`, next to the existing profile builders (`:384-385`), add `const repositoryWorkProfile = buildRepositoryWorkProfile();`, and pass it to `resolveTaskProfileFor(predictionProfile, evaluationProfile, repositoryWorkProfile)` at `:530`.

5. Pass the mirror into the provisioner (`:376-382`):

```ts
  const provisioner = createLocalProvisioner({
    registry,
    evaluators: evaluators.map(({ id, signer }) => ({ id, signer })),
    repositoryMirror: createGitRepositoryMirror(join(workspaceDir, "venue", "repositories")),
    ...(options.evaluationContextVariationForTesting === undefined
      ? {}
      : { evaluationContextVariationForTesting: options.evaluationContextVariationForTesting }),
  });
```

6. Build the launcher next to the other two (`:397-400`):

```ts
  const repositoryWorkLauncher = withSolveStartDelayForTesting(
    makeSampleRepositoryWorkLauncher(),
    options.solveStartDelayMsForTesting,
  );
```

7. Derive its identity digest next to the others (`:474-482`):

```ts
  const repositoryWorkDigest = sha256Hex(new TextEncoder().encode(
    extractInlineRunnerSource(repositoryWorkLauncher, SAMPLE_REPOSITORY_WORK_LAUNCHER_ID, repositoryWorkProfile),
  ));
```

8. Add its `launcherDeployments` entry (inside the object at `:484-515`):

```ts
    [repositoryWorkLauncher.id]: {
      executable: { path: process.execPath, digest: repositoryWorkDigest },
      async probe() {
        return {
          ready: true,
          executable: { path: process.execPath, digest: repositoryWorkDigest },
          harnessVersions: [SOLVE_HARNESS_PINS["sample-repository-work"].version],
        };
      },
    },
```

9. Site B — extend `provisionerCapabilities` (`:517-523`). `workspaceKinds` and `outputMediaTypes` are declarative (assembled into the report at `capabilities.ts:88-90`, never enforced at submit), but the venue must not advertise less than it serves:

```ts
  const provisionerCapabilities: ProvisionerCapabilities = {
    taskProfiles: [PREDICTION_FORECAST_PROFILE_URI, EVALUATION_TASK_PROFILE_URI, REPOSITORY_WORK_PROFILE_URI],
    workspaceKinds: ["dir", "worktree"],
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: [
      "application/json",
      "application/vnd.in-toto+json",
      "text/x-diff",
      "text/markdown",
    ],
    isolation: ["process"],
  };
```

10. Register the launcher (`:531`): `launchers: [baselineLauncher, sampleLauncher, repositoryWorkLauncher, evaluationLauncher],`

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/venue/venue.test.ts src/venue/venue.integration.test.ts`
Expected: PASS. `venue.integration.test.ts` must pass **unmodified** — that is the prediction byte-stability gate.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/venue/venue.ts packages/benchmark-product/core/src/venue/venue.test.ts
git commit -m "feat(benchmark-product): admit repository-work at every venue profile site"
```

---

### Task 5: Venue-level repository-work solve leg

**Files:**
- Create: `packages/benchmark-product/core/src/venue/repository-work.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no source; this is the packet's dispatch-boundary proof (acceptance criteria 1, 2, 5).

**Design notes:** model this on `venue.integration.test.ts`, which submits a Submission straight to `venue.backend` and observes the Delivery. Build the Task with `sealTask` + `buildRepositoryWorkProfile` — **never** via the SWE-bench importer, which C4 is actively changing. The evaluation leg is P3's; assert only that the solve leg delivers.

- [ ] **Step 1: Write the failing test**

Create `packages/benchmark-product/core/src/venue/repository-work.integration.test.ts`:

```ts
/**
 * The repository-work solve leg on the real local venue (P1 acceptance 1, 2 and 5): a
 * repository-work Task resolves, selects the worktree provisioner, dispatches to the hermetic
 * `sample-repository-work` arm, and delivers the profile's declared `patch` output typed
 * `text/x-diff`.
 *
 * The Task is built here rather than imported through `convertSweBenchRows` on purpose: C4's
 * P0-interop packet is changing the importer's sealed output, and this test must not be coupled
 * to a digest that is about to move.
 *
 * The EVALUATION leg is deliberately absent -- container grading is P3. This file proves the
 * solve leg only, which is exactly the dispatch boundary P1 claims.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTask,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { createLocalVenue, SOLVE_HARNESS_PINS } from "./venue.js";
import { sha256Hex } from "../workspace/sealed-store.js";

const NOW = () => "2026-01-01T00:00:00Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function makeUpstream(): { uri: string; oid: string } {
  const dir = mkdtempSync(join(tmpdir(), "repository-work-upstream-"));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "upstream\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "initial");
  return { uri: `file://${dir}`, oid: git(dir, "rev-parse", "HEAD") };
}

function sealRepositoryWorkTask(upstream: { uri: string; oid: string }): { bytes: Uint8Array; sha256: string } {
  const profile = buildRepositoryWorkProfile();
  const profileDigest = sealTaskProfile(profile).digest;
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: REPOSITORY_WORK_PROFILE_URI, digest: { sha256: profileDigest.replace(/^sha256:/u, "") } },
    instructions: "Append the marker line to the repository's first file.",
    payload: {
      instance_id: "demo__demo-1",
      language: "python",
      provenance: { kind: "mined", source: upstream.uri, timestamp: "2026-01-01T00:00:00Z" },
    },
    inputs: [{ name: "repository-state", uri: upstream.uri, annotations: { ref: upstream.oid } }],
    outputs: profile.outputConventions.slots.map((slot) => ({
      name: slot.name, mediaType: slot.mediaType, required: slot.required,
    })),
  });
  return { bytes, sha256: sha256Hex(bytes) };
}

describe("repository-work solve leg on the local venue", () => {
  it("dispatches, executes against the materialized worktree, and delivers a typed patch", async () => {
    const upstream = makeUpstream();
    const workspaceDir = mkdtempSync(join(tmpdir(), "repository-work-venue-"));
    mkdirSync(join(workspaceDir, "venue"), { recursive: true });
    const venue = createLocalVenue({ workspaceDir, now: NOW });

    try {
      await venue.preflightRun!();

      const task = sealRepositoryWorkTask(upstream);
      const submission = new TextEncoder().encode(JSON.stringify({
        protocol: TASK_EXECUTION_PROTOCOL_URI,
        task: { digest: { sha256: task.sha256 } },
        nonce: "repository-work-1",
        requirements: {
          harness: SOLVE_HARNESS_PINS["sample-repository-work"],
          isolationPolicy: "unrestricted",
        },
      }));

      const ack = await venue.backend.submit(task.bytes, submission);
      expect(ack.accepted, JSON.stringify(ack)).toBe(true);

      const deliveries = await (async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const snapshot = await venue.backend.observe(ack.submission!);
          if (snapshot.attempt !== undefined) {
            const found = await venue.backend.deliveries(snapshot.attempt);
            if (found.length > 0) return found;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("no delivery observed for the repository-work cell");
      })();

      const deliveryBytes = await venue.backend.fetchDelivery(deliveries[0]!);
      const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
        readonly outputs: readonly { readonly name?: string; readonly path?: string; readonly mediaType?: string }[];
      };

      // Exactly the profile's declared slots survive harvest, and `patch` carries its declared type.
      const paths = delivery.outputs.map((output) => output.path ?? output.name);
      expect(paths).toEqual(["patch"]);
      expect(delivery.outputs[0]!.mediaType).toBe("text/x-diff");
    } finally {
      await venue.shutdown();
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/venue/repository-work.integration.test.ts`
Expected: FAIL on the first run **only if Tasks 1-4 are incomplete**. If Tasks 1-4 are already committed this test should pass on the first run — that is the intended outcome for an integration proof, and it is not a TDD violation: its failing state was demonstrated by Tasks 1-4's own unit tests. If it fails, read the delivery envelope's actual key names (`name` vs `path`) and the `observe` snapshot shape from `venue.integration.test.ts:80-95` and correct the accessor — **do not** weaken the two assertions.

- [ ] **Step 3: Implementation**

No source changes. If Step 2 revealed an accessor mismatch, fix only the test's field access.

- [ ] **Step 4: Run the full venue suite**

Run: `yarn vitest run src/venue/`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/venue/repository-work.integration.test.ts
git commit -m "test(benchmark-product): repository-work solve leg reaches the dispatch boundary"
```

---

### Task 6: The quote seam stays in sync

**Files:**
- Modify: `packages/benchmark-product/core/src/operations/quote-presentation.test.ts`

**Interfaces:**
- Consumes: the venue from Task 4.
- Produces: no source; acceptance criteria 3 and 4.

**Why no source change:** `coverageRefusals` (`operations/run-quote.ts:169-192`) and `unsupportedPinningErrors` (`packages/benchmarking/run/src/quote.ts:29-69`) both walk `capabilities.runPinning.keys` generically — neither hardcodes a harness id. Registering a launcher extends the inventory both already read. This task **proves** that rather than assuming it, and extends the cross-check test the program requires be strengthened, never weakened.

- [ ] **Step 1: Write the failing test**

Append to `packages/benchmark-product/core/src/operations/quote-presentation.test.ts`, inside the existing `describe("runQuote — presentation.coverage (spec §4.6)")` block:

```ts
  test("a repository-work arm on the real venue produces no coverage refusal, and an unknown harness still does", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    const draftResult = createDraft(contextFor(clock), { draftId: "draft-rw", name: "Repository Work" });
    expect(draftResult.ok).toBe(true);
    await sampleInit(contextFor(clock), { draftId: "draft-rw" });
    armAdd(contextFor(clock), {
      draftId: "draft-rw",
      armId: "repository-work",
      pinning: { harness: { id: "sample-repository-work", version: "0.1.0" }, isolationPolicy: "unrestricted" },
    });
    armAdd(contextFor(clock), {
      draftId: "draft-rw",
      armId: "unknown-harness",
      pinning: { harness: { id: "not-a-launcher", version: "0.1.0" } },
    });

    // The REAL venue, not the stub: the point is that registering a launcher widens the
    // inventory both the product-side coverage walk and the platform-side quote walk read.
    const outcome = await runQuote(contextFor(clock), { draftId: "draft-rw" });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { presentation, quote } = outcome.result;
    const refusedArms = presentation.coverage.refusals.map((refusal) => refusal.armId);
    expect(refusedArms).not.toContain("repository-work");
    expect(refusedArms).toContain("unknown-harness");

    // The cross-check the program requires stay in sync: every product-side refusal has a
    // matching platform-side quote error naming the same arm.
    for (const refusal of presentation.coverage.refusals) {
      expect(quote.errors.some((error) => error.detail?.includes(refusal.armId))).toBe(true);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/operations/quote-presentation.test.ts`
Expected: FAIL — before Task 4, `sample-repository-work` is not in the venue's harness inventory, so `repository-work` appears in `refusedArms`. (Run this against the pre-Task-4 tree to confirm, or reason from the inventory.)

- [ ] **Step 3: Implementation**

No source changes expected. If `presentation.coverage.refusals` or `quote.errors` field names differ, read the shapes from the existing test at `:262-290` and correct the accessors — **do not** relax either assertion.

- [ ] **Step 4: Run the seam suites**

Run: `yarn vitest run src/operations/quote-presentation.test.ts src/operations/run-quote.test.ts`
Expected: PASS, both unmodified except for the appended test.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/operations/quote-presentation.test.ts
git commit -m "test(benchmark-product): quote coverage seam admits repository-work arms"
```

---

### Task 7: Full-chain verification and PR readiness

**Files:** none — this is the gate.

- [ ] **Step 1: Build the portal chain from source, in dependency order**

From the repository root, run each package in the exact order at `.github/workflows/benchmark-product-ci.yml:69-92`:

```bash
for p in \
  packages/task-execution/protocol packages/trust/core packages/environments/record \
  packages/task-execution/profiles packages/benchmarking/records packages/benchmarking/aggregate \
  packages/task-execution/backend packages/task-execution/backend-local/supervisor \
  packages/task-execution/backend-local/workspace packages/task-execution/backend-local/launchers \
  packages/task-supply/admission packages/benchmarking/interop packages/evidence/protocol \
  packages/evidence/repository packages/evidence/discovery packages/evidence/execution-recorder \
  packages/evidence/attestation-issuer packages/task-execution/evaluation-harness \
  packages/task-execution/evaluator-adapters packages/task-execution/backend-local/assembly \
  packages/benchmarking/run packages/benchmarking/local ; do
  ( cd "$p" && yarn install --immutable && yarn build ) || { echo "FAILED: $p"; break; }
done
```

Expected: every package builds. A red `*-packed-types.test.mjs` here means an unbuilt `dist/`, not a regression — re-run the chain from the start.

- [ ] **Step 2: Run the product's own gate**

```bash
cd packages/benchmark-product/core
yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn check:parity && yarn pack:smoke
```

Expected: green. Baseline for comparison is **68 test files / 683 tests passing** at head `04f309de8` before this packet; this packet adds files and tests and removes none.

- [ ] **Step 3: Confirm the untouched-test guarantee**

```bash
git diff --stat origin/integration/evidence-v1 -- \
  packages/benchmark-product/core/src/venue/venue.integration.test.ts \
  packages/benchmark-product/core/src/operations/run-quote.test.ts \
  packages/benchmark-product/core/src/run/run-path.integration.test.ts \
  packages/benchmark-product/core/src/cli/cli-lifecycle.integration.test.ts \
  packages/benchmark-product/core/src/public-quickstart.test.ts \
  packages/benchmark-product/core/src/venue/sample-uniform.test.ts
```

Expected: **empty output.** Any diff here is a byte-stability failure and must be explained in the PR body or reverted.

- [ ] **Step 4: Confirm no platform package was modified**

```bash
git diff --name-only origin/integration/evidence-v1 -- packages/task-execution packages/benchmarking
```

Expected: **empty output.** P1 is product-only.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin claude/demo1-p1-venue-profiles
gh pr create --base integration/evidence-v1 \
  --title "feat(benchmark-product): admit repository-work Tasks on the local venue" \
  --body-file <(cat <<'BODY'
Closes the P1 packet of the Demo-1 venue-glue program.

## What this does
Makes the local venue admit `repository-work/1.0` for solve legs across all five profile sites, and ships a hermetic `sample-repository-work` arm so the profile is verifiable in CI without an external binary.

## Design deviation from the approved recon (D1)
The approved design was "mirror-cache + delegate to `makeWorktreeProvisioner`, incl. authoring production `WorkspaceRuntimePorts`". This PR reimplements ~12 lines of git checkout in the product instead. Rationale in `docs/superpowers/plans/2026-08-12-demo1-p1-venue-profile-generalization.md` § "Deviation": delegation drags in `WorkspaceRuntimePorts` (process-group/disk-reserve semantics the product should not own — no production implementation exists anywhere in the repo) and its inherited `makeDirProvisioner.setup` would materialize `repository-state` as a junk file. Matches the in-tree precedent documented in `sample-uniform.ts`'s header. Net scope reduction.

## Local full-chain verification
CI is path-blind to the upstream half of this chain, so it was run locally:
- 22-package portal chain from `benchmark-product-ci.yml:69-92`: **green**
- `benchmark-product/core`: `typecheck`, `test`, `build`, `check:parity`, `pack:smoke`: **green**
- Pre-packet baseline at `04f309de8`: 68 files / 683 tests passing, zero pre-existing failures

## Pinned literals
None changed. `venue.integration.test.ts`, `run-quote.test.ts`, `run-path.integration.test.ts`, `cli-lifecycle.integration.test.ts`, `public-quickstart.test.ts` and `sample-uniform.test.ts` pass **unmodified** (verified by empty `git diff`).

## Out of scope
The repository-work EVALUATION leg (container grading) is P3. `prepareEvaluationCell` still refuses a non-prediction payload, typed and deliberately.

## Not touched
`intake/swebench.ts` and `interop/src/import/swebench.ts` (C4's P0-interop packet). No platform package is modified.
BODY
) --draft
```

- [ ] **Step 6: Request an independent review**

Dispatch an independent Opus reviewer per `superpowers:requesting-code-review`. The implementing lane never reviews itself.

---

## Self-Review

**Spec coverage** — every P1 acceptance criterion maps to a task:

| Acceptance criterion | Task |
|---|---|
| 1. `repository-work/1.0` resolves at A, appears at B and E, selects at C; unknown URIs still refuse typed | Tasks 3, 4 (+ `venue.test.ts` unknown-profile case) |
| 2. SWE-shaped draft passes lock→launch to the dispatch boundary | Tasks 5 (dispatch) + 6 (quote/lock admission) |
| 3. Prediction sample byte-stable, enumerated suites green unmodified | Task 7 Step 3 (mechanical `git diff` gate) |
| 4. Quote-time coverage duplication stays in sync; cross-check extended not weakened | Task 6 |
| 5. Harvest normalization for `patch`/`summary`/`evidence` parallel to the prediction path | Task 3 Step 3 harvest + Step 1 harvest test |
| 6. Provisioner design decision recorded | § "Deviation from the approved D1 design" |

**Placeholder scan** — no TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the actual content. Two tasks (5, 6) legitimately have no source change; both say so explicitly and both name the exact fallback if a field accessor mismatches, with an explicit prohibition on weakening assertions.

**Type consistency** — `RepositoryMirrorPort.ensure({uri, oid}) => Promise<string>` is defined in Task 1 and consumed with that exact signature in Tasks 3 and 4. `SAMPLE_REPOSITORY_WORK_LAUNCHER_ID` / `_HARNESS_VERSION` are defined in Task 2 and consumed in Task 4 and the Task 6 test. `repositoryMirror` is added to `CreateLocalProvisionerOptions` in Task 3 and passed in Task 4. `SOLVE_HARNESS_PINS["sample-repository-work"]` is defined in Task 4 and consumed in Task 5.
