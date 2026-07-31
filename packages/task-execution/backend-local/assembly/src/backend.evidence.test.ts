import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import {
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  documentDigest,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { ProvisionerContract } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "./backend.js";

const roots: string[] = [];
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedProfile.digest ? profile : undefined;
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jinn-backend-evidence-"));
  roots.push(root);
  return root;
}

function documents(): { task: Uint8Array; submission: Uint8Array } {
  const task = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Capture this execution.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  return {
    task,
    submission: sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:${crypto.randomUUID()}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000001",
      idempotencyKey: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      deadline: "2099-01-01T00:00:00Z",
    }),
  };
}

function backend(
  root: string,
  repository: EvidenceRepository,
  onAwaitIndexed: () => void,
  deliveryExtensions?: LocalTaskExecutionBackendConfig["deliveryExtensions"],
): LocalTaskExecutionBackend {
  const launcher: LauncherContract = {
    id: "fixture",
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
    plan(_view, paths) {
      return {
        argv: [process.execPath, "-e", "process.exit(0)"],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup(_view, paths) {
      await Promise.all(
        Object.values(paths).map((path) => mkdir(path, { recursive: true })),
      );
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return { manifest: [], omissions: ["patch"], integrityViolations: [] };
    },
  };
  return makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:evidence-test",
    executor: "https://jinn.network/software/fake-launcher",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    recorderAvailability: "always",
    evidence: {
      repository,
      catalog: new InMemoryEvidenceCatalog(),
      async awaitIndexed(reference) {
        onAwaitIndexed();
        return { status: "not-announced", reference };
      },
    },
    ...(deliveryExtensions === undefined ? {} : { deliveryExtensions }),
  });
}

async function terminalSnapshot(instance: LocalTaskExecutionBackend, submission: `urn:uuid:${string}`) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await instance.observe(submission);
    if (snapshot.descriptor.derived.terminal) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("attempt did not become terminal");
}

describe("backend evidence capture posture (C3)", () => {
  test("finalization receipt gates delivered, populates Delivery, and catalog indexing does not gate", async () => {
    const repository = new InMemoryEvidenceRepository();
    let awaitCalls = 0;
    const instance = backend(await stateRoot(), repository, () => {
      awaitCalls += 1;
    });
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "delivered",
      terminal: true,
    });
    const types = snapshot.observations.map(({ type }) => type);
    expect(types.indexOf("network.jinn.task-execution.execution-observed.v1"))
      .toBeLessThan(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"));
    expect(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"))
      .toBeLessThan(types.indexOf("network.jinn.task-execution.attempt-terminal.v1"));
    expect(awaitCalls).toBe(0);

    const refs = await instance.deliveries(snapshot.descriptor.attempt);
    expect(refs).toHaveLength(1);
    const delivery = JSON.parse(
      new TextDecoder().decode(await instance.fetchDelivery(refs[0]!)),
    ) as {
      evidenceRecords?: unknown[];
      executionIds?: string[];
    };
    expect(delivery.evidenceRecords).toHaveLength(1);
    expect(delivery.executionIds).toEqual(snapshot.descriptor.derived.executionIds);
  });

  test("capture always maps recorder failure to failed[infrastructure] and emits no Delivery", async () => {
    const backing = new InMemoryEvidenceRepository();
    const repository: EvidenceRepository = {
      capabilities: backing.capabilities,
      putArtifact: backing.putArtifact.bind(backing),
      getArtifact: backing.getArtifact.bind(backing),
      getRecord: backing.getRecord.bind(backing),
      async putRecord() {
        throw new EvidenceRepositoryError("IO_FAILURE", "injected recorder failure");
      },
    };
    const instance = backend(await stateRoot(), repository, () => {});
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "failed",
      terminal: true,
      blame: "infrastructure",
    });
    expect(await instance.deliveries(snapshot.descriptor.attempt)).toEqual([]);
  });

  test("carries a host-supplied namespaced Delivery extension into the sealed bytes", async () => {
    const repository = new InMemoryEvidenceRepository();
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = () => ({
      "https://jinn.network/bridge/legacy-execution-envelope/1.0":
        "{\"schemaVersion\":\"jinn.execution.v1\"}",
    });
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({ state: "delivered", terminal: true });

    const refs = await instance.deliveries(snapshot.descriptor.attempt);
    expect(refs).toHaveLength(1);
    const deliveryBytes = await instance.fetchDelivery(refs[0]!);
    const parsed = JSON.parse(new TextDecoder().decode(deliveryBytes)) as Record<string, unknown>;
    expect(parsed["https://jinn.network/bridge/legacy-execution-envelope/1.0"]).toBe(
      "{\"schemaVersion\":\"jinn.execution.v1\"}",
    );
    // The extension must not break canonical sealing or schema admission.
    expect(() => DeliveryRecordSchema.parse(parsed)).not.toThrow();
  });

  test("refuses a non-namespaced extension key", async () => {
    const repository = new InMemoryEvidenceRepository();
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = () => ({
      data: "x",
    });
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "failed",
      terminal: true,
      blame: "infrastructure",
    });
    expect(await instance.deliveries(snapshot.descriptor.attempt)).toEqual([]);
  });

  // Cutover stage 1 close-out C7 (finding E24): `deliveryExtensions` needs a way to reach the
  // workKind (and, for today-generation claims, the requestId) that produced the attempt it is
  // sealing a Delivery for -- `noteAttemptWorkKind` is that seam. A two-party caller knows
  // `attempt` before it calls `submit()` (this is exactly how `work-loop.ts` uses it), so these
  // tests drive the two-party path rather than the single-party one, matching production.
  test("threads a host-noted workKind and requestId through to deliveryExtensions at delivery time", async () => {
    const repository = new InMemoryEvidenceRepository();
    const task = sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: {
        uri: profile.profile,
        digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
      },
      instructions: "Capture this execution.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    });
    const taskDigest = documentDigest(task);
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = crypto.randomUUID();
    const submission = sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: submissionUri,
      task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000002",
      idempotencyKey: crypto.randomUUID(),
      nonce,
      deadline: "2099-01-01T00:00:00Z",
    });
    const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const requestId = `0x${"a".repeat(64)}` as const;
    const seen: { readonly workKind?: string; readonly requestId?: `0x${string}` }[] = [];
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = (input) => {
      seen.push({ workKind: input.workKind, requestId: input.requestId });
      return {};
    };
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    // Noted BEFORE submit() -- the seam's whole point is that the caller knows the attempt's
    // identity ahead of the two-party submit call.
    instance.noteAttemptWorkKind(attemptUri, "repo-fix", requestId);

    const ack = await instance.submit(task, submission, {
      attemptUri,
      dispatchContext: { taskDigest, submission: submissionUri, nonce, attempt: attemptUri },
    });
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    await terminalSnapshot(instance, ack.submission);
    expect(seen).toEqual([{ workKind: "repo-fix", requestId }]);
  });

  test("leaves workKind/requestId absent from deliveryExtensions input when never noted", async () => {
    const repository = new InMemoryEvidenceRepository();
    const seen: Record<string, unknown>[] = [];
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return {};
    };
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    await terminalSnapshot(instance, ack.submission);
    expect(seen).toHaveLength(1);
    expect("workKind" in seen[0]!).toBe(false);
    expect("requestId" in seen[0]!).toBe(false);
  });
});
