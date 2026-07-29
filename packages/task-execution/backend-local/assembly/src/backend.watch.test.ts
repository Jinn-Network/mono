import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import type { ProvisionerContract, TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
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
  get: (digest) => (digest === sealedProfile.digest ? profile : undefined),
};

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => {
    await backend.drain();
    await backend.shutdown();
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jinn-watch-${name}-`));
  roots.push(root);
  return root;
}

function delayedLauncher(delayMs: number): LauncherContract {
  return {
    id: "watch-delay",
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
    plan(_view: TaskView, paths: WorkspacePaths) {
      return {
        argv: [process.execPath, "-e", `setTimeout(() => process.exit(0), ${delayMs})`],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "watch-fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
}

function backend(root: string, delayMs = 250): LocalTaskExecutionBackend {
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup() {},
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return { manifest: [], omissions: [], integrityViolations: [] };
    },
  };
  const instance = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:watch-test",
    executor: "urn:jinn:agent:watch-test",
    profileStore,
    launchers: [delayedLauncher(delayMs)],
    provisioner: () => ({ id: "watch-fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
  });
  backends.push(instance);
  return instance;
}

let sequence = 0;
function documents(): { readonly task: Uint8Array; readonly submission: Uint8Array } {
  sequence += 1;
  const task = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Watch tail fixture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: false }],
  });
  return {
    task,
    submission: sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:51000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:52000000-0000-4000-8000-000000000001",
      idempotencyKey: `watch-${sequence}`,
      nonce: `watch-nonce-${sequence}`,
      deadline: "2099-01-01T00:00:00Z",
    }),
  };
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

describe("durable watch tail (§7.96)", () => {
  test("remains pending after the current snapshot and yields later facts exactly once", async () => {
    const root = await stateRoot("pending-tail");
    const instance = backend(root, 400);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    if (!ack.accepted) throw ack.error;

    const collected: string[] = [];
    let pending = true;
    const tail = (async () => {
      for await (const observation of instance.watch(ack.submission)) {
        collected.push(`${observation.type}:${observation.sequence}`);
        if (observation.type === "network.jinn.task-execution.attempt-terminal.v1") break;
      }
      pending = false;
    })();

    await waitFor(() => collected.length >= 1, "watch did not yield the first durable fact");
    expect((await instance.observe(ack.submission)).descriptor.derived.terminal).toBe(false);
    expect(pending).toBe(true);

    await instance.drain();
    await tail;

    const sequences = collected.map((entry) => entry.split(":")[1]!);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(collected.at(-1)).toMatch(/attempt-terminal\.v1:/);
  });

  test("resumes from a cursor without gaps or duplicates and survives restart", async () => {
    const root = await stateRoot("restart-resume");
    const first = backend(root, 200);
    const { task, submission } = documents();
    const ack = await first.submit(task, submission);
    if (!ack.accepted) throw ack.error;

    await waitFor(
      async () => (await first.observe(ack.submission)).observations.length >= 2,
      "attempt did not produce initial durable observations",
    );
    const snapshot = await first.observe(ack.submission);
    const cursor = { sequence: snapshot.observations[1]!.sequence };

    await first.drain();
    await first.shutdown();

    const second = backend(root, 40);
    const resumed: string[] = [];
    for await (const observation of second.watch(ack.submission, cursor)) {
      resumed.push(observation.sequence);
      if (observation.type === "network.jinn.task-execution.attempt-terminal.v1") break;
    }
    await second.drain();

    expect(resumed.length).toBeGreaterThan(0);
    expect(new Set(resumed).size).toBe(resumed.length);
    for (const sequenceValue of resumed) {
      expect(sequenceValue > cursor.sequence).toBe(true);
    }
    const full = (await second.observe(ack.submission)).observations.map(({ sequence }) => sequence);
    expect(full.slice(full.indexOf(resumed[0]!))).toEqual(resumed);
  });

  test("cleans up waiters when the consumer stops early", async () => {
    const root = await stateRoot("cancel-watch");
    const instance = backend(root, 5_000);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    if (!ack.accepted) throw ack.error;

    const iterator = instance.watch(ack.submission)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    const shutdownStarted = Date.now();
    await instance.shutdown();
    expect(Date.now() - shutdownStarted).toBeLessThan(2_000);
  });
});
