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
  documentDigest,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { ProvisionerContract } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
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
      runPinning: { keys: [] },
    }),
    plan(_view, paths) {
      return {
        argv: ["fixture"],
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
    provisioner: () => provisioner,
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
    async execute() {
      return { exitCode: 0 };
    },
  });
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

    const snapshot = await instance.observe(ack.submission);
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

    const snapshot = await instance.observe(ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "failed",
      terminal: true,
      blame: "infrastructure",
    });
    expect(await instance.deliveries(snapshot.descriptor.attempt)).toEqual([]);
  });
});
