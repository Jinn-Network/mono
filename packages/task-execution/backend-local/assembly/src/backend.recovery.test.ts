import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type {
  LaunchPlan,
  LauncherContract,
} from "@jinn-network/task-execution-launchers";
import {
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from "@jinn-network/task-execution-protocol";
import {
  openAttemptJournal,
  listProcessGroupPids,
  probeShimAlive,
  readShimFingerprint,
  type JournalEvent,
} from "@jinn-network/task-execution-supervisor";
import type {
  HarvestResult,
  ProvisionerContract,
  TaskView,
  WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalProvisionerInput,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "./backend.js";

const roots: string[] = [];
const backends: LocalTaskExecutionBackend[] = [];
const releaseBarriers: Array<() => void> = [];
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get: (digest) => digest === sealedProfile.digest ? profile : undefined,
};

type CompletionPhase =
  | "before-outcome-wait"
  | "after-outcome"
  | "before-harvest"
  | "after-harvest"
  | "after-evidence"
  | "before-delivery-checkpoint";

interface Barrier {
  readonly entered: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
}

function barrier(): Barrier {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseBarriers.push(release);
  return {
    entered,
    async wait() {
      enter();
      await blocked;
    },
    release,
  };
}

afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release();
  await Promise.allSettled(backends.splice(0).map(async (backend) => {
    await backend.drain();
    await backend.shutdown();
  }));
  // A just-reaped shim can briefly finish closing its heartbeat/cancellation file after
  // shutdown returns. Retry only cleanup of the disposable test root.
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

async function stateRoot(name: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `jinn-recovery-${name}-`));
  roots.push(value);
  return value;
}

function paths(root: string, attempt: string): WorkspacePaths {
  const attemptRoot = join(root, "attempts", attempt.slice("urn:uuid:".length));
  return {
    root: attemptRoot,
    input: join(attemptRoot, "input"),
    work: join(attemptRoot, "work"),
    out: join(attemptRoot, "out"),
    logs: join(attemptRoot, "logs"),
    harnessState: join(attemptRoot, "harness-state"),
    secrets: join(attemptRoot, "secrets"),
    tmp: join(attemptRoot, "tmp"),
    meta: join(attemptRoot, "meta"),
  };
}

let sequence = 0;
function documents(
  deadline = "2099-01-01T00:00:00Z",
  maxAttemptDurationMs?: number,
): { readonly task: Uint8Array; readonly submission: Uint8Array } {
  sequence += 1;
  const task = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Exercise restart recovery.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: false }],
    ...(maxAttemptDurationMs === undefined ? {} : { requirements: { maxAttemptDurationMs } }),
  });
  return {
    task,
    submission: sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:41000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:42000000-0000-4000-8000-000000000001",
      idempotencyKey: `recovery-${sequence}`,
      nonce: `recovery-nonce-${sequence}`,
      deadline,
    }),
  };
}

interface BackendFixtureOptions {
  readonly processDelayMs?: number;
  readonly completionBarrier?: {
    readonly phase: CompletionPhase;
    readonly barrier: Barrier;
  };
  readonly selectorId?: string;
  readonly selectionInputs?: LocalProvisionerInput[];
  readonly planCalls?: { value: number };
  readonly harvestCalls?: { value: number };
  readonly harvest?: HarvestResult;
  readonly plan?: (view: TaskView, workspace: WorkspacePaths) => LaunchPlan;
  readonly recorderAvailability?: "none" | "available" | "always";
  readonly heartbeatIntervalMs?: number;
  readonly evidenceRepository?: InMemoryEvidenceRepository;
  readonly secretForwards?: readonly { readonly grantKey: string; readonly target: string }[];
}

function fixture(root: string, options: BackendFixtureOptions = {}): LocalTaskExecutionBackend {
  const planCalls = options.planCalls;
  const launcher: LauncherContract = {
    id: "recovery-fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: options.secretForwards ?? [],
      runPinning: { keys: [] },
    }),
    plan(view, workspace) {
      if (planCalls !== undefined) planCalls.value += 1;
      return options.plan?.(view, workspace) ?? {
        argv: [
          process.execPath,
          "-e",
          `setTimeout(() => process.exit(0), ${options.processDelayMs ?? 40})`,
        ],
        env: {},
        cwd: workspace.work,
        validExitCodes: [0],
        blameExitCodes: [{
          match: { signal: "SIGKILL" },
          blame: "infrastructure",
          reasonCode: "killed",
        }],
        resultContract: { envelopeFormat: "recovery-fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup(_view, workspace) {
      await Promise.all(Object.values(workspace).map((path) => mkdir(path, { recursive: true })));
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      if (options.harvestCalls !== undefined) options.harvestCalls.value += 1;
      return options.harvest ?? { manifest: [], omissions: ["patch"], integrityViolations: [] };
    },
  };
  const repository = options.evidenceRepository;
  const config: LocalTaskExecutionBackendConfig = {
    stateRoot: root,
    source: "urn:jinn:backend-local:recovery-test",
    executor: "urn:jinn:agent:recovery-test",
    profileStore,
    launchers: [launcher],
    provisioner(input) {
      options.selectionInputs?.push(input);
      return { id: options.selectorId ?? "fixture-provisioner-v1", contract: provisioner };
    },
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    recorderAvailability: options.recorderAvailability ?? "none",
    // These tests assert recovery/deadline state transitions, while the supervisor suite owns
    // the production TERM grace/kill-ladder timing contract. Keep this fixture's real shim
    // lifecycle bounded so its terminal-state oracle does not race the 10-second default grace.
    cancellationGraceMs: 100,
    cancellationKillPollCeilingMs: 2_000,
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(repository === undefined
      ? {}
      : {
          evidence: {
            repository,
            catalog: new InMemoryEvidenceCatalog(),
            async awaitIndexed(reference) {
              return { status: "not-announced" as const, reference };
            },
          },
        }),
    faults: {
      async onCompletionPhase(phase: CompletionPhase) {
        const selected = options.completionBarrier;
        if (selected?.phase === phase) {
          await selected.barrier.wait();
        }
      },
    },
  };
  const backend = makeLocalTaskExecutionBackend(config);
  backends.push(backend);
  return backend;
}

async function submit(
  backend: LocalTaskExecutionBackend,
  deadline?: string,
  maxAttemptDurationMs?: number,
): Promise<{ readonly attempt: `urn:uuid:${string}`; readonly task: Uint8Array; readonly submission: Uint8Array }> {
  const { task, submission } = documents(deadline, maxAttemptDurationMs);
  const acknowledgement = await backend.submit(task, submission);
  if (!acknowledgement.accepted) throw acknowledgement.error;
  return {
    attempt: (await backend.observe(acknowledgement.submission)).descriptor.attempt,
    task,
    submission,
  };
}

async function handoffWriter(
  backend: LocalTaskExecutionBackend,
  release?: () => void,
): Promise<void> {
  if (release !== undefined) release();
  await backend.shutdown();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function expectRestartBlocked(
  root: string,
  attempt: `urn:uuid:${string}`,
  options: BackendFixtureOptions = {},
): Promise<void> {
  const blocked = fixture(root, options);
  await expect(blocked.recover(attempt)).rejects.toMatchObject({
    category: "backend-unavailable",
  });
}

async function restartWhilePaused(
  root: string,
  backend: LocalTaskExecutionBackend,
  pause: Barrier,
  attempt: `urn:uuid:${string}`,
  options: BackendFixtureOptions = {},
): Promise<LocalTaskExecutionBackend> {
  void backend.shutdown();
  await expectRestartBlocked(root, attempt, options);
  await handoffWriter(backend, () => pause.release());
  return fixture(root, options);
}

async function journalEvents(root: string, attempt: string): Promise<JournalEvent[]> {
  const file = join(paths(root, attempt).meta, "journal.jsonl");
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEvent);
}

async function replaceJournal(
  root: string,
  attempt: string,
  transform: (events: JournalEvent[]) => JournalEvent[],
): Promise<void> {
  const file = join(paths(root, attempt).meta, "journal.jsonl");
  const transformed = transform(await journalEvents(root, attempt));
  await writeFile(file, `${transformed.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function terminalState(backend: LocalTaskExecutionBackend, attempt: `urn:uuid:${string}`): Promise<string> {
  await waitFor(
    async () => (await backend.observe(attempt)).descriptor.derived.terminal,
    "attempt did not become terminal",
  );
  return (await backend.observe(attempt)).descriptor.derived.state;
}

describe("restart reconstruction and §6.4 actions", () => {
  test("matching live supervision reconstructs exact inputs, never replans, and resumes the same Evidence execution", async () => {
    const root = await stateRoot("matching-evidence");
    const pause = barrier();
    const repository = new InMemoryEvidenceRepository();
    const selectionInputs: LocalProvisionerInput[] = [];
    const planCalls = { value: 0 };
    const first = fixture(root, {
      processDelayMs: 250,
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
      selectionInputs,
      planCalls,
      recorderAvailability: "always",
      evidenceRepository: repository,
    });
    const accepted = await submit(first);
    await pause.entered;
    const marker = JSON.parse(
      await readFile(join(paths(root, accepted.attempt).meta, "evidence-recording", "workspace.json"), "utf8"),
    ) as { executionId: string };
    const recovered = await restartWhilePaused(root, first, pause, accepted.attempt, {
      processDelayMs: 250,
      selectionInputs,
      planCalls,
      recorderAvailability: "always",
      evidenceRepository: repository,
    });
    expect(await recovered.recover(accepted.attempt)).toEqual({ classification: "matching" });
    expect(await recovered.recover(accepted.attempt)).toEqual({ classification: "matching" });
    expect(await terminalState(recovered, accepted.attempt)).toBe("delivered");
    expect(planCalls.value).toBe(1);
    expect(selectionInputs).toHaveLength(2);
    expect(selectionInputs[1]?.sealedTaskBytes).toEqual(selectionInputs[0]?.sealedTaskBytes);
    expect(selectionInputs[1]?.dispatchContextBytes).toEqual(selectionInputs[0]?.dispatchContextBytes);

    const delivery = JSON.parse(
      new TextDecoder().decode(
        await recovered.fetchDelivery((await recovered.deliveries(accepted.attempt))[0]!),
      ),
    ) as { executionIds?: string[] };
    expect(delivery.executionIds).toEqual([marker.executionId]);
    expect(await recovered.deliveries(accepted.attempt)).toHaveLength(1);
    const events = await journalEvents(root, accepted.attempt);
    expect(events.filter(({ type }) => type === "execution-observed")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "harvested")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "delivery-recorded")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "attempt-terminal")).toHaveLength(1);
    pause.release();
  });

  test("required recovery capture fails terminally when its durable recording is missing", async () => {
    const root = await stateRoot("missing-required-evidence");
    const pause = barrier();
    const repository = new InMemoryEvidenceRepository();
    const first = fixture(root, {
      processDelayMs: 200,
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
      recorderAvailability: "always",
      evidenceRepository: repository,
    });
    const { attempt } = await submit(first);
    await pause.entered;
    void first.shutdown();
    await expectRestartBlocked(root, attempt, {
      recorderAvailability: "always",
      evidenceRepository: repository,
    });
    await rm(join(paths(root, attempt).meta, "evidence-recording"), {
      recursive: true,
      force: true,
    });
    await handoffWriter(first, () => pause.release());

    const recovered = fixture(root, {
      recorderAvailability: "always",
      evidenceRepository: repository,
    });
    expect((await recovered.recover(attempt)).classification).toBe("matching");
    expect(await terminalState(recovered, attempt)).toBe("failed");
    expect(await recovered.deliveries(attempt)).toEqual([]);
    expect((await journalEvents(root, attempt)).filter(
      ({ type }) => type === "execution-observed",
    )).toHaveLength(0);
    pause.release();
  });

  test("a matching late outcome is ingested through the same harvest/record path", async () => {
    const root = await stateRoot("matching-late");
    const pause = barrier();
    const harvestCalls = { value: 0 };
    const first = fixture(root, {
      completionBarrier: { phase: "after-outcome", barrier: pause },
      harvestCalls,
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const recovered = await restartWhilePaused(root, first, pause, attempt, { harvestCalls });
    expect(await recovered.recover(attempt)).toEqual({ classification: "matching" });
    expect(await terminalState(recovered, attempt)).toBe("delivered");
    expect(harvestCalls.value).toBe(1);
    pause.release();
  });

  test("harvesting recovery re-runs the provisioner's idempotent harvest exactly once", async () => {
    const root = await stateRoot("harvesting");
    const pause = barrier();
    const harvestCalls = { value: 0 };
    const first = fixture(root, {
      completionBarrier: { phase: "before-harvest", barrier: pause },
      harvestCalls,
    });
    const { attempt } = await submit(first);
    await pause.entered;
    expect((await journalEvents(root, attempt)).some(
      ({ type }) => type === "harvest-started",
    )).toBe(true);
    const recovered = await restartWhilePaused(root, first, pause, attempt, { harvestCalls });
    expect((await recovered.recover(attempt)).classification).toBe("matching");
    expect(await terminalState(recovered, attempt)).toBe("delivered");
    expect(harvestCalls.value).toBe(1);
    pause.release();
  });

  test("recording recovery validates and reuses the journaled harvest without harvesting twice", async () => {
    const root = await stateRoot("recording");
    const pause = barrier();
    const harvestCalls = { value: 0 };
    const first = fixture(root, {
      completionBarrier: { phase: "after-harvest", barrier: pause },
      harvestCalls,
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const recovered = await restartWhilePaused(root, first, pause, attempt, { harvestCalls });
    expect((await recovered.recover(attempt)).classification).toBe("matching");
    expect(await terminalState(recovered, attempt)).toBe("delivered");
    expect(harvestCalls.value).toBe(1);
    pause.release();
  });

  test("a stale nonce outcome is ignored and the now-absent attempt becomes lost", async () => {
    const root = await stateRoot("stale-outcome");
    const pause = barrier();
    const first = fixture(root, {
      completionBarrier: { phase: "after-outcome", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const workspace = paths(root, attempt);
    const outcome = JSON.parse(await readFile(join(workspace.meta, "outcome.json"), "utf8")) as {
      attemptId: string;
      nonce: string;
      exitCode: number | null;
      termSignal: string | null;
      startedAt: string;
      finishedAt: string;
    };
    await writeFile(join(workspace.meta, "outcome.json"), JSON.stringify({
      ...outcome,
      nonce: `${outcome.nonce}-foreign`,
    }));
    const recovered = await restartWhilePaused(root, first, pause, attempt);
    const fingerprint = readShimFingerprint(workspace.meta);
    await waitFor(
      () => !probeShimAlive(workspace.meta).alive
        && (fingerprint?.harnessPid === undefined
          || listProcessGroupPids(fingerprint.harnessPid).length === 0),
      "completed harness did not relinquish its process group",
    );

    expect(await recovered.recover(attempt)).toEqual({
      classification: "absent",
      detail: "stale-foreign",
    });
    expect(await terminalState(recovered, attempt)).toBe("lost");
    expect((await journalEvents(root, attempt)).some(({ type }) => type === "exec-finished")).toBe(false);
    pause.release();
  });

  test("a prior lost terminal accepts a recovered matching outcome as the only corrective terminal", async () => {
    const root = await stateRoot("lost-correction");
    const first = fixture(root, {
      secretForwards: [{ grantKey: "key", target: "key" }],
      plan(_view, workspace) {
        return {
          argv: [process.execPath, "-e", "process.exit(0)"],
          env: { SECRET: "secrets/key" },
          cwd: workspace.work,
          validExitCodes: [0],
          resultContract: { envelopeFormat: "fixture" },
          interruptionBehavior: "repeatable",
          secretForwards: [{ grantKey: "key", target: "key" }],
        };
      },
    });
    const { attempt, submission } = await submit(first);
    await replaceJournal(root, attempt, (events) =>
      events.filter(({ type }) => type !== "attempt-terminal"));
    await handoffWriter(first);

    const absent = fixture(root);
    expect((await absent.recover(attempt)).classification).toBe("absent");
    expect(await terminalState(absent, attempt)).toBe("lost");
    await handoffWriter(absent);
    const parsed = JSON.parse(new TextDecoder().decode(submission)) as { nonce: string };
    await writeFile(join(paths(root, attempt).meta, "outcome.json"), JSON.stringify({
      attemptId: attempt,
      nonce: parsed.nonce,
      exitCode: 0,
      termSignal: null,
      startedAt: "2026-07-28T00:00:00.000Z",
      finishedAt: "2026-07-28T00:00:01.000Z",
    }));

    const corrected = fixture(root);
    expect((await corrected.recover(attempt)).classification).toBe("matching");
    expect(await terminalState(corrected, attempt)).toBe("delivered");
    const terminals = (await journalEvents(root, attempt))
      .filter(({ type }) => type === "attempt-terminal");
    expect(terminals.map(({ details }) => details["state"])).toEqual(["lost", "delivered"]);
    expect(terminals.some(({ rejectedAtAppend }) => rejectedAtAppend === true)).toBe(false);
  });

  test("orphan recovery kills the live harness group, records PIDs, then marks lost", async () => {
    const root = await stateRoot("orphan");
    const pause = barrier();
    const first = fixture(root, {
      processDelayMs: 30_000,
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const workspace = paths(root, attempt);
    const fingerprint = readShimFingerprint(workspace.meta);
    if (fingerprint?.harnessPid === undefined) throw new Error("fixture shim did not publish harness PID");
    process.kill(fingerprint.pid, "SIGKILL");
    await waitFor(() => !probeShimAlive(workspace.meta).alive, "shim did not die");
    const recovered = await restartWhilePaused(root, first, pause, attempt);
    expect((await recovered.recover(attempt)).detail).toBe("orphaned");
    expect(await terminalState(recovered, attempt)).toBe("lost");
    const reconciliation = (await journalEvents(root, attempt))
      .find(({ type }) => type === "reconciliation");
    expect(reconciliation?.details["killedPids"]).toContain(fingerprint.harnessPid);
    expect(() => process.kill(-fingerprint.harnessPid!, 0)).toThrow();
    pause.release();
  });

  test("a terminal with live survivors wins, kills them, and persists a contradictory reconciliation", async () => {
    const root = await stateRoot("terminal-survivors");
    const pause = barrier();
    const first = fixture(root, {
      processDelayMs: 30_000,
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const workspace = paths(root, attempt);
    const fingerprint = readShimFingerprint(workspace.meta);
    if (fingerprint?.harnessPid === undefined) throw new Error("fixture shim did not publish harness PID");
    openAttemptJournal(workspace.meta).append({
      attemptId: attempt,
      type: "attempt-terminal",
      details: { state: "failed", blame: "task", source: "urn:jinn:backend-local:recovery-test" },
    });
    const recovered = await restartWhilePaused(root, first, pause, attempt);
    expect((await recovered.recover(attempt)).classification).toBe("contradictory");
    expect((await recovered.observe(attempt)).descriptor.derived.state).toBe("failed");
    const reconciliation = (await journalEvents(root, attempt))
      .find(({ type }) => type === "reconciliation");
    expect(reconciliation?.details["killedPids"]).toContain(fingerprint.harnessPid);
    expect(() => process.kill(-fingerprint.harnessPid!, 0)).toThrow();
    pause.release();
  });

  test("two non-lost terminals preserve the first and persist the contradiction during recovery", async () => {
    const root = await stateRoot("contradictory-terminals");
    const pause = barrier();
    const first = fixture(root, {
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const journal = openAttemptJournal(paths(root, attempt).meta);
    journal.append({
      attemptId: attempt,
      type: "attempt-terminal",
      details: { state: "failed", blame: "task", source: "urn:jinn:backend-local:recovery-test" },
    });
    expect(() => journal.append({
      attemptId: attempt,
      type: "attempt-terminal",
      details: { state: "delivered", source: "urn:jinn:backend-local:recovery-test" },
    })).toThrow("contradictory terminal");
    const recovered = await restartWhilePaused(root, first, pause, attempt);
    expect((await recovered.recover(attempt)).classification).toBe("contradictory");
    expect((await recovered.observe(attempt)).descriptor.derived.state).toBe("failed");
    expect((await journalEvents(root, attempt)).some(
      ({ type, details }) => type === "reconciliation"
        && details["classification"] === "contradictory",
    )).toBe(true);
    pause.release();
  });

  test("engaged-without-intent rejects never-executed; intent-without-reality becomes lost", async () => {
    const engagedRoot = await stateRoot("engaged");
    const pause = barrier();
    const engaged = fixture(engagedRoot, {
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
    });
    const engagedAttempt = (await submit(engaged)).attempt;
    await pause.entered;
    await replaceJournal(engagedRoot, engagedAttempt, (events) =>
      events.filter(({ type }) => type === "attempt-engaged"));
    const engagedRecovered = await restartWhilePaused(engagedRoot, engaged, pause, engagedAttempt);
    expect((await engagedRecovered.recover(engagedAttempt)).classification).toBe("absent");
    const engagedTerminal = (await journalEvents(engagedRoot, engagedAttempt))
      .find(({ type }) => type === "attempt-terminal");
    expect(engagedTerminal?.details).toMatchObject({ state: "rejected", neverExecuted: true });
    pause.release();

    const intendedRoot = await stateRoot("intended");
    const intended = fixture(intendedRoot, {
      secretForwards: [{ grantKey: "key", target: "key" }],
      plan(_view, workspace) {
        return {
          argv: [process.execPath, "-e", "process.exit(0)"],
          env: { SECRET: "secrets/key" },
          cwd: workspace.work,
          validExitCodes: [0],
          resultContract: { envelopeFormat: "fixture" },
          interruptionBehavior: "repeatable",
          secretForwards: [{ grantKey: "key", target: "key" }],
        };
      },
    });
    const intendedAttempt = (await submit(intended)).attempt;
    await replaceJournal(intendedRoot, intendedAttempt, (events) =>
      events.filter(({ type }) => type !== "attempt-terminal"));
    await handoffWriter(intended);
    const intendedRecovered = fixture(intendedRoot);
    expect((await intendedRecovered.recover(intendedAttempt)).classification).toBe("absent");
    expect(await terminalState(intendedRecovered, intendedAttempt)).toBe("lost");
  });

  test("recovery rejects a selector identity change and never calls the launcher", async () => {
    const root = await stateRoot("selector-id");
    const pause = barrier();
    const planCalls = { value: 0 };
    const first = fixture(root, {
      completionBarrier: { phase: "before-harvest", barrier: pause },
      planCalls,
      selectorId: "provisioner-a",
    });
    const { attempt } = await submit(first);
    await pause.entered;
    await handoffWriter(first, () => pause.release());
    const recovered = fixture(root, { planCalls, selectorId: "provisioner-b" });
    await expect(recovered.recover(attempt)).rejects.toMatchObject({
      category: "backend-unavailable",
    });
    expect(planCalls.value).toBe(1);
    expect((await journalEvents(root, attempt)).some(
      ({ type, details }) => type === "reconciliation" && details["classification"] === "contradictory",
    )).toBe(true);
    pause.release();
  });

  test("recovery seal-validates exact dispatch bytes and structurally validates the full journaled plan", async () => {
    const root = await stateRoot("durable-validation");
    const pause = barrier();
    const first = fixture(root, {
      completionBarrier: { phase: "before-harvest", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    const workspace = paths(root, attempt);
    const originalDispatchBytes = await readFile(join(workspace.meta, "dispatch-context.sealed"));
    await handoffWriter(first, () => pause.release());

    await writeFile(join(workspace.meta, "dispatch-context.sealed"), '{"attempt":"tampered"}');
    const dispatchRecovery = fixture(root);
    await expect(dispatchRecovery.recover(attempt)).rejects.toMatchObject({
      category: "invalid-document",
    });
    await dispatchRecovery.shutdown();

    const events = await journalEvents(root, attempt);
    const intentIndex = events.findIndex(({ type }) => type === "spawn-intended");
    const intent = events[intentIndex]!;
    const malformed = {
      ...(intent.details["launchPlan"] as Record<string, unknown>),
      blameExitCodes: [{ match: {}, blame: "task", reasonCode: "" }],
    };
    events[intentIndex] = {
      ...intent,
      details: {
        ...intent.details,
        launchPlan: malformed,
        launchPlanDigest: documentDigest(serializeCanonicalJson(malformed)),
      },
    };
    await replaceJournal(root, attempt, () => events);
    await writeFile(join(workspace.meta, "dispatch-context.sealed"), originalDispatchBytes);
    const planRecovery = fixture(root);
    await expect(planRecovery.recover(attempt)).rejects.toMatchObject({
      category: "invalid-document",
    });
    pause.release();
  });

  test("recording recovery rejects a malformed harvested event instead of trusting a cast", async () => {
    const root = await stateRoot("harvest-validation");
    const pause = barrier();
    const first = fixture(root, {
      completionBarrier: { phase: "after-harvest", barrier: pause },
    });
    const { attempt } = await submit(first);
    await pause.entered;
    await handoffWriter(first, () => pause.release());
    await replaceJournal(root, attempt, (events) => events.map((event) =>
      event.type === "harvested"
        ? { ...event, details: { ...event.details, manifest: [{ path: "patch", sizeBytes: -1, sha256: "wrong" }] } }
        : event));

    const recovered = fixture(root);
    await expect(recovered.recover(attempt)).rejects.toMatchObject({
      category: "invalid-document",
    });
    pause.release();
  });

  test("cancellation records once, signals the real shim subtree, then harvests and terminalizes cancelled", async () => {
    const root = await stateRoot("cancel-completion");
    const harvestCalls = { value: 0 };
    const backend = fixture(root, { processDelayMs: 30_000, harvestCalls });
    const { attempt } = await submit(backend);
    await waitFor(
      () => readShimFingerprint(paths(root, attempt).meta)?.harnessPid !== undefined,
      "shim did not publish harness pid before cancellation",
    );

    expect(await backend.cancel(attempt, "operator stop")).toEqual({ requested: true });
    expect(await backend.cancel(attempt, "duplicate stop")).toEqual({ requested: true });
    await backend.drain();

    expect(await terminalState(backend, attempt)).toBe("cancelled");
    expect(harvestCalls.value).toBe(1);
    const events = await journalEvents(root, attempt);
    expect(events.filter(({ type }) => type === "cancel-requested")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "attempt-terminal").map(({ details }) => details["state"])).toEqual(["cancelled"]);
  });

  test("an execution deadline uses the same shim ladder, harvests, and terminalizes expired", async () => {
    const root = await stateRoot("deadline-completion");
    const harvestCalls = { value: 0 };
    const backend = fixture(root, { processDelayMs: 30_000, harvestCalls });
    const { attempt } = await submit(backend, new Date(Date.now() + 250).toISOString());
    await backend.drain();

    expect(await terminalState(backend, attempt)).toBe("expired");
    expect(harvestCalls.value).toBe(1);
    const events = await journalEvents(root, attempt);
    expect(events.filter(({ type }) => type === "cancel-requested").map(({ details }) => details["reason"])).toEqual(["execution deadline expired"]);
    expect(events.filter(({ type }) => type === "attempt-terminal").map(({ details }) => details["state"])).toEqual(["expired"]);
  });

  test("a positive effective relative duration is armed only after execution starts and terminalizes expired", async () => {
    const root = await stateRoot("relative-deadline");
    const backend = fixture(root, { processDelayMs: 30_000 });
    const { attempt } = await submit(backend, undefined, 100);

    expect(await terminalState(backend, attempt)).toBe("expired");
    const metadata = JSON.parse(await readFile(join(paths(root, attempt).meta, "attempt.json"), "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({ maxAttemptDurationMs: 100, execStartedAtMonotonicNs: expect.any(String), monotonicClockIdentity: expect.any(String) });
  });

  test("rejects a non-positive relative execution allowance before creating an attempt", async () => {
    const root = await stateRoot("invalid-relative-deadline");
    const backend = fixture(root);
    const { task, submission } = documents(undefined, 0);

    const acknowledgement = await backend.submit(task, submission);
    expect(acknowledgement.accepted).toBe(false);
    if (acknowledgement.accepted) throw new Error("expected invalid relative duration to be rejected");
    expect(acknowledgement.error.category).toBe("invalid-document");
  });

  test("a reset monotonic identity on recovery fails closed through the shim deadline path", async () => {
    const root = await stateRoot("relative-deadline-reset");
    const pause = barrier();
    const first = fixture(root, {
      processDelayMs: 30_000,
      completionBarrier: { phase: "before-outcome-wait", barrier: pause },
    });
    const { attempt } = await submit(first, undefined, 30_000);
    await pause.entered;
    const metadataPath = join(paths(root, attempt).meta, "attempt.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, monotonicClockIdentity: "reset-boot" }));
    const recovered = await restartWhilePaused(root, first, pause, attempt, { processDelayMs: 30_000 });
    expect(await recovered.recover(attempt)).toEqual({ classification: "matching" });
    expect(await terminalState(recovered, attempt)).toBe("expired");
    const events = await journalEvents(root, attempt);
    expect(events.filter(({ type, details }) => type === "progress" && details["degradation"] === "relative-deadline-monotonic-unavailable")).toHaveLength(1);
  });

  test("a stale shim heartbeat records one degradation while waiting without killing the attempt", async () => {
    const root = await stateRoot("heartbeat-stale");
    const backend = fixture(root, { processDelayMs: 150, heartbeatIntervalMs: 10_000 });
    const { attempt } = await submit(backend);
    await waitFor(() => readShimFingerprint(paths(root, attempt).meta) !== null, "shim did not start");
    await writeFile(join(paths(root, attempt).meta, "heartbeat"), JSON.stringify({ monotonicMs: "0", wallClock: "1970-01-01T00:00:00.000Z" }));

    expect(await terminalState(backend, attempt)).toBe("delivered");
    const events = await journalEvents(root, attempt);
    expect(events.filter(({ type, details }) => type === "progress" && details["degradation"] === "heartbeat-stale")).toHaveLength(1);
  });
});
