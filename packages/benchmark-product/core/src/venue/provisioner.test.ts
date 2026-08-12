import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes, parseDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import {
  EVALUATION_TASK_PROFILE_URI,
  REPOSITORY_WORK_PROFILE_URI,
} from "@jinn-network/task-execution-profiles";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import type { TaskSpecification } from "@jinn-network/task-execution-protocol";
import { ProvisioningRejectedError, type DeclaredOutputSlot, type WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  createEvaluationCellRegistry,
  createLocalProvisioner,
  EVALUATOR_REQUIREMENT_KEY,
  type EvaluationCellMaterials,
  type EvaluationCellRegistry,
} from "./provisioner.js";
import { createGitRepositoryMirror } from "./repository-mirror.js";
import { readVerdictEnvelope } from "./signing.js";

const EVALUATOR_1 = "urn:jinn:benchmark-product:local-venue:evaluator-1";
const EVALUATOR_2 = "urn:jinn:benchmark-product:local-venue:evaluator-2";

const VERDICT_OUTPUT: readonly DeclaredOutputSlot[] = [
  { name: "verdict", mediaType: "application/vnd.in-toto+json", required: true },
];

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fakeSigner(keyid: string): DsseSigner {
  return async () => [{ keyid, signature: new Uint8Array([1, 2, 3]) }];
}

function workspacePathsUnder(root: string): WorkspacePaths {
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

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
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

const SEALED_TASK_BYTES = encode(JSON.stringify({ profile: { uri: EVALUATION_TASK_PROFILE_URI } }));
const EVALUATION_SPEC_BYTES = encode(JSON.stringify({ family: "deterministic-process" }));

function registeredMaterials(registry: EvaluationCellRegistry): EvaluationCellMaterials {
  const materials: EvaluationCellMaterials = {
    subjectTaskBytes: encode("subject-task"),
    subjectDeliveryBytes: encode("subject-delivery"),
    resultArtifacts: [{ name: "prediction", bytes: encode("result") }],
    evaluationSpecBytes: EVALUATION_SPEC_BYTES,
    evaluationContextBytes: encode(JSON.stringify({ outcome: "yes" })),
  };
  registry.register(sha256Hex(SEALED_TASK_BYTES), materials);
  return materials;
}

function evaluationInput(requirements: Record<string, unknown> | undefined): LocalProvisionerInput {
  return {
    sealedTaskBytes: SEALED_TASK_BYTES,
    dispatchContextBytes: encode("{}"),
    task: { profile: { uri: EVALUATION_TASK_PROFILE_URI } } as LocalProvisionerInput["task"],
    submission: (requirements === undefined
      ? {}
      : { requirements }) as LocalProvisionerInput["submission"],
    attempt: {
      attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000001",
      nonce: "provisioner-test",
      attemptNumber: 1,
    } as LocalProvisionerInput["attempt"],
  };
}

function verdictStatementBytes(evaluatorId: string): Uint8Array {
  return canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "subject-task.json", digest: { sha256: "c".repeat(64) } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: evaluatorId },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: sha256Hex(EVALUATION_SPEC_BYTES) },
      },
      taskSubject: "subject-task.json",
      resultSubjects: ["prediction"],
      verdict: "pass",
      measurements: [{ name: "integrity", value: true }],
      evaluatedAt: "2026-08-06T00:00:00.000Z",
    },
  });
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "bp21-provisioner-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("createLocalProvisioner evaluator selection", () => {
  it("fails loud at setup when the evaluation Submission carries no evaluator requirement", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [{ id: EVALUATOR_1, signer: fakeSigner("key-1") }],
    });
    const selected = selector(evaluationInput(undefined));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await expect(selected.contract.setup(undefined as never, paths, []))
      .rejects.toThrow(EVALUATOR_REQUIREMENT_KEY);
  });

  it("fails loud at setup when the named evaluator is not one of the venue's", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [{ id: EVALUATOR_1, signer: fakeSigner("key-1") }],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await expect(selected.contract.setup(undefined as never, paths, []))
      .rejects.toThrow(EVALUATOR_2);
  });

  it("seals the harvested verdict with the SELECTED evaluator's id and signer", async () => {
    const registry = createEvaluationCellRegistry();
    const materials = registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    // Without the test-only variation hook, the registered context bytes land verbatim.
    expect(new Uint8Array(readFileSync(join(paths.input, "evaluation-context.json"))))
      .toEqual(materials.evaluationContextBytes);

    writeFileSync(join(paths.out, "verdict"), verdictStatementBytes(EVALUATOR_2));
    const harvested = await selected.contract.harvest(paths, VERDICT_OUTPUT);
    expect(harvested.manifest.map((entry) => entry.path)).toEqual(["verdict"]);

    const envelopeBytes = new Uint8Array(readFileSync(join(paths.out, "verdict")));
    expect(parseDsseEnvelope(envelopeBytes).signatures[0]?.keyid).toBe("key-2");
    expect(readVerdictEnvelope(envelopeBytes).evaluatorId).toBe(EVALUATOR_2);
  });

  it("refuses at harvest a statement claiming a DIFFERENT evaluator than the attempt ran under", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_1 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    writeFileSync(join(paths.out, "verdict"), verdictStatementBytes(EVALUATOR_2));
    await expect(selected.contract.harvest(paths, VERDICT_OUTPUT)).rejects.toThrow();
  });

  it("applies the test-only context-variation hook for the selected evaluator", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
      evaluationContextVariationForTesting: (evaluatorId, contextBytes) =>
        encode(JSON.stringify({ evaluatorId, original: sha256Hex(contextBytes) })),
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    const written = JSON.parse(readFileSync(join(paths.input, "evaluation-context.json"), "utf8")) as {
      readonly evaluatorId: string;
    };
    expect(written.evaluatorId).toBe(EVALUATOR_2);
  });
});

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
    const paths = workspacePathsUnder(root);
    const sealed = new TextEncoder().encode(JSON.stringify({ profile: { uri: REPOSITORY_WORK_PROFILE_URI } }));
    const task = repositoryWorkTask(upstream.uri, upstream.oid);

    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: createGitRepositoryMirror(join(root, "mirrors")),
    })({
      task,
      sealedTaskBytes: sealed,
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await selected.contract.setup({ task } as never, paths, []);

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

    await expect(selected.contract.setup({} as never, workspacePathsUnder(root), []))
      .rejects.toThrow(/no "repository-state" input/u);
  });

  it("throws ProvisioningRejectedError (neverExecuted) for a Task with no repository-state input", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-missing-typed-"));
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

    const rejection = await selected.contract.setup({} as never, workspacePathsUnder(root), [])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProvisioningRejectedError);
    expect((rejection as InstanceType<typeof ProvisioningRejectedError>).neverExecuted).toBe(true);
  });

  it("throws ProvisioningRejectedError (neverExecuted) for a non-40-hex annotations.ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-badref-"));
    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: { ensure: async () => "/unused" },
    })({
      task: repositoryWorkTask("file:///upstream", "not-a-valid-oid"),
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    const rejection = await selected.contract.setup({} as never, workspacePathsUnder(root), [])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProvisioningRejectedError);
    expect((rejection as InstanceType<typeof ProvisioningRejectedError>).neverExecuted).toBe(true);
    expect((rejection as Error).message).toMatch(/40 lowercase hex/u);
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

    await expect(selected.contract.setup({} as never, workspacePathsUnder(root), []))
      .rejects.toThrow(/no repository mirror is configured/u);
  });

  it("throws ProvisioningRejectedError (neverExecuted) when no repository mirror is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-nomirror-typed-"));
    const selected = createLocalProvisioner({ registry: createEvaluationCellRegistry(), evaluators: [] })({
      task: repositoryWorkTask("file:///upstream", "a".repeat(40)),
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    const rejection = await selected.contract.setup({} as never, workspacePathsUnder(root), [])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProvisioningRejectedError);
    expect((rejection as InstanceType<typeof ProvisioningRejectedError>).neverExecuted).toBe(true);
  });

  it("normalizes harvest to the declared slots and moves the structured envelope to meta/", async () => {
    const upstream = makeUpstreamRepository();
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-harvest-"));
    const paths = workspacePathsUnder(root);
    const task = repositoryWorkTask(upstream.uri, upstream.oid);

    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: createGitRepositoryMirror(join(root, "mirrors")),
    })({
      task,
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await selected.contract.setup({ task } as never, paths, []);

    writeFileSync(join(paths.out, "patch.diff"), "--- a/x\n+++ b/x\n");
    writeFileSync(join(paths.out, "structured-output.json"), "{}");
    writeFileSync(join(paths.out, "scratch.txt"), "noise");

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

  it("removes the worktree registration after harvest tears it down", async () => {
    const upstream = makeUpstreamRepository();
    const root = mkdtempSync(join(tmpdir(), "provisioner-repository-work-teardown-"));
    const paths = workspacePathsUnder(root);
    const mirror = createGitRepositoryMirror(join(root, "mirrors"));
    const task = repositoryWorkTask(upstream.uri, upstream.oid);

    const selected = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      repositoryMirror: mirror,
    })({
      task,
      sealedTaskBytes: new TextEncoder().encode("{}"),
      dispatchContextBytes: new TextEncoder().encode("{}"),
      submission: { requirements: {} },
      attempt: { attemptUri: "urn:uuid:x", nonce: "n", attemptNumber: 1 },
    } as never);

    await selected.contract.setup({ task } as never, paths, []);
    expect(existsSync(paths.work)).toBe(true);

    await selected.contract.harvest(paths, [
      { name: "patch", mediaType: "text/x-diff", required: false },
    ] as never);

    expect(existsSync(paths.work)).toBe(false);

    const mirrorDir = await mirror.ensure({ uri: upstream.uri, oid: upstream.oid });
    const worktreeList = gitIn(mirrorDir, "worktree", "list");
    expect(worktreeList).not.toContain(paths.work);
  });
});
