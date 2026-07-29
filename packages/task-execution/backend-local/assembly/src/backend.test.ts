import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
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
} from "@jinn-network/task-execution-workspace";
import { ProvisioningRejectedError } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
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
  const launcher: LauncherContract = {
    id: "fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
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
      };
    },
  };
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

describe("local TaskExecutionBackend submission path (C1)", () => {
  test("rejects hostile provisioner identities before setup", async () => {
    const backend = fixture(await stateRoot("provisioner-id"), { provisionerId: "\u0000" });
    const task = taskBytes();
    await expect(backend.submit(task, submissionBytes(task))).rejects.toThrow("non-canonical id");
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
