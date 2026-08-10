// SPDX-License-Identifier: Apache-2.0

/**
 * #2538 F5 — the harness's stdio reaches `logs/`, and its stderr reaches the terminal detail.
 *
 * The shim has always accepted `stdoutPath`/`stderrPath`, but the backend never passed them, so
 * every launcher's output went to `ignore`. Live, the prediction launcher wrote a precise one-line
 * diagnostic naming exactly what it could not find and exited 2; the attempt's `logs/` and `out/`
 * were empty and the audit event read `{"reason":"backend-terminal-failure","detail":"failed"}`.
 * That uninformative detail is why the defect was first misread as a different one, and it cost a
 * round to correct.
 *
 * Fails before the fix on both assertions (no log file at all; detail is the bare reason code).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import {
  harvest as realHarvest,
  HARNESS_STDERR_LOG,
  HARNESS_STDOUT_LOG,
} from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  harnessLogTail,
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
} from "./backend.js";

const DIAGNOSTIC = "prediction-v1-baseline: cannot read the staged native Task at input/task.sealed";

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
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  })));
});

function fixture(root: string, argv: readonly string[]): LocalTaskExecutionBackend {
  const launcher: LauncherContract = {
    id: "stdio-fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: [],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan: (_view, paths) => ({
      argv,
      env: { JINN_ATTEMPT_OUT: paths.out, JINN_ATTEMPT_LOGS: paths.logs },
      cwd: paths.work,
      validExitCodes: [0],
      resultContract: { envelopeFormat: "fixture" },
      interruptionBehavior: "repeatable",
    }),
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    setup: async (_view, paths) => {
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
    },
    executionEnv: ({ env }) => ({ ...env }),
    // The REAL harvest, so this file also covers what the capture does to the Delivery's outputs.
    harvest: (paths, outputs) => realHarvest(paths, outputs),
  };
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:stdio-test",
    executor: "urn:jinn:agent:stdio-test",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "stdio-fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: [],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    recorderAvailability: "none",
  });
  backends.push(backend);
  return backend;
}

let sequence = 0;
function documents(): { task: Uint8Array; submission: Uint8Array } {
  const task = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Exercise harness stdio capture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  sequence += 1;
  return {
    task,
    submission: sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: `urn:uuid:30000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000001",
      idempotencyKey: `stdio-test-${sequence}`,
      nonce: `stdio-nonce-${sequence}`,
      deadline: "2099-01-01T00:00:00Z",
    }),
  };
}

async function waitForTerminal(backend: LocalTaskExecutionBackend, submission: `urn:uuid:${string}`) {
  for (let poll = 0; poll < 400; poll += 1) {
    const snapshot = await backend.observe(submission);
    if (snapshot.descriptor.derived.terminal) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("attempt never reached a terminal state");
}

describe("harness stdio capture (#2538 F5)", () => {
  test("a non-zero launcher exit surfaces its stderr in logs/ and in the terminal detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-harness-stdio-"));
    roots.push(root);
    const backend = fixture(root, [
      process.execPath,
      "-e",
      `console.log('starting'); console.error(${JSON.stringify(DIAGNOSTIC)}); process.exit(2);`,
    ]);
    const { task, submission } = documents();
    const ack = await backend.submit(task, submission);
    if (!ack.accepted) throw new Error(`expected acceptance: ${ack.error.category}`);

    const snapshot = await waitForTerminal(backend, ack.submission);
    expect(snapshot.descriptor.derived.state).toBe("failed");

    const attemptRoot = join(root, "attempts", snapshot.descriptor.attempt.slice("urn:uuid:".length));
    // The harness's own words, on disk, under the backend-written logs directory.
    expect(await readFile(join(attemptRoot, "logs", HARNESS_STDERR_LOG), "utf8")).toContain(DIAGNOSTIC);
    expect(await readFile(join(attemptRoot, "logs", HARNESS_STDOUT_LOG), "utf8")).toContain("starting");

    // And in the audit trail, where the diagnosis actually happens.
    const terminal = snapshot.observations
      .filter((observation) => observation.type === "network.jinn.task-execution.attempt-terminal.v1")
      .at(-1);
    const detail = (terminal?.data as { detail?: string } | undefined)?.detail ?? "";
    expect(detail).toContain("invalid-exit");
    expect(detail).toContain(DIAGNOSTIC);
  }, 30_000);

  /**
   * The capture must not reshape the signed Delivery. `harvest` collects `logs/` into the
   * manifest, so without the exclusion every Delivery on every attempt would suddenly publish
   * whatever the harness happened to print, as a content-addressed output. Backend state stays
   * backend state; a log the HARNESS itself writes under `logs/` is delivered exactly as before.
   */
  test("the stdio capture is never published as a Delivery output, and harness-written logs still are", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-harness-stdio-ok-"));
    roots.push(root);
    const backend = fixture(root, [
      process.execPath,
      "-e",
      "const fs=require('node:fs');const p=require('node:path');"
      + "console.error('noise');"
      + "fs.writeFileSync(p.join(process.env.JINN_ATTEMPT_OUT,'patch'),'diff');"
      + "fs.writeFileSync(p.join(process.env.JINN_ATTEMPT_LOGS,'harness-authored.log'),'mine');"
      + "process.exit(0);",
    ]);
    const { task, submission } = documents();
    const ack = await backend.submit(task, submission);
    if (!ack.accepted) throw new Error(`expected acceptance: ${ack.error.category}`);

    const snapshot = await waitForTerminal(backend, ack.submission);
    expect(snapshot.descriptor.derived.state).toBe("delivered");
    const attemptRoot = join(root, "attempts", snapshot.descriptor.attempt.slice("urn:uuid:".length));
    expect(await readFile(join(attemptRoot, "logs", HARNESS_STDERR_LOG), "utf8")).toContain("noise");

    const [reference] = await backend.deliveries(snapshot.descriptor.attempt);
    if (reference === undefined) throw new Error("delivered attempt has no Delivery");
    const delivery = JSON.parse(new TextDecoder().decode(await backend.fetchDelivery(reference))) as {
      outputs: readonly { name: string }[];
    };
    const names = delivery.outputs.map(({ name }) => name).sort();
    expect(names).toStrictEqual(["logs/harness-authored.log", "patch"]);
    expect(names).not.toContain(`logs/${HARNESS_STDOUT_LOG}`);
    expect(names).not.toContain(`logs/${HARNESS_STDERR_LOG}`);
  }, 30_000);
});

describe("harnessLogTail", () => {
  test("is a diagnostic, never a failure: an absent or empty log yields nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-harness-tail-"));
    roots.push(root);
    expect(harnessLogTail(join(root, "absent.log"))).toBeUndefined();
  });

  test("collapses whitespace and keeps the tail within its budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-harness-tail-budget-"));
    roots.push(root);
    const path = join(root, "stderr.log");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${"a".repeat(50)}\n\n   ${"b".repeat(50)}\n`);
    expect(harnessLogTail(path, 4096)).toBe(`${"a".repeat(50)} ${"b".repeat(50)}`);
    const clipped = harnessLogTail(path, 10);
    expect(clipped).toBe(`…${"b".repeat(10)}`);
  });
});
