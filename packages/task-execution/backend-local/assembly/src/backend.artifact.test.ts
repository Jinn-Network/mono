import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const backends: LocalTaskExecutionBackend[] = [];
const outputBytes = new TextEncoder().encode("exact native solution bytes\n");
const outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get: (digest) => digest === sealedProfile.digest ? profile : undefined,
};

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<LocalTaskExecutionBackend> {
  const root = await mkdtemp(join(tmpdir(), "jinn-backend-artifact-"));
  roots.push(root);
  const launcher: LauncherContract = {
    id: "artifact-fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: [],
      outputMediaTypes: ["text/plain"],
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
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
      await writeFile(join(paths.out, "prediction.txt"), outputBytes);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return {
        manifest: [{
          path: "prediction.txt",
          sizeBytes: outputBytes.byteLength,
          sha256: `sha256:${outputSha256}`,
          mediaType: "text/plain",
        }],
        omissions: [],
        integrityViolations: [],
      };
    },
  };
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:artifact-test",
    executor: "urn:jinn:agent:artifact-test",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "artifact-fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: [],
      outputMediaTypes: ["text/plain"],
      isolation: ["process"],
    },
    recorderAvailability: "none",
  });
  backends.push(backend);
  return backend;
}

async function waitForDelivery(backend: LocalTaskExecutionBackend, submission: `urn:uuid:${string}`) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await backend.observe(submission);
    if (snapshot.descriptor.derived.terminal) {
      const [reference] = await backend.deliveries(snapshot.descriptor.attempt);
      if (reference === undefined) throw new Error("terminal Attempt has no Delivery");
      return backend.fetchDelivery(reference);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Attempt did not become terminal");
}

describe("local output artifact retrieval", () => {
  test("retrieves an exact harvested output from the digest-only Delivery descriptor", async () => {
    const backend = await fixture();
    const task = sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: {
        uri: profile.profile,
        digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
      },
      instructions: "Return the pinned prediction.",
      outputs: [{ name: "prediction.txt", mediaType: "text/plain", required: true }],
    });
    const submission = sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: "urn:uuid:10000000-0000-4000-8000-000000000099",
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000099",
      idempotencyKey: "artifact-fetch-test",
      nonce: "artifact-fetch-nonce",
      deadline: "2099-01-01T00:00:00Z",
    });
    const acknowledgement = await backend.submit(task, submission);
    expect(acknowledgement.accepted).toBe(true);
    if (!acknowledgement.accepted) throw new Error("unreachable");

    const deliveryBytes = await waitForDelivery(backend, acknowledgement.submission);
    const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
      outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
    };
    expect(delivery.outputs).toHaveLength(1);
    expect(delivery.outputs[0]).toEqual({
      name: "prediction.txt",
      mediaType: "text/plain",
      digest: { sha256: outputSha256 },
    });

    await expect(backend.fetchArtifact(delivery.outputs[0]!)).resolves.toEqual(outputBytes);
  });
});
