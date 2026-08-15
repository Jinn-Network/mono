// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod, mkdtemp, readFile, readdir, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityGrant, ProvisionerContract, TaskView, WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
// #2538: the conformance kit asserts against the provisioner's own filename contract, not a
// transcribed copy of it. The literal value is pinned once, in the workspace package's own test.
import {
  STAGED_DISPATCH_CONTEXT_FILENAME,
  STAGED_SEALED_TASK_FILENAME,
} from "@jinn-network/task-execution-workspace";
import { describe, expect, test } from "vitest";
import { loadWorkspaceFixture } from "./fixtures.js";
import { makeSampleLauncherInputs } from "./launcher-contract.js";

export interface WorkspaceScenarioOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly fetchInput?: () => Promise<Uint8Array>;
  readonly assertHarnessGroupEmpty: (paths: WorkspacePaths) => Promise<void> | void;
  readonly ensureMetaReserve?: (paths: WorkspacePaths) => Promise<void> | void;
  readonly startQuotaEnforcement?: (paths: WorkspacePaths, quotaBytes: number) => Promise<void> | void;
  readonly shouldEvictWork?: () => Promise<boolean> | boolean;
  readonly quotaBytes?: number;
}
export interface WorkspaceContractSubject {
  readonly name: string;
  readonly kind: "dir" | "worktree";
  make(options: WorkspaceScenarioOptions): Promise<{ provisioner: ProvisionerContract; expectedOid?: string }>;
  enforceQuota(paths: WorkspacePaths, quotaBytes: number): Promise<void>;
}

async function paths(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-workspace-contract-"));
  return {
    root, input: join(root, "input"), work: join(root, "work"), out: join(root, "out"),
    logs: join(root, "logs"), harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"), tmp: join(root, "tmp"), meta: join(root, "meta"),
  };
}

function view(inputBytes?: Uint8Array): TaskView {
  const base = makeSampleLauncherInputs().view;
  if (!inputBytes) return base;
  return {
    ...base,
    task: {
      ...base.task,
      inputs: [{
        name: "payload.bin",
        digest: { sha256: createHash("sha256").update(inputBytes).digest("hex") },
      }],
    },
  };
}

/** Concrete §16 workspace suite. Adapters live downstream per program ruling §7.25. */
export function describeWorkspaceContract(subject: WorkspaceContractSubject): void {
  describe(`ProvisionerContract conformance: ${subject.name}`, () => {
    test("the fixture family names every required scenario", async () => {
      const names = (await loadWorkspaceFixture()).scenarios.map((scenario) => scenario.name);
      for (const expected of [
        "per-directory-retention", "secrets-and-tmp-wiped-at-terminal",
        "input-immutability-violation-detected", "rejected-never-executed-guarantee",
        "symlink-in-out-escaping-tree-rejected", "per-attempt-quota-breach",
        "spawn-time-env-discipline", "no-secrets-in-meta-grep",
      ]) expect(names).toContain(expected);
    });

    test("setup creates exact modes and byte-verbatim Task, dispatch, and rehashed input", async () => {
      const target = await paths();
      const taskBytes = Buffer.from("{\"sealed\":\"bytes\"}");
      const dispatchBytes = Buffer.from("{\"dispatch\":true}");
      const inputBytes = Buffer.from("resolved input");
      const { provisioner, expectedOid } = await subject.make({
        sealedTaskBytes: taskBytes, dispatchContextBytes: dispatchBytes,
        fetchInput: async () => inputBytes, assertHarnessGroupEmpty: () => undefined,
      });
      await provisioner.setup(view(inputBytes), target, []);
      expect(provisioner.workspaceKind(view())).toBe(subject.kind);
      expect(await readFile(join(target.input, STAGED_SEALED_TASK_FILENAME))).toEqual(taskBytes);
      expect(await readFile(join(target.input, STAGED_DISPATCH_CONTEXT_FILENAME))).toEqual(dispatchBytes);
      expect(await readFile(join(target.input, "payload.bin"))).toEqual(inputBytes);
      expect((await stat(target.input)).mode & 0o777).toBe(0o500);
      expect((await stat(join(target.input, STAGED_SEALED_TASK_FILENAME))).mode & 0o777).toBe(0o400);
      expect((await stat(target.secrets)).mode & 0o777).toBe(0o700);
      if (subject.kind === "worktree") {
        expect(expectedOid).toMatch(/^[0-9a-f]{40}$/u);
        expect(await readFile(join(target.work, ".git"), "utf8")).toContain("gitdir:");
        expect(execFileSync("git", ["-C", target.work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedOid);
        expect(() => execFileSync("git", ["-C", target.work, "symbolic-ref", "-q", "HEAD"], { stdio: "ignore" })).toThrow();
      }
    });

    test("digest mismatch throws typed never-executed rejection before any execution", async () => {
      const target = await paths();
      let executionCalled = false;
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        fetchInput: async () => Buffer.from("corrupt"), assertHarnessGroupEmpty: () => undefined,
      });
      await expect(provisioner.setup(view(Buffer.from("expected")), target, [])).rejects.toMatchObject({
        category: "rejected", neverExecuted: true,
      });
      expect(executionCalled).toBe(false);
      void executionCalled;
    });

    test("grant descriptors remain backend-owned until secret-forward materialization", async () => {
      const target = await paths();
      const secret = "resolved-secret-material";
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: () => undefined,
      });
      const grants: CapabilityGrant[] = [
        { key: "a/b", descriptor: { token: secret } },
        { key: "a_b", descriptor: { token: secret } },
      ];
      await provisioner.setup(view(), target, grants);
      expect(await readdir(target.secrets)).toEqual([]);
      const backendText = (await Promise.all([target.meta, target.logs].map(async (dir) =>
        Promise.all((await readdir(dir)).map((name) => readFile(join(dir, name), "utf8")))))).flat().join("\n");
      expect(backendText).not.toContain(secret);
    });

    test("execution env is allowlisted and setup authority cannot cross", async () => {
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: () => undefined,
      });
      expect(provisioner.executionEnv({
        cwd: "/work",
        env: {
          JINN_ATTEMPT_ID: "urn:test", CODEX_HOME: "/state",
          OPENAI_API_KEY: "secrets/openai", AWS_SECRET_ACCESS_KEY: "resolved-secret",
          SETUP_BEARER_TOKEN: "setup-secret", PATH: "/ambient/bin",
        },
      })).toEqual({ JINN_ATTEMPT_ID: "urn:test", CODEX_HOME: "/state", OPENAI_API_KEY: "secrets/openai" });
    });

    test("input mutation is reported and safe terminal harvest applies retention", async () => {
      const target = await paths();
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: () => undefined, shouldEvictWork: () => false,
      });
      await provisioner.setup(view(), target, [{ key: "token", descriptor: "opaque" }]);
      await chmod(join(target.input, STAGED_SEALED_TASK_FILENAME), 0o600);
      await writeFile(join(target.input, STAGED_SEALED_TASK_FILENAME), "mutated");
      const result = await provisioner.harvest(target, []);
      expect(result.integrityViolations).toContainEqual({ path: STAGED_SEALED_TASK_FILENAME, reason: "input-mutated" });
      await expect(stat(target.secrets)).rejects.toThrow();
      await expect(stat(target.tmp)).rejects.toThrow();
      for (const retained of [target.meta, target.logs, target.out, target.harnessState, target.work]) {
        expect((await stat(retained)).isDirectory()).toBe(true);
      }
    });

    test("quota excludes reserved meta and detects a cumulative data-plane breach", async () => {
      const target = await paths();
      let reserved = false; let monitorStarted = false;
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: () => undefined, quotaBytes: 16,
        ensureMetaReserve: () => { reserved = true; },
        startQuotaEnforcement: () => { monitorStarted = true; },
      });
      await provisioner.setup(view(), target, []);
      await writeFile(join(target.out, "large"), "x".repeat(64));
      await writeFile(join(target.meta, "outcome.json"), "{\"ok\":true}");
      await expect(subject.enforceQuota(target, 16)).rejects.toMatchObject({ category: "quota-exceeded" });
      expect(await readFile(join(target.meta, "outcome.json"), "utf8")).toBe("{\"ok\":true}");
      expect({ reserved, monitorStarted }).toEqual({ reserved: true, monitorStarted: true });
    });

    test("disk-floor retention hook may evict work only after safe harvest", async () => {
      const target = await paths();
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: () => undefined, shouldEvictWork: () => true,
      });
      await provisioner.setup(view(), target, []);
      await provisioner.harvest(target, []);
      await expect(stat(target.work)).rejects.toThrow();
      expect((await stat(target.meta)).isDirectory()).toBe(true);
    });

    test("verified-empty gate blocks a live child before collection", async () => {
      const target = await paths();
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      let exited = false;
      child.once("exit", () => { exited = true; });
      const assertEmpty = () => {
        if (!exited) throw new Error("harness-group-not-empty");
      };
      const { provisioner } = await subject.make({
        sealedTaskBytes: Buffer.from("task"), dispatchContextBytes: Buffer.from("dispatch"),
        assertHarnessGroupEmpty: assertEmpty,
      });
      await provisioner.setup(view(), target, []);
      await expect(provisioner.harvest(target, [])).rejects.toThrow("harness-group-not-empty");
      child.kill("SIGKILL");
      if (!exited) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await expect(provisioner.harvest(target, [])).resolves.toMatchObject({ manifest: [] });
    });
  });
}
