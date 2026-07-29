import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import type { LaunchPlan } from "@jinn-network/task-execution-launchers";
import {
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type {
  ProvisionerContract,
  TaskView,
  WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import { ProvisioningRejectedError } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "./backend.js";

const roots: string[] = [];
const backends: LocalTaskExecutionBackend[] = [];
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedProfile.digest ? profile : undefined;
  },
};

async function stateRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jinn-local-backend-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => {
    await backend.drain();
    backend.close();
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function taskBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Exercise the local backend assembly.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    ...overrides,
  });
}

let sequence = 0;
function submissionBytes(
  task: Uint8Array,
  overrides: Record<string, unknown> = {},
): Uint8Array {
  sequence += 1;
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
    requester: "urn:uuid:20000000-0000-4000-8000-000000000001",
    idempotencyKey: `backend-test-${sequence}`,
    nonce: `nonce-${sequence}`,
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

function fixture(
  root: string,
  options: {
    capturedViews?: TaskView[];
    afterDeliveryCheckpoint?: () => void;
    maxConcurrentAttempts?: number;
    provisioningRejectReason?: string;
    argv?: readonly string[];
    provisionerId?: string;
    launcher?: LauncherContract;
    secretForwardResolver?: LocalTaskExecutionBackendConfig["secretForwardResolver"];
    capabilityGrants?: LocalTaskExecutionBackendConfig["capabilityGrants"];
    launcherDeployments?: LocalTaskExecutionBackendConfig["launcherDeployments"];
  } = {},
): LocalTaskExecutionBackend {
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup() {
      if (options.provisioningRejectReason !== undefined) {
        throw new ProvisioningRejectedError(options.provisioningRejectReason);
      }
    },
    executionEnv: (launch) => ({ ...launch.env }),
    async harvest() {
      return { manifest: [], omissions: [], integrityViolations: [] };
    },
  };
  const defaultLauncher: LauncherContract = {
    id: "fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          {
            key: "effort",
            inventory: ["low", "medium", "high", "xhigh", "max"],
            posture: "enforced",
          },
          { key: "harness", inventory: ["fixture"], posture: "enforced" },
        ],
      },
    }),
    plan(view, paths) {
      options.capturedViews?.push(view);
      return {
        argv: options.argv ?? ["fixture"],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
  const launcher = options.launcher ?? defaultLauncher;
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:assembly-test",
    executor: "urn:jinn:agent:assembly-test",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: options.provisionerId ?? "fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    maxConcurrentAttempts: options.maxConcurrentAttempts ?? 8,
    ...(options.secretForwardResolver === undefined
      ? {}
      : { secretForwardResolver: options.secretForwardResolver }),
    ...(options.capabilityGrants === undefined
      ? {}
      : { capabilityGrants: options.capabilityGrants }),
    ...(options.launcherDeployments === undefined
      ? {}
      : { launcherDeployments: options.launcherDeployments }),
    faults: { afterDeliveryCheckpoint: options.afterDeliveryCheckpoint },
  });
  backends.push(backend);
  return backend;
}

async function acceptedAttempt(
  backend: LocalTaskExecutionBackend,
  task: Uint8Array,
  submission: Uint8Array,
): Promise<`urn:uuid:${string}`> {
  const ack = await backend.submit(task, submission);
  if (!ack.accepted) throw new Error(`expected acceptance: ${ack.error.category}`);
  return (await backend.observe(ack.submission)).descriptor.attempt;
}

async function allFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.push(path);
    }
  }
  await walk(root);
  return result;
}

function readResultEnvelopeForTest(backend: LocalTaskExecutionBackend): (
  paths: WorkspacePaths,
  plan: LaunchPlan,
  harvest: {
    readonly manifest: readonly { readonly path: string }[];
    readonly integrityViolations: readonly { readonly path: string }[];
  },
) => unknown {
  return (backend as unknown as {
    readResultEnvelope: (
      paths: WorkspacePaths,
      plan: LaunchPlan,
      harvest: {
        readonly manifest: readonly { readonly path: string }[];
        readonly integrityViolations: readonly { readonly path: string }[];
      },
    ) => unknown;
  }).readResultEnvelope.bind(backend);
}

function envelopePlan(): LaunchPlan {
  return {
    argv: ["fixture"],
    env: {},
    cwd: "/tmp",
    validExitCodes: [0],
    resultContract: {
      envelopeFormat: "fixture",
      structuredOutputArtifact: "out/result.json",
    },
    interruptionBehavior: "repeatable",
  };
}

function envelopePaths(root: string): WorkspacePaths {
  return {
    root,
    work: join(root, "work"),
    input: join(root, "in"),
    out: join(root, "out"),
    tmp: join(root, "tmp"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness"),
    secrets: join(root, "secrets"),
    meta: join(root, "meta"),
  };
}

describe("result-envelope admission", () => {
  test("rejects a symlinked envelope even if its manifest name is claimed", async () => {
    const root = await stateRoot("envelope-symlink");
    const paths = envelopePaths(root);
    await mkdir(paths.out, { recursive: true });
    const outside = join(root, "outside.json");
    await writeFile(outside, '{"ok":true}');
    await symlink(outside, join(paths.out, "result.json"));
    const backend = fixture(root);

    expect(() => readResultEnvelopeForTest(backend)(paths, envelopePlan(), {
      manifest: [{ path: "result.json" }],
      integrityViolations: [],
    })).toThrow("escaped out/");
  });

  test("rejects invalid UTF-8 in an admitted envelope", async () => {
    const root = await stateRoot("envelope-utf8");
    const paths = envelopePaths(root);
    await mkdir(paths.out, { recursive: true });
    await writeFile(join(paths.out, "result.json"), Buffer.from([0xff]));
    const backend = fixture(root);

    expect(() => readResultEnvelopeForTest(backend)(paths, envelopePlan(), {
      manifest: [{ path: "result.json" }],
      integrityViolations: [],
    })).toThrow(TypeError);
  });

  test("rejects an envelope present on disk but absent from the verified manifest", async () => {
    const root = await stateRoot("envelope-manifest");
    const paths = envelopePaths(root);
    await mkdir(paths.out, { recursive: true });
    await writeFile(join(paths.out, "result.json"), '{"ok":true}');
    const backend = fixture(root);

    expect(() => readResultEnvelopeForTest(backend)(paths, envelopePlan(), {
      manifest: [],
      integrityViolations: [],
    })).toThrow("not admitted by verified harvest");
  });
});

describe("local TaskExecutionBackend submission path (C1)", () => {
  test("uses the exact same deployment probe for enforced capability, preflight, and submit", async () => {
    const probe = vi.fn(async () => ({
      ready: true,
      executable: { path: "/opt/jinn/fixture", digest: "a".repeat(64) },
      models: ["fixture-model"],
    }));
    const backend = fixture(await stateRoot("deployment-pinning"), {
      launcherDeployments: {
        fixture: {
          executable: { path: "/opt/jinn/fixture", digest: "a".repeat(64) },
          probe,
        },
      },
    });
    expect((await backend.capabilities()).runPinning.keys).toContainEqual({
      key: "harness", inventory: ["fixture"], posture: "enforced",
    });
    await expect(backend.preflight({ taskProfile: profile.profile })).resolves.toEqual({ ready: true });
    const task = taskBytes();
    await expect(backend.submit(task, submissionBytes(task))).resolves.toMatchObject({ accepted: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("rejects a swapped executable before setup or spawn", async () => {
    const setup = vi.fn(async () => undefined);
    const launcher: LauncherContract = {
      id: "fixture",
      capabilities: () => ({
        taskProfiles: [profile.profile], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false,
        resume: false, interruptionBehaviorDefault: "repeatable", secretForwards: [],
        runPinning: { keys: [{ key: "harness", inventory: ["fixture"], posture: "enforced" }] },
      }),
      plan() { throw new Error("must not plan"); },
    };
    const root = await stateRoot("swapped-executable");
    const backend = makeLocalTaskExecutionBackend({
      stateRoot: root, source: "urn:test", executor: "urn:test", profileStore, launchers: [launcher],
      provisioner: () => ({ id: "fixture", contract: {
        workspaceKind: () => "dir", setup, executionEnv: (value) => ({ ...value.env }),
        async harvest() { return { manifest: [], omissions: [], integrityViolations: [] }; },
      } }),
      provisionerCapabilities: { taskProfiles: [profile.profile], workspaceKinds: ["dir"], inputMediaTypes: [], outputMediaTypes: [], isolation: [] },
      launcherDeployments: {
        fixture: {
          executable: { path: "/opt/jinn/fixture", digest: "a".repeat(64) },
          async probe() { return { ready: true, executable: { path: "/tmp/swapped", digest: "a".repeat(64) } }; },
        },
      },
    });
    backends.push(backend);
    const task = taskBytes();
    await expect(backend.submit(task, submissionBytes(task))).resolves.toMatchObject({
      accepted: false, error: { category: "unsupported-requirement", detail: "executable identity mismatch" },
    });
    expect(setup).not.toHaveBeenCalled();
  });

  test.each([
    ["model", { id: "fixture-model" }],
    ["harness", { id: "fixture", version: "1.2.3", digest: "a".repeat(64) }],
    ["loadout", { kind: "jinn.skill.v1", name: "skill", digest: { sha256: "b".repeat(64) } }],
  ])("rejects an unconfigured required %s pin before intent or spawn", async (key, value) => {
    const setup = vi.fn(async () => undefined);
    const launcher: LauncherContract = {
      id: "fixture",
      capabilities: () => ({
        taskProfiles: [profile.profile], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false,
        resume: false, interruptionBehaviorDefault: "repeatable", secretForwards: [],
        runPinning: { keys: ["harness", "model", "loadout"].map((pinningKey) => ({
          key: pinningKey, inventory: [pinningKey === "harness" ? "fixture" : pinningKey === "model" ? "fixture-model" : "jinn.skill.v1"], posture: "enforced" as const,
        })) },
      }),
      plan() { throw new Error("must not plan"); },
    };
    const root = await stateRoot(`unconfigured-${key}`);
    const backend = makeLocalTaskExecutionBackend({
      stateRoot: root, source: "urn:test", executor: "urn:test", profileStore, launchers: [launcher],
      provisioner: () => ({ id: "fixture", contract: { workspaceKind: () => "dir", setup, executionEnv: (entry) => ({ ...entry.env }), async harvest() { return { manifest: [], omissions: [], integrityViolations: [] }; } } }),
      provisionerCapabilities: { taskProfiles: [profile.profile], workspaceKinds: ["dir"], inputMediaTypes: [], outputMediaTypes: [], isolation: [] },
    });
    backends.push(backend);
    const task = taskBytes();
    const ack = await backend.submit(task, submissionBytes(task, { requirements: { [key]: value } }));
    expect(ack).toMatchObject({ accepted: false, error: { category: "unsupported-requirement" } });
    expect(setup).not.toHaveBeenCalled();
    expect(await allFiles(root)).not.toContainEqual(expect.stringContaining("journal.jsonl"));
  });

  test("preflight scopes resolver-ready launchers and does not probe unavailable secret launchers", async () => {
    const secretProbe = vi.fn(async () => ({ ready: true }));
    const plainProbe = vi.fn(async () => ({ ready: true }));
    const secretLauncher: LauncherContract = {
      id: "secret",
      capabilities: () => ({
        taskProfiles: [profile.profile], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false,
        resume: false, interruptionBehaviorDefault: "repeatable",
        secretForwards: [{ grantKey: "key", target: "key" }],
        runPinning: { keys: [{ key: "harness", inventory: ["secret"], posture: "enforced" }] },
      }),
      probe: secretProbe,
      plan() { throw new Error("not used"); },
    };
    const plainLauncher: LauncherContract = {
      id: "plain",
      capabilities: () => ({
        taskProfiles: [profile.profile], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false,
        resume: false, interruptionBehaviorDefault: "repeatable", secretForwards: [],
        runPinning: { keys: [{ key: "harness", inventory: ["plain"], posture: "enforced" }] },
      }),
      probe: plainProbe,
      plan() { throw new Error("not used"); },
    };
    const root = await stateRoot("preflight-secret-forward");
    const backend = makeLocalTaskExecutionBackend({
      stateRoot: root,
      source: "urn:jinn:backend-local:assembly-test",
      executor: "urn:jinn:agent:assembly-test",
      profileStore,
      launchers: [secretLauncher, plainLauncher],
      provisioner: () => { throw new Error("not used"); },
      provisionerCapabilities: {
        taskProfiles: [profile.profile], workspaceKinds: ["dir"], inputMediaTypes: [], outputMediaTypes: [], isolation: ["process"],
      },
    });
    backends.push(backend);

    expect((await backend.capabilities()).taskProfiles).toEqual([profile.profile]);
    expect((await backend.capabilities()).runPinning.keys).toContainEqual({
      key: "harness", inventory: ["plain"], posture: "attested",
    });
    await expect(backend.preflight({ requirements: { harness: { id: "secret" } } }))
      .resolves.toMatchObject({ ready: false, error: { category: "backend-unavailable" } });
    expect(secretProbe).not.toHaveBeenCalled();
    await expect(backend.preflight({ taskProfile: profile.profile }))
      .resolves.toEqual({ ready: true });
    expect(plainProbe).toHaveBeenCalledOnce();
    expect(secretProbe).not.toHaveBeenCalled();
  });

  test("rejects a plan whose forwards differ from its static declaration before spawn", async () => {
    const resolve = vi.fn(async () => new TextEncoder().encode("secret-value"));
    const launcher: LauncherContract = {
      id: "fixture",
      capabilities: () => ({
        taskProfiles: [profile.profile], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false,
        resume: false, interruptionBehaviorDefault: "repeatable", secretForwards: [],
        runPinning: { keys: [{ key: "harness", inventory: ["fixture"], posture: "enforced" }] },
      }),
      plan(_view, paths) {
        return {
          argv: [process.execPath, "-e", "process.exit(0)"], env: { SECRET: "secrets/key" }, cwd: paths.work,
          validExitCodes: [0], resultContract: { envelopeFormat: "fixture" }, interruptionBehavior: "repeatable",
          secretForwards: [{ grantKey: "key", target: "key" }],
        };
      },
    };
    const root = await stateRoot("static-secret-forward");
    const backend = fixture(root, {
      launcher,
      capabilityGrants: (grants) => Object.entries(grants).map(([key, descriptor]) => ({ key, descriptor })),
      secretForwardResolver: { resolve },
    });
    const task = taskBytes();
    const ack = await backend.submit(task, submissionBytes(task, {
      capabilityGrants: { key: { reference: "opaque" } },
      requirements: { harness: { id: "fixture" } },
    }));
    expect(ack).toMatchObject({ accepted: false, error: { category: "unsupported-requirement" } });
    expect(resolve).not.toHaveBeenCalled();
    const events = (await Promise.all((await allFiles(root))
      .filter((path) => path.endsWith("journal.jsonl"))
      .map((path) => readFile(path, "utf8")))).join("\n");
    expect(events).not.toContain('"type":"spawn-intended"');
  });

  test.runIf(process.platform === "linux")("fails preflight closed and withdraws custody claims when the Linux probe fails", async () => {
    const root = await stateRoot("custody-probe-failure");
    const prior = process.env["JINN_NATIVE_CUSTODY_BINARY"];
    process.env["JINN_NATIVE_CUSTODY_BINARY"] = join(root, "missing-native-custodian");
    try {
      const backend = fixture(root);
      backends.push(backend);
      expect((await backend.preflight({})).ready).toBe(false);
      expect((await backend.capabilities()).cancel).toBe(false);
      expect((await backend.capabilities()).deadlineEnforcement).toBe(false);
    } finally {
      if (prior === undefined) delete process.env["JINN_NATIVE_CUSTODY_BINARY"];
      else process.env["JINN_NATIVE_CUSTODY_BINARY"] = prior;
    }
  });

  test("rejects hostile provisioner identities before setup", async () => {
    const backend = fixture(await stateRoot("provisioner-id"), { provisionerId: "\u0000" });
    const task = taskBytes();
    const ack = await backend.submit(task, submissionBytes(task));
    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("backend-unavailable");
  });

  test("starts a real shim without an in-process execution callback", async () => {
    const root = await stateRoot("real-shim");
    const backend = fixture(root, {
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 200)"],
    });
    const task = taskBytes();
    const attempt = await acceptedAttempt(backend, task, submissionBytes(task));
    const shim = join(root, "attempts", attempt.slice("urn:uuid:".length), "meta", "shim.json");
    for (let index = 0; index < 40; index += 1) {
      try {
        expect(JSON.parse(await readFile(shim, "utf8"))).toMatchObject({ nonce: expect.any(String) });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("real shim fingerprint was never published");
  });

  test("preserves byte-exact idempotency and rejects a same-scope byte conflict", async () => {
    const backend = fixture(await stateRoot("idempotency"));
    const task = taskBytes();
    const first = submissionBytes(task, { idempotencyKey: "same-scope" });
    const conflicting = sealSubmission({
      ...JSON.parse(new TextDecoder().decode(first)),
      nonce: "different-nonce",
    });

    const firstAck = await backend.submit(task, first);
    expect(await backend.submit(task, first)).toEqual(firstAck);
    const conflict = await backend.submit(task, conflicting);
    expect(conflict.accepted).toBe(false);
    if (conflict.accepted) throw new Error("unreachable");
    expect(conflict.error.category).toBe("submission-conflict");
  });

  test("uses protocol mergeRequirements and passes its effective map into TaskView", async () => {
    const capturedViews: TaskView[] = [];
    const backend = fixture(await stateRoot("effective"), { capturedViews });
    const task = taskBytes({ requirements: { effort: "medium" } });
    const submission = submissionBytes(task, { requirements: { effort: "high" } });

    expect((await backend.submit(task, submission)).accepted).toBe(true);
    expect(capturedViews).toHaveLength(1);
    expect(capturedViews[0]?.effectiveRequirements).toEqual({ effort: "high" });
  });

  test("maps a comparison-class violation to invalid-document, never unsupported-requirement", async () => {
    const root = await stateRoot("invalid-merge");
    const backend = fixture(root);
    const task = taskBytes({ requirements: { effort: "high" } });
    const submission = submissionBytes(task, { requirements: { effort: "low" } });

    const ack = await backend.submit(task, submission);
    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("invalid-document");
    expect(ack.error.annotations).toEqual({ key: "effort" });

    const journalText = (
      await Promise.all(
        (await allFiles(root))
          .filter((path) => path.endsWith("submission.jsonl"))
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    expect(journalText).toContain('"category":"invalid-document"');
  });

  test.each([
    ["unknown requirement", { requirements: { "x.example/mandatory": true } }],
    ["attempt bound", { attempts: { maxTotal: 2 } }],
  ])("honor-or-reject maps %s to journaled unsupported-requirement", async (_name, overrides) => {
    const root = await stateRoot("unsupported");
    const backend = fixture(root);
    const task = taskBytes();
    const ack = await backend.submit(task, submissionBytes(task, overrides));

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("unsupported-requirement");
    const journalText = (
      await Promise.all(
        (await allFiles(root))
          .filter((path) => path.endsWith("submission.jsonl"))
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    expect(journalText).toContain('"category":"unsupported-requirement"');
  });

  test("adopts a valid two-party attempt URI and scopes attempts bounds to that attempt", async () => {
    const backend = fixture(await stateRoot("two-party"));
    const task = taskBytes();
    const submission = submissionBytes(task, { attempts: { maxTotal: 2 } });
    const parsed = JSON.parse(new TextDecoder().decode(submission)) as {
      submission: `urn:uuid:${string}`;
      nonce: string;
    };
    const attemptUri = "urn:uuid:30000000-0000-4000-8000-000000000001";
    const ack = await backend.submit(task, submission, {
      attemptUri,
      dispatchContext: {
        taskDigest: documentDigest(task),
        submission: parsed.submission,
        nonce: parsed.nonce,
        attempt: attemptUri,
      },
    });

    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect((await backend.observe(ack.submission)).descriptor.attempt).toBe(attemptUri);
  });

  test("rejects immediately at the live-attempt capacity ceiling without queuing", async () => {
    const backend = fixture(await stateRoot("capacity"), { maxConcurrentAttempts: 1 });
    const firstTask = taskBytes();
    expect((await backend.submit(firstTask, submissionBytes(firstTask))).accepted).toBe(true);

    const secondTask = taskBytes();
    const second = await backend.submit(secondTask, submissionBytes(secondTask));
    expect(second.accepted).toBe(false);
    if (second.accepted) throw new Error("unreachable");
    expect(second.error).toMatchObject({
      category: "backend-unavailable",
      retryable: true,
    });
    expect(second.error.detail).toContain("never queued");
  });

  test("a second live instance on one root fails submit and recover as backend-unavailable", async () => {
    const root = await stateRoot("writer");
    const first = fixture(root);
    const task = taskBytes();
    const submission = submissionBytes(task);
    const firstAck = await first.submit(task, submission);
    if (!firstAck.accepted) throw new Error("unreachable");

    const second = fixture(root);
    const anotherTask = taskBytes();
    const secondAck = await second.submit(anotherTask, submissionBytes(anotherTask));
    expect(secondAck.accepted).toBe(false);
    if (secondAck.accepted) throw new Error("unreachable");
    expect(secondAck.error.category).toBe("backend-unavailable");
    await expect(second.recover(firstAck.submission)).rejects.toMatchObject({
      category: "backend-unavailable",
    });
  });

  test("projects typed provisioning refusal to terminal rejected before any exec-started fact", async () => {
    const root = await stateRoot("provisioning-rejected");
    const backend = fixture(root, { provisioningRejectReason: "input digest mismatch" });
    const task = taskBytes();
    const ack = await backend.submit(task, submissionBytes(task));
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await backend.observe(ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "rejected",
      terminal: true,
    });
    expect(
      snapshot.observations.some(
        (observation) =>
          observation.type === "network.jinn.task-execution.attempt-started.v1",
      ),
    ).toBe(false);
    const journalText = (
      await Promise.all(
        (await allFiles(root))
          .filter((path) => path.endsWith("journal.jsonl"))
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    expect(journalText).toContain('"neverExecuted":true');
  });
});

describe("seal-once Delivery checkpoint (C1)", () => {
  test("recovery reuses exact checkpoint bytes after a crash between checkpoint and journal record", async () => {
    const root = await stateRoot("checkpoint");
    let crash = true;
    let backend = fixture(root, {
      afterDeliveryCheckpoint() {
        if (crash) throw new Error("scripted crash after checkpoint");
      },
    });
    const task = taskBytes();
    const submission = submissionBytes(task);
    const attempt = await acceptedAttempt(backend, task, submission);
    const delivery = sealDelivery({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      attempt,
      task: documentDigest(task),
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-07-28T00:05:00Z",
    });

    await expect(backend.recordDelivery(attempt, delivery)).rejects.toThrow("scripted crash");
    backend.close();
    crash = false;
    backend = fixture(root);
    expect(await backend.recover(attempt)).toEqual({ classification: "matching" });
    const refs = await backend.deliveries(attempt);
    expect(refs).toHaveLength(1);
    expect(await backend.fetchDelivery(refs[0]!)).toEqual(delivery);
    expect(refs[0]?.digest).toBe(documentDigest(delivery));
  });

  test("ignores a torn temporary variant and re-reads the published checkpoint", async () => {
    const root = await stateRoot("torn-checkpoint");
    let backend = fixture(root);
    const task = taskBytes();
    const attempt = await acceptedAttempt(backend, task, submissionBytes(task));
    const delivery = sealDelivery({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      attempt,
      task: documentDigest(task),
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-07-28T00:05:00Z",
    });
    await backend.recordDelivery(attempt, delivery);
    const checkpoint = backend.deliveryCheckpointPath(attempt);
    await writeFile(`${checkpoint}.tmp-torn`, delivery.subarray(0, 13));
    backend.close();

    backend = fixture(root);
    const refs = await backend.deliveries(attempt);
    expect(await backend.fetchDelivery(refs[0]!)).toEqual(delivery);
  });

  test("recovery replays a durable Delivery checkpoint exactly once", async () => {
    const root = await stateRoot("checkpoint-idempotent-replay");
    const backend = fixture(root);
    const task = taskBytes();
    const attempt = await acceptedAttempt(backend, task, submissionBytes(task));
    const delivery = sealDelivery({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      attempt,
      task: documentDigest(task),
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-07-28T00:05:00Z",
    });
    await backend.recordDelivery(attempt, delivery);

    await backend.recover(attempt);
    await backend.recover(attempt);
    const journal = (await Promise.all(
      (await allFiles(root)).filter((path) => path.endsWith("journal.jsonl")).map((path) => readFile(path, "utf8")),
    )).join("\n");
    expect((journal.match(/\"type\":\"delivery-recorded\"/g) ?? [])).toHaveLength(1);
    expect(await backend.fetchDelivery((await backend.deliveries(attempt))[0]!)).toEqual(delivery);
  });
});

test("a malformed Task is a typed invalid-document SubmissionAck", async () => {
  const backend = fixture(await stateRoot("malformed"));
  const malformed = new TextEncoder().encode('{"protocol":"https://jinn.network/profiles/task-execution/1.0"}');
  const validTask = taskBytes();
  const ack = await backend.submit(malformed, submissionBytes(validTask));
  expect(ack.accepted).toBe(false);
  if (ack.accepted) throw new Error("unreachable");
  expect(ack.error).toMatchObject({
    category: "invalid-document",
  } satisfies Partial<TaskExecutionError>);
});
