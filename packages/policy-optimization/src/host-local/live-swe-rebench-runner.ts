// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ResultEvaluationStatementSchema } from "@jinn-network/evidence-protocol";
import {
  BENCHMARKING_METHOD_REGISTRY,
  produceReport,
} from "@jinn-network/benchmarking-aggregate";
import {
  axisObservationsFromRuntimeObservations,
  requirementsDigest,
  runPinningPropertyId,
} from "@jinn-network/benchmarking-local";
import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import { planRun, type AttemptWaitPort } from "@jinn-network/benchmarking-run";
import {
  canonicalJsonBytes,
  expressAsRunPinning,
  hashTreeLearnerPublicV1,
  prefixedDigest,
  tupleDigest,
  type ExecutionPolicyTuple,
  type JsonValue,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import {
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import {
  EVALUATION_LAUNCHER_ID,
  makeEvaluationLauncher,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  buildEvaluationTaskProfile,
  buildRepositoryWorkProfile,
  EVALUATION_TASK_PROFILE_URI,
  parseEvaluationSpec,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
  type EvaluationSpec,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  TaskSpecificationSchema,
  documentDigest,
  sealSubmission,
  sealTask,
  type DeliveryRecord,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import {
  makeDirProvisioner,
  makeWorktreeProvisioner,
  type ProvisionerContract,
} from "@jinn-network/task-execution-workspace";
import { assembleWaveMatrix } from "../execute.js";
import { parseExactNextRunPolicySnapshot } from "../next-run-policy-snapshot.js";
import { projectRecommendation, SAME_OPERATOR_EVALUATION_LIMITATION } from "../recommendation.js";
import { parseExactPolicyOptimizationSplitManifest } from "../split-manifest.js";
import type { WaveCellEvidence, WaveExecution, WavePlan } from "../wave-types.js";
import { parseExactLiveCampaignInputs } from "./live-campaign-parse.js";
import {
  drainOrCancel,
  requestCancellationAndDrain,
  type CancellationRequest,
} from "./cancellation.js";
import { dispatchEvaluation, deriveEvaluationDispatch } from "./evaluation-dispatch.js";
import {
  LIVE_EVALUATOR_ID,
  LIVE_EVALUATOR_REGISTRATION_ID,
  evaluationHarnessDeployment,
} from "./evaluator-deployment-entry.js";
import { ensurePinnedOciImage, validateAndSignEvaluatorStatement } from "./grader-oci.js";
import { LiveHostJournal, type LiveHostJournalTransaction } from "./journal.js";
import {
  LOCAL_LOADOUT_ARCHIVE_FORMAT_TOKEN,
  type SealedLocalLoadoutArchive,
} from "./loadout-archive.js";
import { liveHostPurposeKey } from "./purpose-keys.js";
import { createRoleScopedLocalBackends, type RoleScopedBackends } from "./role-backends.js";
import {
  LIVE_SOLVER_AUTH_GRANT,
  liveSolverWrapperDigest,
  makeLiveSolverLauncher,
} from "./solver-launcher.js";
import {
  HostStateError,
  ensurePrivateDirectory,
  secureAtomicWrite,
  secureRead,
} from "./state.js";
import {
  LOCAL_SWE_REBENCH_EVALUATION_METHOD,
  pinnedSweRebenchImage,
} from "./swe-rebench-grader-source.js";
import {
  LOCAL_SWE_REBENCH_RUN_PLAN_FORMAT_TOKEN,
  type PinnedHarness,
} from "./swe-rebench-journey.js";
import { retrieveExactDeliveries, submitPreparedDispatch } from "./dispatch.js";

const REQUESTER = "urn:jinn:policy-optimization:local-operator";
const EVALUATOR_HARNESS_VERSION = "0.1.0";
const AUTH_DESCRIPTOR = Object.freeze({ kind: "local-codex-session-v1" });
interface LocalRunPlan {
  readonly campaignDigest: string;
  readonly snapshotDigest: string;
  readonly splitManifestDigest: string;
  readonly promotionBenchmarkDigest: string;
  readonly current: { readonly archiveDigest: string; readonly treeDigest: string };
  readonly candidate: { readonly archiveDigest: string; readonly treeDigest: string };
  readonly policyTuples: { readonly current: string; readonly candidate: string };
  readonly route: {
    readonly harness: PinnedHarness;
    readonly isolationPolicy: string;
    readonly model: string;
    readonly name: string;
  };
  readonly hostImplementations: {
    readonly evaluatorMethodDigest: string;
    readonly solverWrapperDigest: string;
  };
  readonly pool: readonly {
    readonly taskDigest: string;
    readonly evaluationSpecDigest: string;
    readonly receiptDigest: string;
  }[];
}

interface PreparedTask {
  readonly taskBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly taskDigest: string;
  readonly evaluationSpecBytes: Uint8Array;
  readonly evaluationSpec: EvaluationSpec;
  readonly evaluationSpecDigest: string;
}

interface EvaluationMaterial {
  readonly subjectTask: Uint8Array;
  readonly subjectDelivery: Uint8Array;
  readonly results: ReadonlyMap<string, Uint8Array>;
  readonly evaluationSpec: Uint8Array;
}

export interface LiveSweRebenchRunInput {
  readonly preparedRoot: string;
  readonly stateRoot: string;
  readonly codexAuthPath: string;
  readonly executableChangeConsent: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly onProgress?: (message: string) => void;
}

export interface LiveSweRebenchRunResult {
  readonly status: "proven" | "promising" | "inconclusive";
  readonly recommendedTupleDigest: string;
  readonly currentTupleDigest: string;
  readonly challengerTupleDigest: string;
  readonly reasonCodes: readonly string[];
  readonly runDigest: string;
  readonly matrixDigest: string;
  readonly reportDigests: readonly string[];
  readonly resultPath: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function exactCanonical(path: string): { readonly bytes: Uint8Array; readonly value: unknown } {
  const bytes = secureRead(path);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HostStateError("state-io", `${basename(path)} is not exact UTF-8 JSON`); }
  const canonical = canonicalJsonBytes(value as JsonValue);
  if (!sameBytes(bytes, canonical)) throw new HostStateError("state-io", `${basename(path)} is not exact canonical JSON`);
  return { bytes, value };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostStateError("state-io", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new HostStateError("state-io", `${label} is not an exact sha256 digest`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new HostStateError("state-io", `${label} is missing`);
  }
  return value;
}

function parseRunPlan(path: string): { readonly bytes: Uint8Array; readonly digest: string; readonly plan: LocalRunPlan } {
  const exact = exactCanonical(path);
  const root = object(exact.value, "run plan");
  const expected = [
    "campaignDigest", "candidate", "current", "formatToken", "hostImplementations", "policyTuples",
    "pool", "promotionBenchmarkDigest", "route", "snapshotDigest", "source", "splitManifestDigest",
  ].sort();
  if (Object.keys(root).sort().join("\0") !== expected.join("\0")
    || root["formatToken"] !== LOCAL_SWE_REBENCH_RUN_PLAN_FORMAT_TOKEN) {
    throw new HostStateError("state-io", "run plan has missing, unknown, or unsupported fields");
  }
  const route = object(root["route"], "run plan route");
  const harness = object(route["harness"], "run plan harness");
  const current = object(root["current"], "run plan current loadout");
  const candidate = object(root["candidate"], "run plan candidate loadout");
  const tuples = object(root["policyTuples"], "run plan policy tuples");
  const implementations = object(root["hostImplementations"], "run plan host implementations");
  if (!Array.isArray(root["pool"])) throw new HostStateError("state-io", "run plan pool is missing");
  const plan: LocalRunPlan = {
    campaignDigest: digest(root["campaignDigest"], "campaign digest"),
    snapshotDigest: digest(root["snapshotDigest"], "snapshot digest"),
    splitManifestDigest: digest(root["splitManifestDigest"], "split manifest digest"),
    promotionBenchmarkDigest: digest(root["promotionBenchmarkDigest"], "promotion Benchmark digest"),
    current: {
      archiveDigest: digest(current["archiveDigest"], "current archive digest"),
      treeDigest: digest(current["treeDigest"], "current tree digest"),
    },
    candidate: {
      archiveDigest: digest(candidate["archiveDigest"], "candidate archive digest"),
      treeDigest: digest(candidate["treeDigest"], "candidate tree digest"),
    },
    policyTuples: {
      current: digest(tuples["current"], "current tuple digest"),
      candidate: digest(tuples["candidate"], "candidate tuple digest"),
    },
    route: {
      harness: {
        id: string(harness["id"], "harness id"),
        executable: string(harness["executable"], "harness executable"),
        digest: digest(harness["digest"], "harness digest"),
        version: string(harness["version"], "harness version"),
      },
      isolationPolicy: string(route["isolationPolicy"], "isolation policy"),
      model: string(route["model"], "model"),
      name: string(route["name"], "route name"),
    },
    hostImplementations: {
      evaluatorMethodDigest: digest(implementations["evaluatorMethodDigest"], "evaluator method digest"),
      solverWrapperDigest: digest(implementations["solverWrapperDigest"], "solver wrapper digest"),
    },
    pool: root["pool"].map((value, index) => {
      const entry = object(value, `run plan pool ${index}`);
      return {
        taskDigest: digest(entry["taskDigest"], "pool Task digest"),
        evaluationSpecDigest: digest(entry["evaluationSpecDigest"], "pool EvaluationSpec digest"),
        receiptDigest: digest(entry["receiptDigest"], "pool receipt digest"),
      };
    }),
  };
  return { bytes: exact.bytes, digest: prefixedDigest(exact.bytes), plan };
}

function loadout(path: string, expected: { readonly archiveDigest: string; readonly treeDigest: string }): SealedLocalLoadoutArchive {
  const exact = exactCanonical(path);
  const value = object(exact.value, "loadout archive");
  if (value["formatToken"] !== LOCAL_LOADOUT_ARCHIVE_FORMAT_TOKEN
    || value["hashProfile"] !== "learner-public.v1" || !Array.isArray(value["entries"])) {
    throw new HostStateError("state-io", "loadout archive format moved");
  }
  const entries = value["entries"] as TreeEntry[];
  const treeDigest = `sha256:${hashTreeLearnerPublicV1(entries)}`;
  if (prefixedDigest(exact.bytes) !== expected.archiveDigest
    || value["treeDigest"] !== expected.treeDigest || treeDigest !== expected.treeDigest) {
    throw new HostStateError("state-io", "loadout archive or materialized-tree binding moved");
  }
  return {
    root: dirname(path), entries, bytes: exact.bytes,
    archiveDigest: expected.archiveDigest, treeDigest: expected.treeDigest,
  };
}

async function processExit(command: string, args: readonly string[], cwd?: string): Promise<void> {
  const child = spawn(command, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: "ignore",
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 70));
  });
  if (code !== 0) throw new HostStateError("state-io", "public repository preparation failed");
}

function repositoryBinding(task: TaskSpecification): { readonly remote: string; readonly oid: string } {
  const descriptor = task.inputs?.find((entry) => entry.name === "repository-state");
  const annotations = descriptor?.annotations;
  const oid = annotations === undefined ? undefined : annotations["ref"];
  if (typeof descriptor?.uri !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/u.test(descriptor.uri)
    || typeof oid !== "string" || !/^[a-f0-9]{40}$/u.test(oid)) {
    throw new HostStateError("state-io", "prepared Task has no exact public repository binding");
  }
  return { remote: descriptor.uri, oid };
}

async function prepareReferenceRepository(stateRoot: string, task: TaskSpecification): Promise<{ readonly path: string; readonly oid: string }> {
  const binding = repositoryBinding(task);
  const identity = createHash("sha256").update(binding.remote).digest("hex");
  const path = join(ensurePrivateDirectory(join(stateRoot, "repository-cache")), identity);
  if (!existsSync(join(path, "HEAD"))) {
    ensurePrivateDirectory(path);
    await processExit("git", ["init", "--bare", path]);
  }
  await processExit("git", ["-C", path, "fetch", "--depth=1", binding.remote, binding.oid]);
  await processExit("git", ["-C", path, "cat-file", "-e", `${binding.oid}^{commit}`]);
  return { path, oid: binding.oid };
}

function taskProfileStore(): ProfileStore {
  const profiles = [buildRepositoryWorkProfile(), buildEvaluationTaskProfile()];
  const byDigest = new Map(profiles.map((profile) => [sealTaskProfile(profile).digest, profile]));
  return { get: (digestValue) => byDigest.get(digestValue) };
}

function workspaceRuntime() {
  return {
    assertHarnessGroupEmpty: () => undefined,
    ensureMetaReserve: () => undefined,
  };
}

export function resourceSha256Digest(descriptor: { readonly digest?: unknown }): string | undefined {
  if (typeof descriptor.digest === "string") {
    return /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest) ? descriptor.digest : undefined;
  }
  if (typeof descriptor.digest !== "object" || descriptor.digest === null
    || !("sha256" in descriptor.digest)) return undefined;
  const sha256 = (descriptor.digest as { readonly sha256?: unknown }).sha256;
  return typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256)
    ? `sha256:${sha256}`
    : undefined;
}

function solverProvisioner(input: {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly referenceRepository: string;
  readonly oid: string;
  readonly currentLoadout: SealedLocalLoadoutArchive;
  readonly candidateLoadout: SealedLocalLoadoutArchive;
}): ProvisionerContract {
  const archives = new Map([
    [input.currentLoadout.treeDigest, input.currentLoadout.bytes],
    [input.candidateLoadout.treeDigest, input.candidateLoadout.bytes],
  ]);
  const base = makeWorktreeProvisioner({
    sealedTaskBytes: input.sealedTaskBytes,
    dispatchContextBytes: input.dispatchContextBytes,
    referenceRepository: input.referenceRepository,
    oid: input.oid,
    runtime: workspaceRuntime(),
    fetchInput: async (descriptor) => {
      // General Task resources spell digests as `{sha256}`, while a canonical loadout pin
      // deliberately spells the same value as the string `sha256:<hex>`. The provisioner sees
      // both shapes through this one callback and must resolve each without weakening either.
      const requested = resourceSha256Digest(descriptor);
      const archive = requested === undefined ? undefined : archives.get(requested);
      if (archive !== undefined) return archive.slice();
      if (descriptor.name === "repository-state") {
        return canonicalJsonBytes({ oid: input.oid, repository: input.referenceRepository });
      }
      throw new HostStateError("state-io", "solver provisioner refused an unknown input digest");
    },
  });
  return {
    ...base,
    executionEnv(launch) {
      const allowed = new Set([
        "JINN_ATTEMPT_HARNESS_STATE", "JINN_ATTEMPT_INPUT", "JINN_ATTEMPT_LOGS",
        "JINN_ATTEMPT_OUT", "JINN_ATTEMPT_SECRETS", "JINN_ATTEMPT_WORK", "TMPDIR",
        "JINN_SOLVER_AUTH_FILE", "JINN_SOLVER_EXECUTABLE", "JINN_SOLVER_HARNESS",
        "JINN_SOLVER_LOADOUT", "JINN_SOLVER_LOADOUT_DIGEST", "JINN_SOLVER_MODEL", "JINN_SOLVER_PATH",
      ]);
      return Object.fromEntries(Object.entries(launch.env).filter(([key]) => allowed.has(key)));
    },
    async harvest(paths, outputs) {
      try { return await base.harvest(paths, outputs); }
      finally {
        await processExit("git", ["-C", input.referenceRepository, "worktree", "remove", "--force", paths.work])
          .catch(() => rm(paths.work, { recursive: true, force: true }));
        await processExit("git", ["-C", input.referenceRepository, "worktree", "prune"]).catch(() => undefined);
      }
    },
  };
}

function evaluatorProvisioner(input: {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly material: EvaluationMaterial;
}): ProvisionerContract {
  const byDigest = new Map<string, Uint8Array>([
    [documentDigest(input.material.subjectTask), input.material.subjectTask],
    [documentDigest(input.material.subjectDelivery), input.material.subjectDelivery],
    ...[...input.material.results.values()].map((bytes) => [prefixedDigest(bytes), bytes] as const),
  ]);
  const base = makeDirProvisioner({
    sealedTaskBytes: input.sealedTaskBytes,
    dispatchContextBytes: input.dispatchContextBytes,
    runtime: workspaceRuntime(),
    fetchInput: async (descriptor) => {
      const value = descriptor.digest?.sha256 === undefined
        ? undefined : byDigest.get(`sha256:${descriptor.digest.sha256}`);
      if (value === undefined) throw new HostStateError("state-io", "evaluator provisioner refused an unknown subject digest");
      return value.slice();
    },
  });
  return {
    ...base,
    async setup(view, paths, grants) {
      await mkdir(paths.input, { recursive: true });
      await writeFile(join(paths.input, "evaluation-spec.json"), input.material.evaluationSpec, { mode: 0o400, flag: "wx" });
      await writeFile(join(paths.input, "evaluation-context.json"), canonicalJsonBytes({}), { mode: 0o400, flag: "wx" });
      await base.setup(view, paths, grants);
    },
  };
}

function executableIdentity(path: string): { readonly path: string; readonly digest: string } {
  const exact = realpathSync(path);
  return { path: exact, digest: `sha256:${createHash("sha256").update(readFileSync(exact)).digest("hex")}` };
}

export function evaluationHarnessEntrypoint(): string {
  // This package is ESM-only and intentionally exposes no `require` condition. Resolving it
  // through createRequire therefore fails even though the same package is already imported by
  // this module. Use the ESM resolver so the installed-package and workspace layouts agree.
  const index = fileURLToPath(import.meta.resolve("@jinn-network/task-execution-evaluation-harness"));
  return join(dirname(index), "bin.js");
}

function createBackends(input: {
  readonly stateRoot: string;
  readonly plan: LocalRunPlan;
  readonly authPath: string;
  readonly currentLoadout: SealedLocalLoadoutArchive;
  readonly candidateLoadout: SealedLocalLoadoutArchive;
  readonly repositoryByTask: ReadonlyMap<string, { readonly path: string; readonly oid: string }>;
  readonly evaluationMaterials: ReadonlyMap<string, EvaluationMaterial>;
}): RoleScopedBackends {
  const keys = {
    solver: liveHostPurposeKey(input.stateRoot, "solver-delivery"),
    evaluatorBackend: liveHostPurposeKey(input.stateRoot, "evaluator-backend-delivery"),
    evaluatorVerdict: liveHostPurposeKey(input.stateRoot, "evaluator-verdict"),
    report: liveHostPurposeKey(input.stateRoot, "report-author"),
    journal: liveHostPurposeKey(input.stateRoot, "journal-author"),
  };
  const profileStore = taskProfileStore();
  const solverLauncher = makeLiveSolverLauncher({
    harness: input.plan.route.harness,
    model: input.plan.route.model,
    path: process.env["PATH"] ?? "/usr/bin:/bin",
  });
  const evaluatorRegistration = evaluationHarnessDeployment.registrations.find(
    (candidate) => candidate.registrationId === LIVE_EVALUATOR_REGISTRATION_ID,
  );
  if (evaluatorRegistration === undefined) throw new HostStateError("state-io", "live evaluator registration is missing");
  const evaluatorEntrypoint = evaluationHarnessEntrypoint();
  const evaluatorExecutable = executableIdentity(evaluatorEntrypoint);
  const evaluatorLauncher = makeEvaluationLauncher({
    deploymentModule: pathToFileURL(fileURLToPath(new URL("./evaluator-deployment-entry.js", import.meta.url))).href,
    entrypoint: evaluatorEntrypoint,
    registrations: [evaluatorRegistration],
    selectRegistration: () => evaluatorRegistration,
  });
  const commonProvisionerCapabilities = {
    maxArtifactBytes: 64 * 1024 * 1024,
  };
  const solver: Omit<LocalTaskExecutionBackendConfig, "stateRoot"> = {
    source: "urn:jinn:policy-optimization:solver-backend",
    executor: keys.solver.identity,
    profileStore,
    launchers: [solverLauncher],
    launcherDeployments: {
      [solverLauncher.id]: {
        executable: { path: input.plan.route.harness.executable, digest: input.plan.route.harness.digest },
        probe: async () => {
          let actual: { path: string; digest: string };
          try { actual = executableIdentity(input.plan.route.harness.executable); }
          catch { return { ready: false, executable: { path: "unavailable", digest: "unavailable" } }; }
          return {
            ready: actual.path === input.plan.route.harness.executable && actual.digest === input.plan.route.harness.digest,
            executable: actual,
            harnessVersions: [input.plan.route.harness.version],
            models: [input.plan.route.model],
            loadouts: [input.currentLoadout, input.candidateLoadout].map((loadoutValue) => ({
              kind: "jinn.harness-state.v1" as const,
              name: "learner-public",
              digest: loadoutValue.treeDigest,
            })),
          };
        },
      },
    },
    provisioner(local) {
      const taskDigest = documentDigest(local.sealedTaskBytes);
      const repository = input.repositoryByTask.get(taskDigest);
      if (repository === undefined) throw new HostStateError("state-io", "solver Task has no prepared reference repository");
      return {
        id: `swe-rebench-worktree/${taskDigest}`,
        contract: solverProvisioner({
          sealedTaskBytes: local.sealedTaskBytes,
          dispatchContextBytes: local.dispatchContextBytes,
          referenceRepository: repository.path,
          oid: repository.oid,
          currentLoadout: input.currentLoadout,
          candidateLoadout: input.candidateLoadout,
        }),
      };
    },
    provisionerCapabilities: {
      ...commonProvisionerCapabilities,
      taskProfiles: [REPOSITORY_WORK_PROFILE_URI], workspaceKinds: ["worktree"],
      inputMediaTypes: ["application/json", "text/plain"], outputMediaTypes: ["text/x-diff"],
      isolation: [input.plan.route.isolationPolicy],
    },
    capabilityGrants: (grants) => Object.entries(grants).map(([key, descriptor]) => ({ key, descriptor })),
    secretForwardResolver: {
      async resolve(request, options) {
        options.signal?.throwIfAborted();
        if (request.grantKey !== LIVE_SOLVER_AUTH_GRANT
          || !sameBytes(
            canonicalJsonBytes(request.descriptor as JsonValue),
            canonicalJsonBytes(AUTH_DESCRIPTOR),
          )) {
          throw new HostStateError("state-io", "solver secret grant is not the exact local Codex session grant");
        }
        const bytes = secureRead(input.authPath);
        options.signal?.throwIfAborted();
        return bytes;
      },
    },
    trustKeys: { deliverySigningKey: keys.solver.deliverySigningKey },
    maxConcurrentAttempts: 1,
  };
  const evaluator: Omit<LocalTaskExecutionBackendConfig, "stateRoot"> = {
    source: "urn:jinn:policy-optimization:evaluator-backend",
    executor: keys.evaluatorBackend.identity,
    profileStore,
    launchers: [evaluatorLauncher],
    launcherDeployments: {
      [EVALUATION_LAUNCHER_ID]: {
        executable: evaluatorExecutable,
        probe: async () => ({
          ready: executableIdentity(evaluatorEntrypoint).digest === evaluatorExecutable.digest,
          executable: executableIdentity(evaluatorEntrypoint),
          harnessVersions: [EVALUATOR_HARNESS_VERSION],
        }),
      },
    },
    provisioner(local) {
      const material = input.evaluationMaterials.get(documentDigest(local.sealedTaskBytes));
      if (material === undefined) throw new HostStateError("state-io", "evaluator Task has no exact registered subject material");
      return {
        id: `swe-rebench-evaluation/${documentDigest(local.sealedTaskBytes)}`,
        contract: evaluatorProvisioner({
          sealedTaskBytes: local.sealedTaskBytes,
          dispatchContextBytes: local.dispatchContextBytes,
          material,
        }),
      };
    },
    provisionerCapabilities: {
      ...commonProvisionerCapabilities,
      taskProfiles: [EVALUATION_TASK_PROFILE_URI], workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json", "text/x-diff"],
      outputMediaTypes: ["application/vnd.in-toto+json"], isolation: ["process"],
    },
    trustKeys: { deliverySigningKey: keys.evaluatorBackend.deliverySigningKey },
    maxConcurrentAttempts: 1,
  };
  return createRoleScopedLocalBackends({
    stateRoot: input.stateRoot,
    identities: {
      solverDelivery: keys.solver.identity,
      evaluatorVerdict: keys.evaluatorVerdict.identity,
      reportAuthor: keys.report.identity,
      journalAuthor: keys.journal.identity,
    },
    purposeKeys: {
      solverDelivery: keys.solver.keyId,
      evaluatorBackendDelivery: keys.evaluatorBackend.keyId,
      evaluatorVerdict: keys.evaluatorVerdict.keyId,
      reportAuthor: keys.report.keyId,
      journalAuthor: keys.journal.keyId,
    },
    solver,
    evaluator,
  });
}

function parseTask(path: string, evaluationSpecPath: string, declared: LocalRunPlan["pool"][number]): PreparedTask {
  const taskBytes = secureRead(path);
  let taskValue: unknown;
  try { taskValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes)); }
  catch { throw new HostStateError("state-io", "prepared Task is not JSON"); }
  const taskParsed = TaskSpecificationSchema.safeParse(taskValue);
  if (!taskParsed.success || !sameBytes(sealTask(taskParsed.data), taskBytes)
    || documentDigest(taskBytes) !== declared.taskDigest) {
    throw new HostStateError("state-io", "prepared Task bytes or digest moved");
  }
  const evaluationSpecBytes = secureRead(evaluationSpecPath);
  const evaluationSpec = parseEvaluationSpec(evaluationSpecBytes);
  if (prefixedDigest(evaluationSpecBytes) !== declared.evaluationSpecDigest
    || taskParsed.data.evaluation?.digest?.sha256 !== declared.evaluationSpecDigest.slice("sha256:".length)) {
    throw new HostStateError("state-io", "prepared EvaluationSpec bytes or Task binding moved");
  }
  return {
    taskBytes, task: taskParsed.data, taskDigest: declared.taskDigest,
    evaluationSpecBytes, evaluationSpec, evaluationSpecDigest: declared.evaluationSpecDigest,
  };
}

function deterministicSubmission(input: {
  readonly campaign: string;
  readonly run: string;
  readonly cellKey: string;
  readonly armId: string;
  readonly taskDigest: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly deadline: string;
}): { readonly bytes: Uint8Array; readonly nonce: string; readonly idempotencyKey: string } {
  const identity = prefixedDigest(canonicalJsonBytes({
    campaign: input.campaign, run: input.run, cellKey: input.cellKey, armId: input.armId, dispatch: 1,
  }));
  const hex = identity.slice("sha256:".length);
  const submission = `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const idempotencyKey = `network.jinn.policy-optimization/live-solver/1.0/${identity}`;
  const nonce = prefixedDigest(new TextEncoder().encode(`${idempotencyKey}\0nonce`));
  return {
    nonce,
    idempotencyKey,
    bytes: sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission,
      task: { digest: { sha256: input.taskDigest.slice("sha256:".length) } },
      requester: REQUESTER,
      idempotencyKey,
      nonce,
      deadline: input.deadline,
      requirements: input.requirements,
      capabilityGrants: { [LIVE_SOLVER_AUTH_GRANT]: AUTH_DESCRIPTOR },
      annotations: submissionExtensionBlock(input.run, input.cellKey, input.armId),
    }),
  };
}

function terminalEvidence(snapshot: unknown): string {
  return prefixedDigest(canonicalJsonBytes(snapshot as JsonValue));
}

function freshWaitContext(): AttemptWaitPort {
  return {
    async waitUntilTerminal({ backend, attempt, closeAt }) {
      const deadline = Date.parse(closeAt);
      if (!Number.isFinite(deadline)) throw new HostStateError("state-io", "cancellation close time is invalid");
      for (;;) {
        const snapshot = await backend.observe(attempt as never);
        if (snapshot.descriptor.derived.terminal) return snapshot;
        if (Date.now() >= deadline) {
          throw new HostStateError("state-io", "cancellation drain reached the campaign close time");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    },
  };
}

function cancellationRequest(input: {
  readonly transaction: LiveHostJournalTransaction;
  readonly roles: RoleScopedBackends;
  readonly recordedAt: string;
  readonly closeAt: string;
}): CancellationRequest {
  return {
    transaction: input.transaction,
    backends: input.roles,
    waitContexts: { create: freshWaitContext },
    recordedAt: input.recordedAt,
    reasonCode: "operator-interrupt",
    closeAt: input.closeAt,
    terminalEvidenceDigest: async ({ attempt, role }) =>
      terminalEvidence(await input.roles[role].observe(attempt as never)),
  };
}

function closeCancelledCampaign(transaction: LiveHostJournalTransaction, recordedAt: string): never {
  if (transaction.state.phase === "CANCELLING" && transaction.state.activeAttempts.size === 0) {
    transaction.append({
      type: "closed",
      recordedAt,
      payload: { reasonCode: "operator-cancelled-no-recommendation" },
    });
  }
  throw new HostStateError("state-io", "campaign was cancelled; no recommendation was produced");
}

function attemptTerminalState(snapshot: Awaited<ReturnType<LocalTaskExecutionBackend["observe"]>>):
  "delivered" | "failed" | "cancelled" | "expired" | "lost" | "rejected" {
  const state = snapshot.descriptor.derived.state;
  if (["delivered", "failed", "cancelled", "expired", "lost", "rejected"].includes(state)) {
    return state as "delivered" | "failed" | "cancelled" | "expired" | "lost" | "rejected";
  }
  throw new HostStateError("state-io", "backend drain ended before the Attempt became terminal");
}

function appendTerminalOnce(input: {
  readonly transaction: LiveHostJournalTransaction;
  readonly runDigest: string;
  readonly cellKey: string;
  readonly armId: string;
  readonly role: "solver" | "evaluator";
  readonly attempt: string;
  readonly state: ReturnType<typeof attemptTerminalState>;
  readonly evidenceDigest: string;
  readonly at: string;
}): void {
  if (!input.transaction.state.activeAttempts.has(input.attempt)) return;
  input.transaction.append({
    type: "attempt-terminal-recorded", recordedAt: input.at,
    payload: {
      runDigest: input.runDigest, cellKey: input.cellKey, armId: input.armId, dispatch: 1,
      role: input.role, attempt: input.attempt, state: input.state, evidenceDigest: input.evidenceDigest,
    },
  });
}

function evaluationRequirements(): Readonly<Record<string, unknown>> {
  const executable = executableIdentity(evaluationHarnessEntrypoint());
  return {
    harness: { id: EVALUATION_LAUNCHER_ID, version: EVALUATOR_HARNESS_VERSION, digest: executable.digest },
  };
}

function resultDescriptorBytes(backend: LocalTaskExecutionBackend, delivery: DeliveryRecord): Promise<ReadonlyMap<string, Uint8Array>> {
  return Promise.all(delivery.outputs.map(async (descriptor) => [
    descriptor.name,
    await backend.fetchArtifact(descriptor),
  ] as const)).then((rows) => new Map(rows));
}

function statementEvidence(statementBytes: Uint8Array, envelopeBytes: Uint8Array, spec: EvaluationSpec) {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(statementBytes)); }
  catch { throw new HostStateError("state-io", "signed evaluator payload is not JSON"); }
  const statement = ResultEvaluationStatementSchema.parse(value);
  const measurements: Record<string, string | number | boolean> = {};
  for (const entry of statement.predicate.measurements ?? []) {
    if (entry.value === null) throw new HostStateError("state-io", "evaluator emitted a null required measurement");
    measurements[entry.name] = entry.value;
  }
  const specification = statement.predicate.evaluationSpecification;
  if (specification?.digest?.sha256 === undefined) throw new HostStateError("state-io", "evaluator statement has no specification digest");
  return {
    digest: prefixedDigest(envelopeBytes) as `sha256:${string}`,
    record: {
      evaluationSpecification: `sha256:${specification.digest.sha256}`,
      evaluator: statement.predicate.evaluator.id,
      verdict: statement.predicate.verdict,
    },
    measurements,
    evaluationSpec: spec,
    delivered: { verdict: statement.predicate.verdict },
  };
}

function pinningEvidence(requirements: Readonly<Record<string, unknown>>) {
  const captures = ["harness", "model", "loadout"].flatMap((axis) => {
    const value = requirements[axis];
    if (value === undefined) return [];
    return [{
      kind: "resource",
      propertyId: runPinningPropertyId(axis as "harness" | "model" | "loadout"),
      value: JSON.stringify(value),
    }];
  });
  return {
    dispatches: 1,
    admission: { ready: true, checkedRequirementsDigest: requirementsDigest(requirements) },
    observations: axisObservationsFromRuntimeObservations(captures),
  };
}

async function initializeRunArtifacts(input: {
  readonly preparedRoot: string;
  readonly campaignDigest: string;
  readonly benchmarkDigest: string;
  readonly campaign: ReturnType<typeof parseExactLiveCampaignInputs>;
  readonly currentTuple: ExecutionPolicyTuple;
  readonly candidateTuple: ExecutionPolicyTuple;
  readonly now: Date;
}): Promise<{ readonly plan: WavePlan; readonly path: string }> {
  const root = ensurePrivateDirectory(join(input.preparedRoot, "run"));
  const path = join(root, "promotion-run.json");
  let bytes: Uint8Array;
  if (existsSync(path)) {
    bytes = secureRead(path);
  } else {
    const closeAt = new Date(input.now.valueOf() + 24 * 60 * 60 * 1000).toISOString();
    const run = planRun({
      benchmarkDigest: input.benchmarkDigest,
      owner: REQUESTER,
      arms: [
        { armId: input.campaign.arms.baseline, pinning: expressAsRunPinning(input.currentTuple) },
        { armId: input.campaign.arms.candidate, pinning: expressAsRunPinning(input.candidateTuple) },
      ],
      replicates: input.campaign.executionCells.replicates,
      policy: {
        completenessFloor: "1", cellWindow: 3_600_000,
        replacement: { allowed: false }, independence: "disclosed",
        evaluation: { minVerdicts: 1, distinctEvaluator: true }, submissionBaseline: {},
      },
      analysisPlan: input.campaign.objective.methods.map((method) => ({
        method: method.id, version: method.version, parameters: { ...method.parameters },
      })),
      venue: { kind: "self-run", note: SAME_OPERATOR_EVALUATION_LIMITATION },
      closeAt,
    });
    bytes = run.bytes;
    secureAtomicWrite(path, bytes, true);
  }
  const runRecord = parseRun(bytes);
  const runDigest = documentDigest(bytes) as `sha256:${string}`;
  const benchmarkPath = join(input.preparedRoot, "promotion-benchmark.json");
  const benchmarkBytes = secureRead(benchmarkPath);
  const benchmark = parseBenchmark(benchmarkBytes);
  if (`sha256:${runRecord.benchmark.digest.sha256}` !== input.benchmarkDigest
    || prefixedDigest(benchmarkBytes) !== input.benchmarkDigest) {
    throw new HostStateError("state-io", "promotion Run does not bind the exact prepared Benchmark");
  }
  const arms = [
    { armId: input.campaign.arms.baseline, tupleDigest: input.campaign.seed.digest, source: { kind: "tuple" as const, digest: input.campaign.seed.digest }, pinning: expressAsRunPinning(input.currentTuple) },
    { armId: input.campaign.arms.candidate, tupleDigest: tupleDigest(input.candidateTuple), source: { kind: "tuple" as const, digest: tupleDigest(input.candidateTuple) }, pinning: expressAsRunPinning(input.candidateTuple) },
  ];
  return {
    path,
    plan: {
      kind: "promotion", waveNumber: 1, campaign: input.campaignDigest,
      benchmark: { digest: input.benchmarkDigest as `sha256:${string}`, bytes: benchmarkBytes, record: benchmark },
      run: { digest: runDigest, bytes, record: runRecord },
      arms,
      cells: expectedCellSet(benchmark, runRecord).length,
    },
  };
}

function preparedTasks(root: string, plan: LocalRunPlan): ReadonlyMap<string, PreparedTask> {
  return new Map(plan.pool.map((declared) => {
    const taskRoot = join(root, "pool", declared.taskDigest.slice("sha256:".length));
    const task = parseTask(join(taskRoot, "task.json"), join(taskRoot, "evaluation-spec.json"), declared);
    return [declared.taskDigest, task];
  }));
}

/**
 * Executes an explicitly confirmed, already-prepared campaign. It never applies the recommendation.
 * The journal lock spans replay, every dispatch, evaluation, append, and close.
 */
export async function runLiveSweRebenchCampaign(input: LiveSweRebenchRunInput): Promise<LiveSweRebenchRunResult> {
  const preparedRoot = realpathSync(input.preparedRoot);
  const stateRoot = ensurePrivateDirectory(input.stateRoot);
  const now = input.now ?? (() => new Date());
  const progress = input.onProgress ?? (() => undefined);
  const runPlan = parseRunPlan(join(preparedRoot, "run-plan.json"));
  const campaignExact = exactCanonical(join(preparedRoot, "campaign-inputs.json"));
  const campaign = parseExactLiveCampaignInputs(campaignExact.bytes);
  const snapshotBytes = secureRead(join(preparedRoot, "next-run-policy-snapshot.json"));
  const snapshot = parseExactNextRunPolicySnapshot(snapshotBytes);
  const splitBytes = secureRead(join(preparedRoot, "split-manifest.json"));
  const split = parseExactPolicyOptimizationSplitManifest(splitBytes);
  if (prefixedDigest(campaignExact.bytes) !== runPlan.plan.campaignDigest
    || prefixedDigest(snapshotBytes) !== runPlan.plan.snapshotDigest
    || prefixedDigest(splitBytes) !== runPlan.plan.splitManifestDigest
    || campaign.configRevision !== snapshot.configRevision
    || campaign.evidenceAccess.challengerSource !== "operator-supplied"
    || campaign.evidenceAccess.confirmationGroups.join("\0") !== split.assignments.promotion.join("\0")) {
    throw new HostStateError("state-io", "prepared campaign, snapshot, split, or configuration revision moved");
  }
  const currentLoadout = loadout(join(preparedRoot, "loadout-current.json"), runPlan.plan.current);
  const candidateLoadout = loadout(join(preparedRoot, "loadout-candidate.json"), runPlan.plan.candidate);
  const candidateTuple = { ...snapshot.seed.tuple, loadout: {
    kind: "jinn.harness-state.v1", name: "learner-public", digest: candidateLoadout.treeDigest,
  } } as ExecutionPolicyTuple;
  if (snapshot.seed.digest !== runPlan.plan.policyTuples.current
    || tupleDigest(candidateTuple) !== runPlan.plan.policyTuples.candidate
    || runPlan.plan.hostImplementations.evaluatorMethodDigest !== `sha256:${LOCAL_SWE_REBENCH_EVALUATION_METHOD.digest.sha256}`
    || runPlan.plan.hostImplementations.solverWrapperDigest !== liveSolverWrapperDigest()) {
    throw new HostStateError("state-io", "prepared policy tuple or evaluator implementation moved");
  }
  if (!input.executableChangeConsent) {
    const archive = object(JSON.parse(new TextDecoder().decode(candidateLoadout.bytes)), "candidate loadout");
    const entries = archive["entries"] as TreeEntry[];
    if (entries.some((entry) => /^(?:hooks|tools)\//u.test(entry.path))) {
      throw new HostStateError("state-io", "candidate carries executable-change roots; repeat with explicit executable-change consent");
    }
  }
  // Validate the credential file without copying it into campaign state. Exact bytes are read only
  // by the solver backend's per-Attempt secret resolver after durable spawn intent.
  let authPath: string;
  try {
    if (!existsSync(input.codexAuthPath)) throw new Error("missing");
    authPath = realpathSync(input.codexAuthPath);
  } catch {
    throw new HostStateError("state-io", "Codex session file is unavailable");
  }
  const tasks = preparedTasks(preparedRoot, runPlan.plan);
  const benchmarkBytes = secureRead(join(preparedRoot, "promotion-benchmark.json"));
  if (prefixedDigest(benchmarkBytes) !== runPlan.plan.promotionBenchmarkDigest) {
    throw new HostStateError("state-io", "prepared promotion Benchmark moved");
  }
  const purposeJournalKey = liveHostPurposeKey(stateRoot, "journal-author");
  const journal = new LiveHostJournal(stateRoot, runPlan.plan.campaignDigest, purposeJournalKey.identity);
  const result = await journal.transact(async (transaction) => {
    const at = () => now().toISOString();
    if (transaction.state.phase === "CLOSED") {
      if (transaction.state.recommendationDigest === undefined) {
        throw new HostStateError("state-io", "campaign was cancelled; no recommendation was produced");
      }
      const persisted = exactCanonical(join(preparedRoot, "run", "recommendation.json"));
      return persisted.value as LiveSweRebenchRunResult;
    }
    const initialized = await initializeRunArtifacts({
      preparedRoot, campaignDigest: runPlan.plan.campaignDigest,
      benchmarkDigest: runPlan.plan.promotionBenchmarkDigest,
      campaign, currentTuple: snapshot.seed.tuple, candidateTuple, now: now(),
    });
    if (initialized.plan.cells !== campaign.executionCells.confirmation) {
      throw new HostStateError("state-io", "sealed Run cell count contradicts the prepared campaign");
    }
    if (transaction.state.phase === "EMPTY") {
      transaction.append({ type: "plan-recorded", recordedAt: at(), payload: {
        planDigest: runPlan.digest, splitManifestDigest: runPlan.plan.splitManifestDigest,
      } });
      transaction.append({ type: "operator-challenger-frozen", recordedAt: at(), payload: {
        challengerTupleDigest: runPlan.plan.policyTuples.candidate, runPlanDigest: runPlan.digest,
      } });
      transaction.append({ type: "run-recorded", recordedAt: at(), payload: {
        runDigest: initialized.plan.run.digest, kind: "promotion",
        arms: initialized.plan.arms.map((arm) => ({ armId: arm.armId, tupleDigest: arm.tupleDigest })),
      } });
      transaction.append({ type: "promotion-revealed", recordedAt: at(), payload: {
        promotionRunDigest: initialized.plan.run.digest, splitManifestDigest: runPlan.plan.splitManifestDigest,
      } });
    }
    const shouldCancel = transaction.state.phase === "CANCELLING" || abortRequested(input.signal);
    const repositoryByTask = new Map<string, { path: string; oid: string }>();
    if (!shouldCancel) {
      const graderImages = new Map<string, ReturnType<typeof pinnedSweRebenchImage>>();
      for (const task of tasks.values()) {
        const image = pinnedSweRebenchImage(task.evaluationSpec);
        graderImages.set(`${image.platform}\0${image.image}`, image);
      }
      for (const image of graderImages.values()) {
        progress(`Preparing pinned grader image ${image.image.split("@", 1)[0]}`);
        await ensurePinnedOciImage({ runtime: "docker", ...image });
      }
      for (const taskDigest of new Set(initialized.plan.benchmark.record.items.map((item) => `sha256:${item.task.digest!.sha256}`))) {
        const task = tasks.get(taskDigest);
        if (task === undefined) throw new HostStateError("state-io", "Benchmark names no prepared Task");
        progress(`Preparing public repository ${repositoryBinding(task.task).remote}`);
        repositoryByTask.set(taskDigest, await prepareReferenceRepository(stateRoot, task.task));
      }
    }
    const evaluationMaterials = new Map<string, EvaluationMaterial>();
    const roles = createBackends({
      stateRoot, plan: runPlan.plan, authPath, currentLoadout, candidateLoadout,
      repositoryByTask, evaluationMaterials,
    });
    try {
      if (shouldCancel) {
        await requestCancellationAndDrain(cancellationRequest({
          transaction, roles, recordedAt: at(), closeAt: initialized.plan.run.record.closeAt,
        }));
        closeCancelledCampaign(transaction, at());
      }
      if (transaction.state.phase !== "ACTIVE") {
        throw new HostStateError("state-io", "campaign is cancelling and cannot accept new dispatch");
      }
      const verdictKey = liveHostPurposeKey(stateRoot, "evaluator-verdict");
      const reportKey = liveHostPurposeKey(stateRoot, "report-author");
      const cellEvidence = new Map<string, WaveCellEvidence>();
      const dispatches: WaveExecution["dispatches"][number][] = [];
      const verdictEnvelopes = new Map<string, Uint8Array>();
      for (const coordinate of expectedCellSet(initialized.plan.benchmark.record, initialized.plan.run.record)) {
        if (abortRequested(input.signal)) {
          await requestCancellationAndDrain(cancellationRequest({
            transaction, roles, recordedAt: at(), closeAt: initialized.plan.run.record.closeAt,
          }));
          closeCancelledCampaign(transaction, at());
        }
        const taskDigest = `sha256:${coordinate.taskDigest}`;
        const task = tasks.get(taskDigest);
        const arm = initialized.plan.run.record.arms.find((candidate) => candidate.armId === coordinate.armId);
        if (task === undefined || arm === undefined) throw new HostStateError("state-io", "Run coordinate has no exact Task or arm");
        const requirements = arm.pinning as Readonly<Record<string, unknown>>;
        progress(`Solving ${taskDigest.slice(0, 14)} with ${coordinate.armId}`);
        const submission = deterministicSubmission({
          campaign: runPlan.plan.campaignDigest, run: initialized.plan.run.digest,
          cellKey: coordinate.cellKey, armId: coordinate.armId, taskDigest,
          requirements, deadline: initialized.plan.run.record.closeAt,
        });
        const accepted = await submitPreparedDispatch({
          campaign: runPlan.plan.campaignDigest, run: initialized.plan.run.digest,
          cellKey: coordinate.cellKey, armId: coordinate.armId, dispatch: 1,
          dispatchId: `solver/${coordinate.cellKey}`, requester: REQUESTER,
          nonce: submission.nonce, idempotencyKey: submission.idempotencyKey, requirements,
          stateRoot, taskBytes: task.taskBytes, submissionBytes: submission.bytes,
          role: "solver", backend: roles.solver, transaction, recordedAt: at(),
        });
        const solverDrain = await drainOrCancel({
          signal: input.signal,
          drain: () => roles.solver.drain(),
          cancellation: cancellationRequest({
            transaction, roles, recordedAt: at(), closeAt: initialized.plan.run.record.closeAt,
          }),
        });
        if (solverDrain === "cancelled") closeCancelledCampaign(transaction, at());
        const solverSnapshot = await roles.solver.observe(accepted.attempt as never);
        const solverState = attemptTerminalState(solverSnapshot);
        if (solverState !== "delivered") {
          appendTerminalOnce({ transaction, runDigest: initialized.plan.run.digest,
            cellKey: coordinate.cellKey, armId: coordinate.armId, role: "solver",
            attempt: accepted.attempt, state: solverState, evidenceDigest: terminalEvidence(solverSnapshot), at: at() });
          // A terminal solver failure is an honest cell outcome, not a host failure. Keep it in
          // the declared Matrix denominator with no invented Delivery or verdict, then continue
          // so the recommendation can conservatively keep the current policy.
          dispatches.push({
            cellKey: coordinate.cellKey, armId: coordinate.armId,
            replicate: coordinate.replicate, taskDigest: coordinate.taskDigest,
            dispatches: 1, accounted: 1, attempt: accepted.attempt,
            submissionDigest: accepted.submissionDigest as `sha256:${string}`,
            terminal: solverState === "cancelled" ? "cancelled" : "error",
            detail: `solver-${solverState}`,
          });
          continue;
        }
        const solverDelivery = await retrieveExactDeliveries({
          backend: roles.solver, attempt: accepted.attempt, taskDigest, submission: accepted.submission,
        });
        transaction.append({ type: "solver-delivery-recorded", recordedAt: at(), payload: {
          runDigest: initialized.plan.run.digest, cellKey: coordinate.cellKey,
          armId: coordinate.armId, dispatch: 1, attempt: accepted.attempt,
          deliveryDigest: solverDelivery.head.digest,
        } });
        appendTerminalOnce({ transaction, runDigest: initialized.plan.run.digest,
          cellKey: coordinate.cellKey, armId: coordinate.armId, role: "solver",
          attempt: accepted.attempt, state: solverState, evidenceDigest: solverDelivery.head.digest, at: at() });
        const results = await resultDescriptorBytes(roles.solver, solverDelivery.head.record);
        const evaluation = deriveEvaluationDispatch({
          campaign: runPlan.plan.campaignDigest, run: initialized.plan.run.digest,
          cellKey: coordinate.cellKey, armId: coordinate.armId, dispatch: 1,
          requester: REQUESTER, deadline: initialized.plan.run.record.closeAt,
          requirements: evaluationRequirements(), subjectTask: { bytes: task.taskBytes },
          solverDelivery: { bytes: solverDelivery.head.bytes, record: solverDelivery.head.record },
          evaluationSpecDigest: task.evaluationSpecDigest as `sha256:${string}`,
        });
        evaluationMaterials.set(evaluation.taskDigest, {
          subjectTask: task.taskBytes,
          subjectDelivery: solverDelivery.head.bytes,
          results,
          evaluationSpec: task.evaluationSpecBytes,
        });
        if (abortRequested(input.signal)) {
          await requestCancellationAndDrain(cancellationRequest({
            transaction, roles, recordedAt: at(), closeAt: initialized.plan.run.record.closeAt,
          }));
          closeCancelledCampaign(transaction, at());
        }
        progress(`Grading ${taskDigest.slice(0, 14)} with the isolated evaluator`);
        const evaluationAccepted = await dispatchEvaluation({
          stateRoot, derived: evaluation, backend: roles.evaluator, transaction, recordedAt: at(),
        });
        const evaluatorDrain = await drainOrCancel({
          signal: input.signal,
          drain: () => roles.evaluator.drain(),
          cancellation: cancellationRequest({
            transaction, roles, recordedAt: at(), closeAt: initialized.plan.run.record.closeAt,
          }),
        });
        if (evaluatorDrain === "cancelled") closeCancelledCampaign(transaction, at());
        const evaluatorSnapshot = await roles.evaluator.observe(evaluationAccepted.attempt as never);
        const evaluatorState = attemptTerminalState(evaluatorSnapshot);
        if (evaluatorState !== "delivered") {
          appendTerminalOnce({ transaction, runDigest: initialized.plan.run.digest,
            cellKey: coordinate.cellKey, armId: coordinate.armId, role: "evaluator",
            attempt: evaluationAccepted.attempt, state: evaluatorState,
            evidenceDigest: terminalEvidence(evaluatorSnapshot), at: at() });
          // The solver Delivery remains valid evidence. Record the evaluation as could-not-grade
          // so Matrix assembly derives `unscorable` without fabricating an evaluator verdict.
          cellEvidence.set(coordinate.cellKey, {
            deliveryBytes: solverDelivery.head.bytes,
            deliveryDigest: solverDelivery.head.digest as `sha256:${string}`,
            evaluationSpec: task.evaluationSpec,
            evaluationSpecDigest: task.evaluationSpecDigest,
            evaluationTerminal: "could-not-grade",
            verdicts: [],
            pinning: pinningEvidence(requirements),
          });
          dispatches.push({
            cellKey: coordinate.cellKey, armId: coordinate.armId,
            replicate: coordinate.replicate, taskDigest: coordinate.taskDigest,
            dispatches: 1, accounted: 1, attempt: accepted.attempt,
            submissionDigest: accepted.submissionDigest as `sha256:${string}`,
            terminal: "delivered", detail: `evaluator-${evaluatorState}`,
          });
          continue;
        }
        const evaluatorDelivery = await retrieveExactDeliveries({
          backend: roles.evaluator, attempt: evaluationAccepted.attempt,
          taskDigest: evaluation.taskDigest, submission: evaluationAccepted.submission,
        });
        const verdictOutput = evaluatorDelivery.head.record.outputs.find((output) => output.name === "verdict");
        if (verdictOutput === undefined) throw new HostStateError("state-io", "evaluator Delivery has no verdict output");
        const statementBytes = await roles.evaluator.fetchArtifact(verdictOutput);
        const expectedResults = [...results.entries()].map(([name, bytes]) => ({
          name,
          digest: { sha256: prefixedDigest(bytes).slice("sha256:".length) },
        }));
        const signed = await validateAndSignEvaluatorStatement({
          statementBytes,
          expected: {
            task: { name: "subject-task.json", digest: { sha256: taskDigest.slice("sha256:".length) } },
            results: expectedResults,
            evaluatorId: LIVE_EVALUATOR_ID,
            evaluatorSigningKeyId: verdictKey.keyId,
            evaluationSpecification: {
              name: "evaluation-spec.json",
              digest: { sha256: task.evaluationSpecDigest.slice("sha256:".length) },
            },
            evaluationMethod: LOCAL_SWE_REBENCH_EVALUATION_METHOD,
          },
          signer: verdictKey.dsseSigner,
        });
        const verdictDigest = prefixedDigest(signed.envelopeBytes);
        secureAtomicWrite(join(preparedRoot, "run", "verdicts", `${verdictDigest.slice("sha256:".length)}.dsse.json`), signed.envelopeBytes, true);
        verdictEnvelopes.set(verdictDigest, signed.envelopeBytes);
        const evidence = statementEvidence(statementBytes, signed.envelopeBytes, task.evaluationSpec);
        transaction.append({ type: "evaluation-result-recorded", recordedAt: at(), payload: {
          runDigest: initialized.plan.run.digest, cellKey: coordinate.cellKey,
          armId: coordinate.armId, dispatch: 1, attempt: evaluationAccepted.attempt,
          resultDigest: verdictDigest,
          verdict: evidence.record.verdict === "inconclusive" ? "unscorable" : evidence.record.verdict,
        } });
        appendTerminalOnce({ transaction, runDigest: initialized.plan.run.digest,
          cellKey: coordinate.cellKey, armId: coordinate.armId, role: "evaluator",
          attempt: evaluationAccepted.attempt, state: evaluatorState,
          evidenceDigest: evaluatorDelivery.head.digest, at: at() });
        cellEvidence.set(coordinate.cellKey, {
          deliveryBytes: solverDelivery.head.bytes,
          deliveryDigest: solverDelivery.head.digest as `sha256:${string}`,
          evaluationSpec: task.evaluationSpec,
          evaluationSpecDigest: task.evaluationSpecDigest,
          verdicts: [evidence],
          pinning: pinningEvidence(requirements),
        });
        dispatches.push({
          cellKey: coordinate.cellKey, armId: coordinate.armId,
          replicate: coordinate.replicate, taskDigest: coordinate.taskDigest,
          dispatches: 1, accounted: 1, attempt: accepted.attempt,
          submissionDigest: accepted.submissionDigest as `sha256:${string}`, terminal: "delivered",
        });
      }
      const execution: WaveExecution = {
        runDigest: initialized.plan.run.digest,
        events: [], dispatches, cancelled: false,
      };
      const matrix = await assembleWaveMatrix({
        plan: initialized.plan, execution,
        evidence: { evidenceFor: (cellKey) => cellEvidence.get(cellKey) },
        venue: {
          isolationInventory: [runPlan.plan.route.isolationPolicy],
          admissionReceiptFor: () => ({ zeroReplayVariance: false, externalCapabilities: true }),
          trust: {
            async resolveAgent(evidence) {
              const value = object(evidence, "trust evidence");
              return value["role"] === "solver" ? roles.identities.solverDelivery
                : value["role"] === "evaluator" ? roles.identities.evaluatorVerdict : "unresolved";
            },
          },
        },
      });
      const matrixPath = join(preparedRoot, "run", "matrix.json");
      secureAtomicWrite(matrixPath, matrix.bytes, true);
      if (!transaction.state.matrices.has(initialized.plan.run.digest)) {
        transaction.append({ type: "matrix-recorded", recordedAt: at(), payload: {
          runDigest: initialized.plan.run.digest, matrixDigest: matrix.digest,
          // A failed gate is still a resolved gate. Matrix assembly happens only after every
          // dispatch above is terminal and records each fidelity failure explicitly; requiring
          // every gate to pass here would suppress the conservative "keep current" decision.
          gatesResolved: true,
        } });
      }
      const reportBytes: Uint8Array[] = [];
      const reportDigests: string[] = [];
      for (const method of campaign.objective.methods) {
        const report = await produceReport({
          subjects: [matrix.bytes], method: { id: method.id, version: method.version, parameters: method.parameters },
          verdictRule: "sole", author: reportKey.identity,
          resolveVerdictBytes: (requested) => verdictEnvelopes.get(requested),
          resolveRunBytes: (requested) => requested === initialized.plan.run.digest ? initialized.plan.run.bytes : undefined,
          resolveTaskBytes: (requested) => tasks.get(requested)?.taskBytes,
          registry: BENCHMARKING_METHOD_REGISTRY,
          limitations: [SAME_OPERATOR_EVALUATION_LIMITATION],
        }, reportKey.dsseSigner);
        const reportDigest = documentDigest(report.bytes);
        secureAtomicWrite(join(preparedRoot, "run", "reports", `${reportDigest.slice("sha256:".length)}.json`), report.bytes, true);
        secureAtomicWrite(join(preparedRoot, "run", "reports", `${reportDigest.slice("sha256:".length)}.dsse.json`), report.envelope, true);
        reportBytes.push(report.bytes);
        reportDigests.push(reportDigest);
        const prior = transaction.state.reports.get(initialized.plan.run.digest);
        if (!prior?.has(reportDigest)) transaction.append({ type: "report-recorded", recordedAt: at(), payload: {
          runDigest: initialized.plan.run.digest, matrixDigest: matrix.digest, reportDigest,
        } });
      }
      const recommendation = projectRecommendation({
        objectivePreset: campaign.objectivePreset,
        objective: campaign.objective,
        currentTupleDigest: runPlan.plan.policyTuples.current,
        challengerTupleDigest: runPlan.plan.policyTuples.candidate,
        runBytes: initialized.plan.run.bytes,
        matrixBytes: matrix.bytes,
        reportBytes,
      });
      const resultValue: LiveSweRebenchRunResult = {
        status: recommendation.status,
        recommendedTupleDigest: recommendation.recommendedTupleDigest,
        currentTupleDigest: recommendation.currentTupleDigest,
        challengerTupleDigest: recommendation.challengerTupleDigest,
        reasonCodes: recommendation.reasonCodes,
        runDigest: initialized.plan.run.digest,
        matrixDigest: matrix.digest,
        reportDigests,
        resultPath: join(preparedRoot, "run", "recommendation.json"),
      };
      const resultBytes = canonicalJsonBytes(resultValue as unknown as JsonValue);
      secureAtomicWrite(resultValue.resultPath, resultBytes, true);
      if (transaction.state.recommendationDigest === undefined) {
        transaction.append({ type: "recommendation-recorded", recordedAt: at(), payload: {
          promotionRunDigest: initialized.plan.run.digest, matrixDigest: matrix.digest,
          decisionDigest: prefixedDigest(resultBytes),
        } });
      }
      transaction.append({ type: "closed", recordedAt: at(), payload: { reasonCode: "recommendation-produced-no-adoption" } });
      return resultValue;
    } finally {
      await Promise.allSettled([roles.solver.shutdown(), roles.evaluator.shutdown()]);
    }
  });
  return result;
}
