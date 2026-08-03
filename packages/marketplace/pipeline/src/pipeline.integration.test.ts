// SPDX-License-Identifier: MIT

/**
 * §7.18 integration proof: the pipeline-built two-party engagement is adopted by the real
 * backend-local assembly through its public factory — without importing assembly internals or
 * running the full venue/settlement loop (which would duplicate binding integration tests).
 *
 * A full `runPipeline` end-to-end would require mocked claim/finality/settlement ports and real
 * chain fixtures; the smallest non-vacuous proof is the exact post-claim seam:
 * `buildEngagement(claim) → backend.submit(..., engagement) → observe` adopts attemptUri.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLocalTaskExecutionBackend } from "@jinn-network/task-execution-backend-local";
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
import { buildEngagement } from "./engage.js";

const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedProfile.digest ? profile : undefined;
  },
};

const roots: string[] = [];
const backends: Array<{ drain(): Promise<void>; shutdown(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => {
    await backend.drain();
    await backend.shutdown();
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
// The backend's fail-closed native-shim readiness window is ten seconds. Cleanup must be able to
// observe that terminal classification on a loaded hosted runner instead of Vitest aborting the
// hook at the same boundary and leaking the temporary state root.
}, 30_000);

function taskBytes(): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Exercise pipeline engagement adoption.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function submissionBytes(task: Uint8Array): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:55555555-5555-4555-8555-555555555555",
    task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
    requester: "urn:uuid:66666666-6666-4666-8666-666666666666",
    idempotencyKey: "pipeline-integration-1",
    nonce: "integration-nonce",
    deadline: "2099-01-01T00:00:00Z",
  });
}

async function makeIntegrationBackend(root: string) {
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup() {},
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
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "effort", inventory: ["low", "medium", "high"], posture: "enforced" },
          { key: "harness", inventory: ["fixture"], posture: "enforced" },
        ],
      },
    }),
    plan(_view, paths) {
      return {
        argv: ["fixture"],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
    probe: async () => ({ ready: true }),
  };
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:pipeline-integration",
    executor: "urn:jinn:agent:pipeline-integration",
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
  });
  backends.push(backend);
  return backend;
}

describe("pipeline engagement with backend-local assembly", () => {
  test("adopts the pipeline-built Attempt URI and dispatchContext via submit/observe", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-pipeline-integration-"));
    roots.push(root);
    const backend = await makeIntegrationBackend(root);

    const task = taskBytes();
    const submission = submissionBytes(task);
    const parsed = JSON.parse(new TextDecoder().decode(submission)) as {
      submission: `urn:uuid:${string}`;
      nonce: string;
    };

    const attemptUri = "urn:uuid:77777777-7777-4777-8777-777777777777";
    const dispatchContext = {
      taskDigest: documentDigest(task),
      submission: parsed.submission,
      nonce: parsed.nonce,
      attempt: attemptUri,
    } as const;

    const preflight = await backend.preflight({
      taskProfile: profile.profile,
      requirements: {},
    });
    expect(preflight.ready).toBe(true);

    const engagement = buildEngagement({ attemptUri, dispatchContext });
    const ack = await backend.submit(task, submission, engagement);

    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect((await backend.observe(ack.submission)).descriptor.attempt).toBe(attemptUri);
  });
});
