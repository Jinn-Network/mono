import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { LauncherContract, LaunchPlan } from "@jinn-network/task-execution-launchers";
import type { ProvisionerContract, TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "./backend.js";

interface JournalEvent {
  readonly type: string;
  readonly details: Record<string, unknown>;
}

async function journalEvents(root: string, attempt: string): Promise<JournalEvent[]> {
  const file = join(root, "attempts", attempt.slice("urn:uuid:".length), "meta", "journal.jsonl");
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEvent);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

const roots: string[] = [];
const backends: LocalTaskExecutionBackend[] = [];
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get: (digest) => (digest === sealedProfile.digest ? profile : undefined),
};

function barrier(): {
  readonly entered: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
} {
  let enter!: () => void;
  let releaseBarrier!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  return {
    entered,
    async wait() {
      enter();
      await blocked;
    },
    release: releaseBarrier,
  };
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.shutdown()));
  // A just-reaped shim can briefly finish closing its heartbeat/cancellation file while the
  // assertion-owning backend has already drained. Retry only the disposable temp-root cleanup;
  // the journal immutability assertion above remains strict and is never retried.
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

async function stateRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jinn-shutdown-${name}-`));
  roots.push(root);
  return root;
}

function baseConfig(root: string, overrides: Partial<LocalTaskExecutionBackendConfig> = {}): LocalTaskExecutionBackendConfig {
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup(_view, workspace) {
      await Promise.all(Object.values(workspace).map((path) => mkdir(path, { recursive: true })));
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return { manifest: [], omissions: [], integrityViolations: [] };
    },
  };
  const launcher: LauncherContract = {
    id: "shutdown-fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan(_view: TaskView, workspace: WorkspacePaths) {
      return {
        argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
        env: {},
        cwd: workspace.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "shutdown-fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
  return {
    stateRoot: root,
    source: "urn:jinn:backend-local:shutdown-test",
    executor: "urn:jinn:agent:shutdown-test",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "shutdown-fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    ...overrides,
  };
}

function fixture(root: string, overrides: Partial<LocalTaskExecutionBackendConfig> = {}): LocalTaskExecutionBackend {
  const instance = makeLocalTaskExecutionBackend(baseConfig(root, overrides));
  backends.push(instance);
  return instance;
}

let sequence = 0;
function documents(deadline = "2099-01-01T00:00:00Z"): { readonly task: Uint8Array; readonly submission: Uint8Array } {
  sequence += 1;
  const task = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Shutdown barrier fixture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: false }],
  });
  return {
    task,
    submission: sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:61000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:62000000-0000-4000-8000-000000000001",
      idempotencyKey: `shutdown-${sequence}`,
      nonce: `shutdown-nonce-${sequence}`,
      deadline,
    }),
  };
}

function deliveryBytes(attempt: string, taskDigest: string): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt,
    task: taskDigest,
    outputs: [],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
  });
}

describe("writer-lock-safe shutdown (§7.102)", () => {
  test("retains the writer lock until live workers drain and then releases exactly once", async () => {
    const root = await stateRoot("writer-barrier");
    const pause = barrier();
    const first = fixture(root, {
      faults: {
        async onCompletionPhase(phase) {
          if (phase === "before-outcome-wait") await pause.wait();
        },
      },
    });
    const { task, submission } = documents();
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;
    const attempt = (await first.observe(ack.submission)).descriptor.attempt;

    await pause.entered;
    const shuttingDown = first.shutdown();

    const blocked = fixture(root);
    await expect(blocked.recover(attempt)).rejects.toMatchObject({
      category: "backend-unavailable",
    });

    pause.release();
    await shuttingDown;

    const recovered = fixture(root);
    expect(await recovered.recover(attempt)).toEqual({ classification: "matching" });
    await recovered.drain();
  });

  test("sync close delegates to shutdown without releasing while submit is still in flight", async () => {
    const root = await stateRoot("inflight-submit");
    let enterSetup!: () => void;
    let releaseSetup!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      enterSetup = resolve;
    });
    const setupBlocked = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const provisioner: ProvisionerContract = {
      workspaceKind: () => "dir",
      async setup(_view, workspace) {
        enterSetup();
        await setupBlocked;
        await Promise.all(Object.values(workspace).map((path) => mkdir(path, { recursive: true })));
      },
      executionEnv: ({ env }) => ({ ...env }),
      async harvest() {
        return { manifest: [], omissions: [], integrityViolations: [] };
      },
    };
    const launcher: LauncherContract = {
      id: "shutdown-fixture",
      capabilities: () => ({
        taskProfiles: [profile.profile],
        inputMediaTypes: ["application/json"],
        outputMediaTypes: ["text/x-diff"],
        structuredOutput: false,
        resume: false,
        interruptionBehaviorDefault: "repeatable",
        secretForwards: [],
        runPinning: { keys: [] },
      }),
      plan(): LaunchPlan {
        return {
          argv: ["fixture"],
          env: {},
          cwd: "/tmp",
          validExitCodes: [0],
          resultContract: { envelopeFormat: "shutdown-fixture" },
          interruptionBehavior: "repeatable",
        };
      },
    };
    const first = makeLocalTaskExecutionBackend({
      ...baseConfig(root),
      launchers: [launcher],
      provisioner: () => ({ id: "slow-setup", contract: provisioner }),
    });
    backends.push(first);
    const { task, submission } = documents();
    const submitPromise = first.submit(task, submission);
    await setupEntered;
    first.close();
    const blocked = fixture(root);
    await expect(blocked.submit(task, submissionBytes(task))).resolves.toMatchObject({
      accepted: false,
      error: { category: "backend-unavailable" },
    });
    releaseSetup();
    await submitPromise;
    await first.shutdown();
    const reopened = fixture(root);
    expect((await reopened.submit(task, submission)).accepted).toBe(true);
  });

  test("fixed-point drain retains the lock while in-flight submit spawns a worker after shutdown starts", async () => {
    const root = await stateRoot("inflight-spawns-worker");
    const setupPause = barrier();
    const workerPause = barrier();
    let enterSetup!: () => void;
    let releaseSetup!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      enterSetup = resolve;
    });
    const setupBlocked = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const provisioner: ProvisionerContract = {
      workspaceKind: () => "dir",
      async setup(_view, workspace) {
        enterSetup();
        await setupBlocked;
        await Promise.all(Object.values(workspace).map((path) => mkdir(path, { recursive: true })));
      },
      executionEnv: ({ env }) => ({ ...env }),
      async harvest() {
        return { manifest: [], omissions: [], integrityViolations: [] };
      },
    };
    const first = makeLocalTaskExecutionBackend({
      ...baseConfig(root, {
        faults: {
          async onCompletionPhase(phase) {
            if (phase === "before-outcome-wait") await workerPause.wait();
          },
        },
      }),
      launchers: [{
        id: "shutdown-fixture",
        capabilities: () => ({
          taskProfiles: [profile.profile],
          inputMediaTypes: ["application/json"],
          outputMediaTypes: ["text/x-diff"],
          structuredOutput: false,
          resume: false,
          interruptionBehaviorDefault: "repeatable",
          secretForwards: [],
          runPinning: { keys: [] },
        }),
        plan(_view: TaskView, workspace: WorkspacePaths) {
          return {
            argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
            env: {},
            cwd: workspace.work,
            validExitCodes: [0],
            resultContract: { envelopeFormat: "shutdown-fixture" },
            interruptionBehavior: "repeatable",
          };
        },
      }],
      provisioner: () => ({ id: "slow-setup", contract: provisioner }),
    });
    backends.push(first);
    const { task, submission } = documents();
    const submitPromise = first.submit(task, submission);
    await setupEntered;
    const shuttingDown = first.shutdown();
    const blocked = fixture(root);
    await expect(blocked.submit(task, submissionBytes(task))).resolves.toMatchObject({
      accepted: false,
      error: { category: "backend-unavailable" },
    });
    releaseSetup();
    const ack = await submitPromise;
    if (!ack.accepted) throw ack.error;
    const attempt = (await first.observe(ack.submission)).descriptor.attempt;
    await workerPause.entered;
    await expect(blocked.recover(attempt)).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    const journalAtBarrier = await journalEvents(root, attempt);
    workerPause.release();
    await shuttingDown;
    await expect(journalEvents(root, attempt)).resolves.toEqual(journalAtBarrier);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await expect(journalEvents(root, attempt)).resolves.toEqual(journalAtBarrier);
    const reopened = makeLocalTaskExecutionBackend({
      ...baseConfig(root),
      launchers: [{
        id: "shutdown-fixture",
        capabilities: () => ({
          taskProfiles: [profile.profile],
          inputMediaTypes: ["application/json"],
          outputMediaTypes: ["text/x-diff"],
          structuredOutput: false,
          resume: false,
          interruptionBehaviorDefault: "repeatable",
          secretForwards: [],
          runPinning: { keys: [] },
        }),
        plan(_view: TaskView, workspace: WorkspacePaths) {
          return {
            argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
            env: {},
            cwd: workspace.work,
            validExitCodes: [0],
            resultContract: { envelopeFormat: "shutdown-fixture" },
            interruptionBehavior: "repeatable",
          };
        },
      }],
      provisioner: () => ({ id: "slow-setup", contract: provisioner }),
    });
    backends.push(reopened);
    expect(await reopened.recover(attempt)).toEqual({ classification: "matching" });
    await reopened.shutdown();
  });

  test("fixed-point drain releases the lock after allSettled even when a worker rejects", async () => {
    const root = await stateRoot("allsettled-rejection");
    const pause = barrier();
    const first = fixture(root, {
      faults: {
        async onCompletionPhase(phase) {
          if (phase === "before-outcome-wait") {
            await pause.wait();
            throw new Error("worker rejected during shutdown drain");
          }
        },
      },
    });
    const { task, submission } = documents();
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;
    const attempt = (await first.observe(ack.submission)).descriptor.attempt;
    await pause.entered;
    const shuttingDown = first.shutdown();
    pause.release();
    await expect(shuttingDown).resolves.toBeUndefined();
    const reopened = fixture(root);
    expect(await reopened.recover(attempt)).toEqual({ classification: "matching" });
  });

  test("cleared deadline timers never mutate the journal after shutdown and lock handoff", async () => {
    const root = await stateRoot("deadline-timer-ownership");
    const workerPause = barrier();
    const nearDeadline = new Date(Date.now() + 2_000).toISOString();
    const first = fixture(root, {
      faults: {
        async onCompletionPhase(phase) {
          if (phase === "before-outcome-wait") await workerPause.wait();
        },
      },
      launchers: [{
        id: "shutdown-fixture",
        capabilities: () => ({
          taskProfiles: [profile.profile],
          inputMediaTypes: ["application/json"],
          outputMediaTypes: ["text/x-diff"],
          structuredOutput: false,
          resume: false,
          interruptionBehaviorDefault: "repeatable",
          secretForwards: [],
          runPinning: { keys: [] },
        }),
        plan(_view: TaskView, workspace: WorkspacePaths) {
          return {
            argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 30000)"],
            env: {},
            cwd: workspace.work,
            validExitCodes: [0],
            resultContract: { envelopeFormat: "shutdown-fixture" },
            interruptionBehavior: "repeatable",
          };
        },
      }],
    });
    const { task, submission } = documents(nearDeadline);
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;
    const attempt = (await first.observe(ack.submission)).descriptor.attempt;
    await workerPause.entered;
    const shuttingDown = first.shutdown();
    workerPause.release();
    await shuttingDown;
    const journalAtHandoff = await journalEvents(root, attempt);
    fixture(root);
    await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
    expect(await journalEvents(root, attempt)).toEqual(journalAtHandoff);
  });

  test("public mutators reject once shutdown begins without changing durable state", async () => {
    const root = await stateRoot("post-shutdown-mutators");
    const pause = barrier();
    const first = fixture(root, {
      faults: {
        async onCompletionPhase(phase) {
          if (phase === "before-outcome-wait") await pause.wait();
        },
      },
      launchers: [{
        id: "shutdown-fixture",
        capabilities: () => ({
          taskProfiles: [profile.profile],
          inputMediaTypes: ["application/json"],
          outputMediaTypes: ["text/x-diff"],
          structuredOutput: false,
          resume: false,
          interruptionBehaviorDefault: "repeatable",
          secretForwards: [],
          runPinning: { keys: [] },
        }),
        plan(_view: TaskView, workspace: WorkspacePaths) {
          return {
            argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
            env: {},
            cwd: workspace.work,
            validExitCodes: [0],
            resultContract: { envelopeFormat: "shutdown-fixture" },
            interruptionBehavior: "repeatable",
          };
        },
      }],
    });
    const { task, submission } = documents();
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;
    const attempt = (await first.observe(ack.submission)).descriptor.attempt;
    const taskDigest = (await first.observe(ack.submission)).descriptor.task;
    await pause.entered;
    const before = await journalEvents(root, attempt);
    void first.shutdown();
    await expect(first.cancel(attempt, "late")).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    await expect(first.recover(attempt)).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    await expect(first.drive(attempt, [])).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    await expect(first.recordDelivery(attempt, deliveryBytes(attempt, taskDigest))).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    expect(() => first.simulateReconciliation(attempt, { classification: "matching" })).toThrow(TaskExecutionError);
    expect(await journalEvents(root, attempt)).toEqual(before);
    pause.release();
    await first.shutdown();
  });

  test("sync close consumes shutdown drain rejections without unhandled rejections", async () => {
    const root = await stateRoot("close-consumes-rejection");
    const pause = barrier();
    const first = fixture(root, {
      faults: {
        async onCompletionPhase(phase) {
          if (phase === "before-outcome-wait") {
            await pause.wait();
            throw new Error("close drain rejection");
          }
        },
      },
    });
    const { task, submission } = documents();
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;
    await pause.entered;
    first.close();
    pause.release();
    await expect(first.shutdown()).rejects.toThrow("close drain rejection");
  });
});

function submissionBytes(task: Uint8Array): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:63000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
    requester: "urn:uuid:64000000-0000-4000-8000-000000000001",
    idempotencyKey: `shutdown-reopen-${sequence}`,
    nonce: `shutdown-reopen-${sequence}`,
    deadline: "2099-01-01T00:00:00Z",
  });
}
