/**
 * The G1 custom provisioner (spec
 * `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md` §2 G1): the
 * platform's generic `makeDirProvisioner` and launchers share one canonical sealed-Task filename.
 * This module is the product's own `ProvisionerContract` factory, branching on the sealed Task's
 * own profile URI while preserving that shared staging contract:
 *
 * - solve cells (prediction-forecast) write the sealed Task bytes verbatim to the platform's
 *   `STAGED_SEALED_TASK_FILENAME`, and nothing else parseable as a native Task.
 * - evaluation cells (evaluation-task) write the full evaluation-harness input set from the
 *   materials `../venue.ts`'s `prepareEvaluationCell` registered ahead of submission.
 *
 * Harvest normalizes each cell's `out/` tree to the exact declared output the downstream
 * evaluation harness (or, for evaluation cells, the report leg) expects — see the per-cell harvest
 * functions below for the exact manifest shape each produces.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseCellKey } from "@jinn-network/benchmarking-records";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
import {
  harvest as workspaceHarvest,
  makeWorktreeProvisioner,
  canonicalLoadoutPath,
  canonicalLoadoutPin,
  ProvisioningRejectedError,
  STAGED_SEALED_TASK_FILENAME,
  type DeclaredOutputSlot,
  type HarvestResult,
  type ProvisionerContract,
  type WorkspaceKind,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import { canonicalJsonBytes, recordDigest, type DsseSigner } from "@jinn-network/trust-core";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_PROFILE_URI,
  BinaryJudgmentObservationSchema,
  EVALUATION_TASK_PROFILE_URI,
  PREDICTION_FORECAST_PROFILE_URI,
  REPOSITORY_WORK_PROFILE_URI,
} from "@jinn-network/task-execution-profiles";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import type { ResourceDescriptor, TaskSpecification } from "@jinn-network/task-execution-protocol";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { artifactsDir } from "../workspace/layout.js";
import {
  INSPECT_EMBEDDED_EVALUATOR_ID,
  InspectCellSummarySchema,
  projectInspectCellVerdict,
  INSPECT_NATIVE_LOG_MEDIA_TYPE,
  INSPECT_SUMMARY_MEDIA_TYPE,
  INSPECT_TASK_PROFILE_URI,
} from "../runtime/inspect/artifacts.js";
import type { InspectHostBinding } from "../runtime/inspect/host.js";
import { resolveHarborMaterial, type HarborHostBinding } from "../runtime/harbor/host.js";
import { InspectSelectionManifestSchema, type InspectSelectionManifest } from "../runtime/inspect/manifest.js";
import type { InspectAsSpecifiedSelectionManifest } from "../runtime/inspect-as-specified/manifest.js";
import { overlayInspectAsSpecifiedCell } from "../runtime/inspect-as-specified/overlay.js";
import {
  INSPECT_BINARY_JUDGE_CONFIG_FILENAME,
  INSPECT_BINARY_JUDGE_INSTRUMENT_FILENAME,
  INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
  INSPECT_BINARY_JUDGE_OUTPUT_FILES,
  INSPECT_BINARY_JUDGE_SELECTION_FILENAME,
  buildInspectBinaryJudgeWorkerInput,
  type InspectBinaryJudgeWorkerInput,
} from "../runtime/inspect/binary-judge.js";
import type {
  InspectBinaryJudgeHostBinding,
  InspectBinaryJudgeSelectionManifest,
} from "../runtime/inspect/binary-judge-manifest.js";
import { assertHarborTrialMatchesCell, assertSingleHarborTrial, HarborJobConfigSchema, harborFollowUpJobSource, harborJobSource, harborSelectedTaskNames, harborTrialTaskName, normalizeHarborSavedJobConfig, type HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { harborArmFollowUpJobName, harborArmJobName, harborJobName, harborPlannedJobWaitMs, harborPredictionFromVerifierReward } from "../runtime/harbor/launcher.js";
import {
  claimHarborArmJobLeadership,
  harborArmJobsDir,
  harborArmMappingIdentity,
  observeHarborArmTrials,
  waitForHarborArmReplacementGrain,
  type HarborArmWait,
} from "../runtime/harbor/arm-job.js";
import { harborDispatchMappingPath, readHarborDispatchMapping, recordHarborDispatchMapping } from "../runtime/harbor/dispatch-mapping.js";
import {
  harborLiveTrialDirectory,
  harborRetrySnapshotDir,
  harborTrialExceptionType,
  HARBOR_RETRY_EXCLUDED_EXCEPTIONS,
  writeHarborRetryUnscorableMarker,
} from "../runtime/harbor/retry-bind.js";
import {
  HARBOR_ARTIFACT_MANIFEST_ROLE,
  HARBOR_ATIF_ROLE,
  HARBOR_COLLECTED_ARTIFACTS_ROLE,
  HARBOR_CTRF_ROLE,
  HARBOR_JOB_CONFIG_ROLE,
  HARBOR_INVOCATION_CONFIG_ROLE,
  HARBOR_JOB_RESULT_ROLE,
  HARBOR_LOGS_ROLE,
  HARBOR_REWARD_ROLE,
  HARBOR_TRIAL_CONFIG_ROLE,
  HARBOR_TRIAL_RESULT_ROLE,
} from "../runtime/harbor/venue.js";
import type { RepositoryMirrorPort } from "./repository-mirror.js";
import { sealVerdictStatement } from "./signing.js";
import {
  DEMO1_CLAUDE_HARNESS_ID,
  DEMO1_CLAUDE_MD_LOADOUT_NAME,
  DEMO1_CLAUDE_MD_PATH,
  DEMO1_EXPERIMENT_PATHS,
  DEMO1_SKILL_LOADOUT_NAME,
  DEMO1_SKILL_PATH,
  DEMO1_SKILL_PLUGIN_DIRECTORY,
  DEMO1_SKILL_PLUGIN_MANIFEST_PATH,
  type Demo1InstructionArtifacts,
} from "./demo1-claude.js";

/**
 * Structurally matches `@jinn-network/task-execution-backend-local`'s own `SelectedProvisioner`
 * (`backend.ts`'s `LocalTaskExecutionBackendConfig.provisioner` return type), which that package
 * does not re-export from its public index — redeclared here rather than imported, same as
 * `../intake/sample.ts`'s `SampleDsseSigner` mirrors `@jinn-network/trust-core`'s `DsseSigner`.
 */
export interface SelectedProvisioner {
  readonly id: string;
  readonly contract: ProvisionerContract;
}

/**
 * The Submission requirement key naming which venue evaluator identity an evaluation attempt runs
 * under (BP-21). Defined here rather than in `./venue.ts` because both modules need it and
 * `./venue.ts` already imports from this module — `./venue.ts` re-exports it as the public home.
 */
export const EVALUATOR_REQUIREMENT_KEY = "jinn.benchmark-product/evaluator";

/**
 * One venue evaluator identity paired with its own DSSE signer.
 *
 * HONESTY (product design spec §6): distinct evaluator identities and keys prove
 * AGENT-DISTINCTNESS only — the same operator runs every one of them on a self-run venue. Nothing
 * here is third-party or party-independent verification.
 */
export interface VenueEvaluatorSigner {
  readonly id: string;
  readonly signer: DsseSigner;
}

export interface EvaluationCellMaterials {
  readonly subjectTaskBytes: Uint8Array;
  readonly subjectDeliveryBytes: Uint8Array;
  readonly resultArtifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly evaluationSpecBytes: Uint8Array;
  readonly evaluationContextBytes: Uint8Array;
}

export interface EvaluationCellRegistry {
  /** Keyed by the derived evaluation Task's bare-hex sha256 digest. */
  register(taskSha256: string, materials: EvaluationCellMaterials): void;
  get(taskSha256: string): EvaluationCellMaterials | undefined;
}

export function createEvaluationCellRegistry(): EvaluationCellRegistry {
  const store = new Map<string, EvaluationCellMaterials>();
  return {
    register(taskSha256, materials) {
      store.set(taskSha256, materials);
    },
    get(taskSha256) {
      return store.get(taskSha256);
    },
  };
}

async function wipeScratch(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    rm(paths.secrets, { recursive: true, force: true }),
    rm(paths.tmp, { recursive: true, force: true }),
  ]);
}

async function ensureWorkspaceDirectories(paths: WorkspacePaths): Promise<void> {
  await Promise.all(
    [paths.root, paths.input, paths.work, paths.out, paths.logs, paths.harnessState, paths.tmp, paths.meta]
      .map((path) => mkdir(path, { recursive: true })),
  );
  await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
}

// ── solve cells (prediction-forecast) ────────────────────────────────────────────────────────

function solveProvisionerContract(sealedTaskBytes: Uint8Array): ProvisionerContract {
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(_view, paths) {
      await ensureWorkspaceDirectories(paths);
      await writeFile(join(paths.input, STAGED_SEALED_TASK_FILENAME), sealedTaskBytes);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      // This venue's own `sample-uniform` launcher writes the Task's sole declared output to
      // out/prediction.json and a structured-output envelope alongside it. Neither name is the
      // Task's declared output name ("prediction"), and the structured envelope must not appear in
      // the delivered manifest at all (it is backend/host metadata, never a Task output) -- so both
      // are normalized before the platform's own `harvest()` walks out/. Moving
      // structured-output.json out of out/ before `readResultEnvelope` runs is safe: with the file
      // absent it returns `undefined`, and an exit-0 process still interprets as `delivered`
      // (`@jinn-network/task-execution-launchers`'s `interpretResult`).
      //
      // `prediction-v1-baseline` no longer needs the rename: since #39 it writes out/prediction
      // directly, which is what every consumer of a signed Delivery already expected. Both guards
      // below are existence-checked, so that launcher simply falls through them.
      const structuredOutputPath = join(paths.out, "structured-output.json");
      if (existsSync(structuredOutputPath)) {
        await rename(structuredOutputPath, join(paths.meta, "structured-output.json"));
      }
      const predictionJsonPath = join(paths.out, "prediction.json");
      if (existsSync(predictionJsonPath)) {
        await rename(predictionJsonPath, join(paths.out, "prediction"));
      }
      const result = await workspaceHarvest(paths, declaredOutputs);
      const manifest = result.manifest
        .filter((entry) => entry.path === "prediction")
        .map((entry) => ({ ...entry, mediaType: "application/json" }));
      await wipeScratch(paths);
      return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
    },
  };
}

// ── evaluation cells (evaluation-task) ───────────────────────────────────────────────────────

interface EvaluationProvisionerOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly taskSha256: string;
  readonly registry: EvaluationCellRegistry;
  /** The raw `EVALUATOR_REQUIREMENT_KEY` value from the dispatching Submission's requirements. */
  readonly requestedEvaluator: unknown;
  readonly evaluators: readonly VenueEvaluatorSigner[];
  readonly contextVariation?: (evaluatorId: string, contextBytes: Uint8Array) => Uint8Array;
}

function evaluationProvisionerContract(options: EvaluationProvisionerOptions): ProvisionerContract {
  let materials: EvaluationCellMaterials | undefined;
  let evaluator: VenueEvaluatorSigner | undefined;
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(_view, paths) {
      // Resolve the attempt's evaluator BEFORE anything is written: a missing or unknown
      // evaluator requirement is a caller bug, never silently defaulted (BP-21).
      const requested = options.requestedEvaluator;
      if (typeof requested !== "string") {
        throw new Error(
          `benchmark-product local venue evaluation Submission carries no "${EVALUATOR_REQUIREMENT_KEY}" `
          + "requirement -- every evaluation attempt must name the venue evaluator identity it runs under",
        );
      }
      evaluator = options.evaluators.find((candidate) => candidate.id === requested);
      if (evaluator === undefined) {
        throw new Error(
          `benchmark-product local venue evaluation Submission names unknown evaluator "${requested}" -- `
          + `known evaluator identities: ${options.evaluators.map((candidate) => candidate.id).join(", ")}`,
        );
      }
      await ensureWorkspaceDirectories(paths);
      materials = options.registry.get(options.taskSha256);
      if (materials === undefined) {
        throw new Error(
          `benchmark-product local venue has no registered evaluation-cell materials for evaluation `
          + `Task sha256:${options.taskSha256} -- prepareEvaluationCell() must be called, and its `
          + "returned taskBytes submitted, before this evaluation Task is dispatched",
        );
      }
      const evaluationContextBytes = options.contextVariation === undefined
        ? materials.evaluationContextBytes
        : options.contextVariation(evaluator.id, materials.evaluationContextBytes);
      await Promise.all([
        writeFile(join(paths.input, "task.sealed"), options.sealedTaskBytes),
        writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes),
        writeFile(join(paths.input, "subject-task.json"), materials.subjectTaskBytes),
        writeFile(join(paths.input, "subject-delivery.json"), materials.subjectDeliveryBytes),
        ...materials.resultArtifacts.map((artifact) => writeFile(join(paths.input, artifact.name), artifact.bytes)),
        writeFile(join(paths.input, "evaluation-spec.json"), materials.evaluationSpecBytes),
        writeFile(join(paths.input, "evaluation-context.json"), evaluationContextBytes),
      ]);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      if (materials === undefined || evaluator === undefined) {
        throw new Error("benchmark-product local venue harvest ran before setup registered evaluation-cell materials");
      }
      const verdictPath = join(paths.out, "verdict");
      // #39b(b): the same unconditional read the daemon's evaluator provisioner carried. A harness
      // that refused its subject exits 65 having written no verdict, and that exit code already
      // classifies the failure; letting the read's ENOENT escape harvest replaces that
      // classification with an infrastructure blame. Nothing to seal means nothing to seal.
      if (!existsSync(verdictPath)) return workspaceHarvest(paths, declaredOutputs);
      const statementBytes = new Uint8Array(await readFile(verdictPath));
      const envelopeBytes = await sealVerdictStatement({
        statementBytes,
        evaluatorId: evaluator.id,
        expectedEvaluationSpecificationSha256: sha256Hex(materials.evaluationSpecBytes),
        signer: evaluator.signer,
      });
      const temporary = `${verdictPath}.sealed`;
      await writeFile(temporary, envelopeBytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, verdictPath);

      const result = await workspaceHarvest(paths, declaredOutputs);
      const manifest = result.manifest
        .filter((entry) => entry.path === "verdict")
        .map((entry) => ({ ...entry, mediaType: "application/vnd.in-toto+json" }));
      await wipeScratch(paths);
      return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
    },
  };
}

// ── repository-work cells ────────────────────────────────────────────────────────────────────

const REPOSITORY_OID_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * Per-slot suffixes an agent's stray `out/` write is renamed FROM before harvest, so the declared
 * slot name is what harvest actually sees. Deliberately narrow and keyed per slot rather than
 * tried against every declared slot: a Task declaring "patch" should only pick up a stray
 * `patch.diff`/`patch.patch`, never let e.g. a log written to `out/patch.txt` get delivered as the
 * patch. Unknown slot names get no rename at all.
 */
const OUTPUT_SLOT_RENAME_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  patch: [".diff", ".patch"],
  summary: [".md"],
  evidence: [".json"],
};

/**
 * Runs `git <args>` for its exit code only -- worktree teardown needs no stdout. Mirrors
 * `packages/policy-optimization/src/host-local/live-swe-rebench-runner.ts`'s `processExit` shape;
 * redeclared here (rather than imported) because this package must not depend on
 * `packages/policy-optimization/`.
 */
async function runGit(args: readonly string[]): Promise<void> {
  const child = spawn("git", [...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: "ignore",
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 70));
  });
  if (code !== 0) throw new Error(`git ${args[0] ?? ""} exited ${code}`);
}

async function runGitOutput(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn("git", [...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 70));
  });
  if (code !== 0) throw new Error(`git ${args[0] ?? ""} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

interface RepositoryWorkProvisionerOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly mirror: RepositoryMirrorPort | undefined;
  readonly demo1Instructions?: Demo1InstructionArtifacts;
}

function harnessId(view: { readonly effectiveRequirements?: Readonly<Record<string, unknown>> }): string | undefined {
  const harness = view.effectiveRequirements?.["harness"];
  if (typeof harness === "string") return harness;
  if (typeof harness !== "object" || harness === null) return undefined;
  const id = (harness as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function installDemo1Instructions(
  view: { readonly effectiveRequirements?: Readonly<Record<string, unknown>> },
  paths: WorkspacePaths,
  artifacts: Demo1InstructionArtifacts,
): Promise<void> {
  for (const path of DEMO1_EXPERIMENT_PATHS) {
    if (existsSync(join(paths.work, path))) {
      throw new ProvisioningRejectedError(
        `Demo-1 task repository already contains experiment instruction path "${path}"`,
      );
    }
  }
  const rawLoadout = view.effectiveRequirements?.["loadout"];
  if (rawLoadout === undefined) return;
  const pin = canonicalLoadoutPin(rawLoadout);
  const expected = pin.name === DEMO1_SKILL_LOADOUT_NAME
    ? artifacts.skill
    : pin.name === DEMO1_CLAUDE_MD_LOADOUT_NAME
      ? artifacts.baseline
      : undefined;
  if (expected === undefined || canonicalLoadoutPin(expected).digest !== pin.digest) {
    throw new ProvisioningRejectedError(`Demo-1 refuses unregistered loadout "${pin.name}"`);
  }

  // makeWorktreeProvisioner has already sent these bytes through materializeLoadout's digest
  // verification at input/<pin.name>. Copying is product-owned placement, and the second hash
  // check makes the loader-visible bytes identical to the verified staging bytes.
  const stagedBytes = new Uint8Array(await readFile(canonicalLoadoutPath(paths.input, rawLoadout)));
  if (digest(stagedBytes) !== pin.digest) {
    throw new ProvisioningRejectedError(`Demo-1 staged loadout "${pin.name}" changed before placement`);
  }
  const destination = pin.name === DEMO1_SKILL_LOADOUT_NAME
    ? join(paths.work, DEMO1_SKILL_PATH)
    : join(paths.work, DEMO1_CLAUDE_MD_PATH);
  await mkdir(dirname(destination), { recursive: true });
  if (pin.name === DEMO1_SKILL_LOADOUT_NAME) {
    const manifest = new TextEncoder().encode('{"name":"jinn-demo1-skill","version":"1.0.0"}\n');
    const manifestPath = join(paths.work, DEMO1_SKILL_PLUGIN_MANIFEST_PATH);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifest, { mode: 0o400, flag: "wx" });
  }
  await writeFile(destination, stagedBytes, { mode: 0o400, flag: "wx" });
  if (digest(new Uint8Array(await readFile(destination))) !== pin.digest) {
    throw new ProvisioningRejectedError(`Demo-1 loader-visible loadout "${pin.name}" failed its copy check`);
  }
}

async function removeDemo1Instructions(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    rm(join(paths.work, DEMO1_SKILL_PLUGIN_DIRECTORY), { recursive: true, force: true }),
    rm(join(paths.work, DEMO1_CLAUDE_MD_PATH), { force: true }),
  ]);
}

/** Extracts repository changes without touching the real index. */
async function extractRepositoryPatch(paths: WorkspacePaths, excludeDemo1Instructions: boolean): Promise<void> {
  const indexPath = join(paths.meta, "demo1-patch.index");
  await rm(indexPath, { force: true });
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_INDEX_FILE: indexPath,
  };
  await runGitOutput(["-C", paths.work, "read-tree", "HEAD"], env);
  await runGitOutput([
    "-C", paths.work, "add", "-A", "--", ".",
    ...(excludeDemo1Instructions
      ? [
        `:(exclude)${DEMO1_CLAUDE_MD_PATH}`,
        `:(exclude)${DEMO1_SKILL_PLUGIN_DIRECTORY}`,
        `:(exclude)${DEMO1_SKILL_PLUGIN_DIRECTORY}/**`,
      ]
      : []),
  ], env);
  const patch = await runGitOutput([
    "-C", paths.work, "diff", "--cached", "--binary", "--full-index", "--no-color", "HEAD", "--",
  ], env);
  await writeFile(join(paths.out, "patch"), patch, { mode: 0o600 });
  await rm(indexPath, { force: true });
}

/**
 * The Task's declared repository descriptor (`repository-work/1.0` inputConventions). Product
 * logic, not platform logic -- the platform's `ResourceDescriptor` carries no repository-specific
 * shape, so extracting and validating the `uri` + `annotations.ref` convention this profile
 * defines stays here even though the checkout itself now delegates to the platform below.
 */
function repositoryStateDescriptor(task: TaskSpecification): { uri: string; oid: string } {
  const descriptor = (task.inputs ?? []).find(
    (input: ResourceDescriptor) => input.name === "repository-state",
  );
  if (descriptor === undefined) {
    throw new ProvisioningRejectedError(
      'benchmark-product local venue: repository-work Task declares no "repository-state" input',
    );
  }
  const uri = descriptor.uri;
  const oid = (descriptor.annotations as { ref?: unknown } | undefined)?.ref;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new ProvisioningRejectedError('benchmark-product local venue: "repository-state" input carries no uri');
  }
  if (typeof oid !== "string" || !REPOSITORY_OID_PATTERN.test(oid)) {
    throw new ProvisioningRejectedError(
      'benchmark-product local venue: "repository-state" annotations.ref must be exactly 40 lowercase hex characters',
    );
  }
  return { uri, oid };
}

/**
 * Delegates the checkout itself to the platform's `makeWorktreeProvisioner` (design-approved;
 * see `packages/policy-optimization/src/host-local/live-swe-rebench-runner.ts`'s
 * `solverProvisioner` for the shape this mirrors). `referenceRepository` is only known after
 * `mirror.ensure(...)` resolves, so unlike that model the base provisioner is built INSIDE
 * `setup`, once the mirror path is in hand, and retained in this closure for `harvest`'s teardown.
 */
function repositoryWorkProvisionerContract(
  options: RepositoryWorkProvisionerOptions,
): ProvisionerContract {
  let resolved: { readonly base: ProvisionerContract; readonly mirrorDir: string } | undefined;
  let demo1Claude = false;
  let repositoryEditingHarness = false;
  return {
    workspaceKind: (): WorkspaceKind => "worktree",
    async setup(view, paths, grants) {
      const { uri, oid } = repositoryStateDescriptor(options.task);
      if (options.mirror === undefined) {
        throw new ProvisioningRejectedError(
          "benchmark-product local venue cannot provision a repository-work cell: no repository mirror is configured",
        );
      }
      let mirrorDir: string;
      try {
        mirrorDir = await options.mirror.ensure({ uri, oid });
      } catch (error) {
        throw new ProvisioningRejectedError(
          error instanceof Error ? error.message : "repository mirror resolution failed",
          error,
        );
      }
      const base = makeWorktreeProvisioner({
        sealedTaskBytes: options.sealedTaskBytes,
        dispatchContextBytes: options.dispatchContextBytes,
        referenceRepository: mirrorDir,
        oid,
        runtime: { assertHarnessGroupEmpty: () => undefined, ensureMetaReserve: () => undefined },
        fetchInput: async (descriptor) => {
          // The Task's "repository-state" input has no bytes of its own to materialize verbatim
          // -- it is a pointer to the mirror-resolved checkout. The checkout itself lands at
          // paths.work via the worktree the platform cuts below; this canonical JSON pointer is
          // what lands under input/ for the descriptor.
          if (descriptor.name === "repository-state") {
            return canonicalJsonBytes({ oid, repository: mirrorDir });
          }
          throw new Error(
            `benchmark-product local venue repository-work provisioner refused unknown input "${descriptor.name ?? descriptor.uri ?? "<unnamed>"}"`,
          );
        },
      });
      await base.setup(view, paths, grants);
      try {
        // A normal profile-backed Claude Code arm shares the same public harness id as Demo-1.
        // The frozen instruction inventory is the product-owned discriminator: venue.ts refuses
        // configuring a Demo-1 runtime and a general Claude profile together, so its presence
        // means this is the experiment-specific launcher/provisioner pair. Without it, preserve
        // the ordinary repository-work path and never demand or remove Demo-1 artifacts.
        const demo1Instructions = options.demo1Instructions;
        const selectedHarness = harnessId(view);
        repositoryEditingHarness = selectedHarness === "claude-code" || selectedHarness === "codex";
        demo1Claude = demo1Instructions !== undefined
          && selectedHarness === DEMO1_CLAUDE_HARNESS_ID;
        if (demo1Claude && demo1Instructions !== undefined) {
          await installDemo1Instructions(view, paths, demo1Instructions);
        }
      } catch (error) {
        // A product placement refusal happens after the platform has cut the worktree. Clean up
        // that partial setup immediately; the backend correctly has no harvest phase for a
        // never-executed attempt.
        await runGit(["-C", mirrorDir, "worktree", "remove", "--force", paths.work])
          .catch(() => rm(paths.work, { recursive: true, force: true }));
        await runGit(["-C", mirrorDir, "worktree", "prune"]).catch(() => undefined);
        throw error;
      }
      resolved = { base, mirrorDir };
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      if (resolved === undefined) {
        throw new Error("benchmark-product local venue repository-work harvest ran before setup");
      }
      const { base, mirrorDir } = resolved;
      try {
        if (demo1Claude) {
          await removeDemo1Instructions(paths);
          await extractRepositoryPatch(paths, true);
        } else if (repositoryEditingHarness && !existsSync(join(paths.out, "patch"))) {
          // Claude Code and Codex express their result by editing the checked-out repository.
          // Turn those exact bytes into the profile's required patch output before the generic
          // harvester runs. A launcher-supplied patch remains authoritative when one exists.
          await extractRepositoryPatch(paths, false);
        }
        // Same normalization contract as the solve path above, for this profile's declared slots.
        // Renames run BEFORE the delegated harvest because harvest stamps each artifact's
        // mediaType from the declared slot whose name equals its path -- an artifact still called
        // "patch.diff" would be collected untyped.
        const structuredOutputPath = join(paths.out, "structured-output.json");
        if (existsSync(structuredOutputPath)) {
          await rename(structuredOutputPath, join(paths.meta, "structured-output.json"));
        }
        for (const slot of declaredOutputs) {
          for (const suffix of OUTPUT_SLOT_RENAME_SUFFIXES[slot.name] ?? []) {
            const candidate = join(paths.out, `${slot.name}${suffix}`);
            if (!existsSync(join(paths.out, slot.name)) && existsSync(candidate)) {
              await rename(candidate, join(paths.out, slot.name));
            }
          }
        }
        const declared = new Set(declaredOutputs.map((slot) => slot.name));
        const result = await base.harvest(paths, declaredOutputs);
        const manifest = result.manifest.filter((entry) => declared.has(entry.path));
        return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
      } finally {
        // Copies `solverProvisioner`'s teardown in the model referenced above, verbatim in shape:
        // deregister the worktree, falling back to a forced directory removal, then prune.
        await runGit(["-C", mirrorDir, "worktree", "remove", "--force", paths.work])
          .catch(() => rm(paths.work, { recursive: true, force: true }));
        await runGit(["-C", mirrorDir, "worktree", "prune"]).catch(() => undefined);
      }
    },
  };
}

// ── unsupported profiles (defensive; venue.ts's resolveTaskProfile already refuses these
// earlier in the submit pipeline, so this contract is expected to be unreachable) ─────────────

function unsupportedProfileProvisionerContract(profileUri: string | undefined): ProvisionerContract {
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup() {
      throw new Error(`benchmark-product local venue has no provisioner for task profile "${profileUri}"`);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs) {
      return workspaceHarvest(paths, declaredOutputs);
    },
  };
}

export interface InspectProvisionerOptions {
  readonly selectionManifestSha256: string;
  readonly manifest: InspectSelectionManifest;
  readonly host: InspectHostBinding;
  readonly asSpecified?: InspectAsSpecifiedSelectionManifest;
  /** Present only for the exact embedded direct-check strategy. */
  readonly embeddedEvaluator?: VenueEvaluatorSigner;
}

export interface InspectBinaryJudgeProvisionerOptions {
  readonly workspaceDir: string;
  readonly selectionManifestSha256: string;
  readonly manifest: InspectBinaryJudgeSelectionManifest;
  readonly host: InspectBinaryJudgeHostBinding;
}

export interface HarborProvisionerOptions {
  readonly workspaceDir: string;
  readonly selectionManifestSha256: string;
  readonly manifest: HarborSelectionManifest;
  readonly host: HarborHostBinding;
  readonly taskNameByDigest?: Readonly<Record<string, string>>;
}

function harborRole(relativePath: string): string {
  if (relativePath === "invocation/harbor-job.json") return HARBOR_INVOCATION_CONFIG_ROLE;
  if (relativePath === "config.json") return HARBOR_JOB_CONFIG_ROLE;
  if (relativePath === "result.json") return HARBOR_JOB_RESULT_ROLE;
  if (/^[^/]+\/config\.json$/u.test(relativePath)) return HARBOR_TRIAL_CONFIG_ROLE;
  if (/^[^/]+\/result\.json$/u.test(relativePath)) return HARBOR_TRIAL_RESULT_ROLE;
  if (/^[^/]+\/agent\/recording\.cast$/u.test(relativePath) || /trajectory|atif/iu.test(relativePath)) return HARBOR_ATIF_ROLE;
  if (/^[^/]+\/verifier\/reward\.(txt|json)$/u.test(relativePath)) return HARBOR_REWARD_ROLE;
  if (/(^|\/)ctrf\.json$/iu.test(relativePath)) return HARBOR_CTRF_ROLE;
  if (/^[^/]+\/(test\/)?(stdout|stderr)/iu.test(relativePath)) return HARBOR_LOGS_ROLE;
  if (/artifacts\/manifest/i.test(relativePath)) return HARBOR_ARTIFACT_MANIFEST_ROLE;
  if (/artifacts\//i.test(relativePath)) return HARBOR_COLLECTED_ARTIFACTS_ROLE;
  // Harbor keeps extending its result layout; preserve every unknown native file rather than discard it.
  return `https://harborframework.com/artifact-roles/native-path/${encodeURIComponent(relativePath)}/v1`;
}

/** Internal lifecycle index primitive, re-exported for concurrency conformance tests. */
export { recordHarborDispatchMapping } from "../runtime/harbor/dispatch-mapping.js";

async function harborFiles(root: string, current = ""): Promise<{ readonly files: readonly string[]; readonly failures: readonly { path: string; reason: string }[] }> {
  const directory = join(root, current);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (cause) { return { files: [], failures: [{ path: current || ".", reason: cause instanceof Error ? cause.message : String(cause) }] }; }
  const values: string[] = [];
  const failures: { path: string; reason: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = current === "" ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await harborFiles(root, relative);
      values.push(...nested.files); failures.push(...nested.failures);
    }
    else if (entry.isFile()) values.push(relative);
    else failures.push({ path: relative, reason: entry.isSymbolicLink() ? "symlink refused during Harbor evidence collection" : "non-regular Harbor artifact refused" });
  }
  return { files: values, failures };
}

function harborTaskNameForCell(
  manifest: HarborSelectionManifest,
  taskDigest: string,
  taskNameByDigest: Readonly<Record<string, string>> | undefined,
  trialConfig: Readonly<Record<string, unknown>>,
): string {
  const fromDigest = taskNameByDigest?.[taskDigest];
  if (typeof fromDigest === "string" && fromDigest.length > 0) return fromDigest;
  const names = harborSelectedTaskNames(manifest.source);
  if (names.length === 1) return names[0]!;
  return harborTrialTaskName(trialConfig);
}

async function resolveHarborTrialDirectory(input: {
  readonly jobRoot: string;
  readonly trialConfigs: readonly string[];
  readonly grain: "per-dispatch" | "per-arm";
  readonly cellKey: string;
  readonly manifest: HarborSelectionManifest;
  readonly taskNameByDigest?: Readonly<Record<string, string>>;
  readonly mappedTrialId?: string;
}): Promise<string> {
  if (input.grain === "per-dispatch") {
    if (input.trialConfigs.length !== 1) throw new Error(`Harbor Job must contain exactly one Trial; found ${input.trialConfigs.length}`);
    return input.trialConfigs[0]!.split("/")[0]!;
  }
  if (input.mappedTrialId !== undefined && input.mappedTrialId.length > 0) {
    const mappedDir = harborLiveTrialDirectory(input.mappedTrialId);
    const mapped = input.trialConfigs.filter((path) => path.split("/")[0] === mappedDir);
    if (mapped.length !== 1) throw new Error(`Harbor Job must contain exactly one Trial for this cell; found ${mapped.length}`);
    return mappedDir;
  }
  const coord = parseCellKey(input.cellKey);
  const matched: string[] = [];
  for (const path of input.trialConfigs) {
    const dir = path.split("/")[0]!;
    const trialConfig = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(input.jobRoot, dir, "config.json")))) as Record<string, unknown>;
    const attempt = typeof trialConfig.attempt_number === "number" ? trialConfig.attempt_number
      : typeof trialConfig.attempt === "number" ? trialConfig.attempt
      : undefined;
    if (attempt === undefined) continue;
    const name = harborTaskNameForCell(input.manifest, coord.taskDigest, input.taskNameByDigest, trialConfig);
    if (attempt === coord.replicate && harborTrialTaskName(trialConfig) === name) matched.push(dir);
  }
  if (matched.length !== 1) throw new Error(`Harbor Job must contain exactly one Trial for this cell; found ${matched.length}`);
  return matched[0]!;
}

function harborProvisionerContract(input: LocalProvisionerInput, options: HarborProvisionerOptions): ProvisionerContract {
  let jobName: string;
  let submissionSha256: string;
  let dispatch: number;
  let cellKey: string;
  let runSha256: string;
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(_view, paths) {
      await ensureWorkspaceDirectories(paths);
      submissionSha256 = sha256Hex(canonicalJsonBytes(input.submission as never));
      const nonceParts = input.submission.nonce.split(":");
      dispatch = Number(nonceParts.at(-1));
      cellKey = typeof input.submission.annotations?.cellKey === "string" ? input.submission.annotations.cellKey : nonceParts.at(-2) ?? "unknown-cell";
      const runReference = input.submission.annotations?.run;
      runSha256 = typeof runReference === "string" && runReference.startsWith("sha256:") ? runReference.slice("sha256:".length) : "";
      if (!/^[a-f0-9]{64}$/u.test(runSha256) || !Number.isInteger(dispatch) || dispatch < 1) throw new Error("Harbor requires contemporaneous Run/cell/dispatch lineage");
      const armId = parseCellKey(cellKey).armId;
      const arm = options.manifest.arms.find((candidate) => candidate.armId === armId);
      if (arm === undefined) throw new Error(`Harbor selection has no exact AgentConfig mapping for arm ${armId}`);
      const declared = input.task.outputs.map((output) => ({ name: output.name, mediaType: output.mediaType }));
      const mapped = options.manifest.outputs.map((output) => ({ name: output.name, mediaType: output.mediaType }));
      if (!Buffer.from(canonicalJsonBytes(declared as never)).equals(Buffer.from(canonicalJsonBytes(mapped as never)))) throw new Error("Harbor selection must map every declared Task output exactly before execution");
      const currentMaterial = resolveHarborMaterial({ input: options.manifest.source.input, materialPath: options.host.sourceMaterialPath, revision: options.manifest.source.resolved.revision });
      if (!Buffer.from(canonicalJsonBytes(currentMaterial as never)).equals(Buffer.from(canonicalJsonBytes(options.manifest.source.resolved as never)))) throw new Error("Harbor source material drifted from the sealed selection");
      const stagedMaterial = join(paths.work, options.manifest.source.jobInput.path);
      await mkdir(dirname(stagedMaterial), { recursive: true });
      await cp(options.host.sourceMaterialPath, stagedMaterial, { recursive: true, errorOnExist: true, force: false });
      const grain = options.manifest.jobGrain ?? "per-dispatch";
      const jobsDir = grain === "per-arm" ? harborArmJobsDir(options.workspaceDir, runSha256) : join(paths.out, "harbor-jobs");
      const plannedJobName = grain === "per-arm" ? harborArmJobName(runSha256, armId) : harborJobName(submissionSha256, dispatch);
      const mappingIdentity = grain === "per-arm"
        ? harborArmMappingIdentity({
          selectionManifestSha256: options.selectionManifestSha256,
          runSha256,
          cellKey,
          dispatch,
        })
        : undefined;
      const mappingPath = mappingIdentity === undefined ? "" : harborDispatchMappingPath(options.workspaceDir, mappingIdentity);
      const snapshotDir = grain === "per-arm" ? harborRetrySnapshotDir(options.workspaceDir, runSha256, cellKey, dispatch) : "";
      let followUp = false;
      if (grain === "per-arm" && dispatch > 1) {
        followUp = (await waitForHarborArmReplacementGrain({
          plannedRoot: join(jobsDir, plannedJobName),
          mappingPath,
          timeoutMs: harborPlannedJobWaitMs(options.manifest.retryPolicy.nAttempts),
        })) === "follow-up";
      }
      jobName = followUp
        ? harborArmFollowUpJobName(runSha256, armId, submissionSha256, dispatch)
        : plannedJobName;
      const taskName = harborTaskNameForCell(options.manifest, parseCellKey(cellKey).taskDigest, options.taskNameByDigest, {});
      const config = HarborJobConfigSchema.parse({
        job_name: jobName,
        jobs_dir: jobsDir,
        n_attempts: grain === "per-arm" && !followUp ? options.manifest.retryPolicy.nAttempts : 1,
        n_concurrent_trials: grain === "per-arm" && !followUp ? options.manifest.retryPolicy.nConcurrent : 1,
        retry: { max_retries: grain === "per-arm" && !followUp ? options.manifest.retryPolicy.maxRetries : 0 },
        environment: { type: options.manifest.environment.type, ...options.manifest.environment.configuration },
        agents: [{ ...arm.jobAgent, ...(arm.jobAgent.kwargs === undefined ? {} : { kwargs: arm.jobAgent.kwargs }) }],
        artifacts: options.manifest.outputs.map((output) => output.artifact),
        ...(followUp ? harborFollowUpJobSource(options.manifest, taskName) : harborJobSource(options.manifest)),
      });
      await Promise.all([
        writeFile(join(paths.input, "task.sealed"), input.sealedTaskBytes),
        writeFile(join(paths.input, "harbor-job.json"), canonicalJsonBytes(config as never), { mode: 0o600 }),
      ]);
      if (grain === "per-arm") {
        const inJobRetry = dispatch > 1 && !followUp;
        const leader = inJobRetry ? false : await claimHarborArmJobLeadership(jobsDir, jobName);
        await writeFile(join(paths.meta, "harbor-arm-role"), leader ? "leader\n" : "follower\n", { mode: 0o600 });
        const wait: HarborArmWait = {
          kind: followUp ? "follow-up" : inJobRetry ? "in-job-retry" : "planned",
          jobRoot: join(jobsDir, followUp ? jobName : plannedJobName),
          mappingPath,
          snapshotRetryPath: join(snapshotDir, "retry.json"),
          startedMarkerPath: join(jobsDir, `${plannedJobName}.started`),
        };
        await writeFile(join(paths.meta, "harbor-arm-wait.json"), JSON.stringify(wait), { mode: 0o600 });
        if (leader && !followUp && !inJobRetry) {
          void observeHarborArmTrials({
            workspaceDir: options.workspaceDir,
            selectionManifestSha256: options.selectionManifestSha256,
            runSha256,
            armId,
            jobName,
            jobRoot: join(jobsDir, jobName),
            fallbackTaskDigest: parseCellKey(cellKey).taskDigest,
            taskNameByDigest: options.taskNameByDigest,
            timeoutMs: harborPlannedJobWaitMs(options.manifest.retryPolicy.nAttempts),
          }).catch((cause) => {
            const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
            void writeFile(join(jobsDir, `${jobName}.observer-error`), detail).catch(() => undefined);
          });
        }
      }
    },
    executionEnv: ({ env }) => ({ ...env, HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" }),
    async harvest(paths, declaredOutputs) {
      const native: { role: string; path: string; sha256: string; bytes: number; availability: "public" | "collection-failed"; reason?: string }[] = [];
      const grain = options.manifest.jobGrain ?? "per-dispatch";
      const plannedJobName = grain === "per-arm" ? harborArmJobName(runSha256, parseCellKey(cellKey).armId) : jobName;
      const followUp = grain === "per-arm" && dispatch > 1 && jobName !== plannedJobName;
      const harvestGrain = followUp ? "per-dispatch" : grain;
      const jobsDir = grain === "per-arm" ? harborArmJobsDir(options.workspaceDir, runSha256) : join(paths.out, "harbor-jobs");
      const jobRoot = join(jobsDir, jobName);
      const snapshotDir = grain === "per-arm" ? harborRetrySnapshotDir(options.workspaceDir, runSha256, cellKey, dispatch) : "";
      const useSnapshot = snapshotDir.length > 0 && existsSync(join(snapshotDir, "retry.json"));
      const harvestRoot = useSnapshot ? snapshotDir : jobRoot;
      let jobId: string | undefined;
      let trialId: string | undefined;
      let status: "completed" | "failed" | "cancelled" | "collection-failed" = "completed";
      let collectionError: string | undefined;
      let files: string[] = [];
      const archiveFile = async (relative: string, sourceRoot: string): Promise<void> => {
        try {
          const bytes = new Uint8Array(await readFile(join(sourceRoot, relative)));
          native.push({ role: harborRole(relative), path: relative, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "public" });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          collectionError ??= reason;
          const bytes = new TextEncoder().encode(reason);
          native.push({ role: harborRole(relative), path: relative, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "collection-failed", reason });
        }
      };
      try {
        const collected = await harborFiles(harvestRoot);
        files = [...collected.files];
        for (const failure of collected.failures) {
          collectionError ??= failure.reason;
          const bytes = new TextEncoder().encode(failure.reason);
          native.push({ role: harborRole(failure.path), path: failure.path, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "collection-failed", reason: failure.reason });
        }
      } catch (cause) { collectionError = cause instanceof Error ? cause.message : String(cause); }
      // Archive every safe regular native file before interpreting the directory. Interpretation
      // failures therefore cannot erase partial Harbor evidence.
      for (const relative of files) await archiveFile(relative, harvestRoot);
      if (!files.includes("config.json") && existsSync(join(jobRoot, "config.json"))) {
        files.push("config.json");
        await archiveFile("config.json", jobRoot);
      }
      if (!files.includes("result.json") && existsSync(join(jobRoot, "result.json"))) {
        files.push("result.json");
        await archiveFile("result.json", jobRoot);
      }
      try {
        if (collectionError !== undefined) throw new Error(collectionError);
        if (grain === "per-arm" && !followUp && !useSnapshot) {
          const nextMapped = readHarborDispatchMapping(
            options.workspaceDir,
            harborArmMappingIdentity({
              selectionManifestSha256: options.selectionManifestSha256,
              runSha256,
              cellKey,
              dispatch: dispatch + 1,
            }),
          );
          if (nextMapped !== undefined) {
            throw new Error("Harbor retry wiped this dispatch's trial before snapshot");
          }
        }
        const mappingIdentity = grain === "per-arm"
          ? harborArmMappingIdentity({
            selectionManifestSha256: options.selectionManifestSha256,
            runSha256,
            cellKey,
            dispatch,
          })
          : `${options.selectionManifestSha256}:${runSha256}:${cellKey}:${dispatch}:${submissionSha256}`;
        const existingMapping = grain === "per-arm" ? readHarborDispatchMapping(options.workspaceDir, mappingIdentity) : undefined;
        const trialConfigs = files.filter((path) => /^[^/]+\/config\.json$/u.test(path) && files.includes(`${path.slice(0, -"config.json".length)}result.json`));
        const trialDirectory = await resolveHarborTrialDirectory({
          jobRoot: harvestRoot, trialConfigs, grain: harvestGrain, cellKey, manifest: options.manifest, taskNameByDigest: options.taskNameByDigest,
          mappedTrialId: harvestGrain === "per-arm" ? existingMapping?.trialId : undefined,
        });
        if (harvestGrain === "per-arm") {
          const keep = (path: string): boolean => !path.includes("/") || path.startsWith(`${trialDirectory}/`);
          for (let index = native.length - 1; index >= 0; index -= 1) {
            if (!keep(native[index]!.path)) native.splice(index, 1);
          }
        }
        const savedJobConfig = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(jobRoot, "config.json")))) as unknown;
        const submittedJobConfig = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(paths.input, "harbor-job.json")))) as unknown;
        const jobConfig = normalizeHarborSavedJobConfig(savedJobConfig, submittedJobConfig);
        const trialConfig = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(harvestRoot, trialDirectory, "config.json")))) as Record<string, unknown>;
        const jobResult = existsSync(join(jobRoot, "result.json"))
          ? JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(jobRoot, "result.json")))) as Record<string, unknown>
          : undefined;
        const trialResult = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(harvestRoot, trialDirectory, "result.json")))) as Record<string, unknown>;
        if (harvestGrain === "per-arm") {
          const coord = parseCellKey(cellKey);
          assertHarborTrialMatchesCell(jobConfig, trialConfig, jobResult, {
            taskName: harborTaskNameForCell(options.manifest, coord.taskDigest, options.taskNameByDigest, trialConfig),
            attempt: coord.replicate,
          });
        } else if (jobResult !== undefined) {
          assertSingleHarborTrial(jobConfig, trialConfig, jobResult);
        } else {
          throw new Error("Harbor follow-up or per-dispatch harvest requires Job result.json");
        }
        jobId = typeof jobResult?.id === "string" ? jobResult.id : typeof jobResult?.job_id === "string" ? jobResult.job_id : jobName;
        trialId = existingMapping?.trialId
          ?? (harvestGrain === "per-arm" ? `${trialDirectory}.g${dispatch}` : typeof trialResult.id === "string" ? trialResult.id : typeof trialResult.trial_id === "string" ? trialResult.trial_id : trialDirectory);
        const mappingJobId = grain === "per-arm" ? jobName : jobId;
        await recordHarborDispatchMapping(options.workspaceDir, mappingIdentity, mappingJobId, trialId);
        const excluded = harborTrialExceptionType(trialResult);
        if (useSnapshot || (excluded !== undefined && HARBOR_RETRY_EXCLUDED_EXCEPTIONS.has(excluded))) {
          await writeHarborRetryUnscorableMarker(options.workspaceDir, input.attempt.attemptUri, {
            cellKey,
            dispatch,
            ...(excluded === undefined ? {} : { exceptionType: excluded }),
            ...(useSnapshot ? { snapshot: true } : {}),
          });
        }
        for (const output of declaredOutputs) {
          const mapping = options.manifest.outputs.find((candidate) => candidate.name === output.name && candidate.mediaType === output.mediaType);
          if (mapping === undefined) throw new Error(`Harbor selection has no exact native mapping for declared output ${output.name}`);
          const source = join(harvestRoot, trialDirectory, mapping.nativePath);
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await readFile(source));
          } catch (cause) {
            const rewardPath = join(harvestRoot, trialDirectory, "verifier", "reward.txt");
            if (!existsSync(rewardPath)) throw cause;
            const rewardText = new TextDecoder("utf8").decode(await readFile(rewardPath));
            const submittedAt = typeof trialResult.finished_at === "string" ? trialResult.finished_at : new Date().toISOString();
            bytes = harborPredictionFromVerifierReward(rewardText, submittedAt);
          }
          await writeFile(join(paths.out, output.name), bytes, { flag: "wx", mode: 0o600 });
        }
      } catch (cause) {
        status = "collection-failed";
        collectionError = cause instanceof Error ? cause.message : String(cause);
        if (grain === "per-arm" && !followUp && !existsSync(join(jobRoot, harborLiveTrialDirectory(trialId ?? ""))) && existsSync(join(jobsDir, plannedJobName))) {
          await writeHarborRetryUnscorableMarker(options.workspaceDir, input.attempt.attemptUri, { cellKey, dispatch, collectionFailed: true });
        }
      }
      for (const [relative, source] of [
        ["invocation/harbor-job.json", join(paths.input, "harbor-job.json")],
        ["invocation/stdout.log", join(paths.logs, "harness.stdout.log")],
        ["invocation/stderr.log", join(paths.logs, "harness.stderr.log")],
        ["invocation/outcome.json", join(paths.meta, "outcome.json")],
      ] as const) {
          try {
            const bytes = new Uint8Array(await readFile(source));
            native.push({ role: relative.includes("stdout") || relative.includes("stderr") ? HARBOR_LOGS_ROLE : harborRole(relative), path: relative, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "public" });
          } catch {
            const reason = `Harbor invocation evidence was not collected: ${relative}`;
            collectionError ??= reason;
            const bytes = new TextEncoder().encode(reason);
            native.push({ role: relative.includes("stdout") || relative.includes("stderr") ? HARBOR_LOGS_ROLE : harborRole(relative), path: relative, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "collection-failed", reason });
          }
      }
      try {
        const outcome = JSON.parse(await readFile(join(paths.meta, "outcome.json"), "utf8")) as { exitCode?: unknown; termSignal?: unknown };
        if (typeof outcome.termSignal === "string") status = "cancelled";
        else if (typeof outcome.exitCode === "number" && outcome.exitCode !== 0) status = "failed";
      } catch { /* the archive's native invocation entry records absence */ }
      const required = [HARBOR_INVOCATION_CONFIG_ROLE, HARBOR_JOB_CONFIG_ROLE, HARBOR_TRIAL_CONFIG_ROLE, HARBOR_TRIAL_RESULT_ROLE, HARBOR_REWARD_ROLE];
      if (harvestGrain === "per-dispatch" || native.some((entry) => entry.role === HARBOR_JOB_RESULT_ROLE && entry.availability === "public")) {
        required.push(HARBOR_JOB_RESULT_ROLE);
      }
      for (const role of required) if (!native.some((entry) => entry.role === role)) {
        const reason = `expected Harbor evidence role was not collected: ${role}`;
        const bytes = new TextEncoder().encode(reason);
        native.push({ role, path: `missing/${sha256Hex(new TextEncoder().encode(role))}.txt`, sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "collection-failed", reason });
      }
      if (collectionError !== undefined) {
        const bytes = canonicalJsonBytes({ schema: "jinn.network/benchmark-product/harbor-collection-status/1", detail: collectionError } as never);
        native.push({ role: harborRole("collection-status.json"), path: "collection-status.json", sha256: putSealedBytes(options.workspaceDir, bytes), bytes: bytes.length, availability: "collection-failed", reason: collectionError });
      }
      const archive = canonicalJsonBytes({
        schema: "jinn.network/benchmark-product/harbor-dispatch-archive/2", selectionManifestSha256: options.selectionManifestSha256,
        lineage: { runSha256, cellKey, dispatchIndex: dispatch, submissionSha256, attemptUri: input.attempt.attemptUri },
        harbor: { jobName, ...(jobId === undefined ? {} : { jobId }), ...(trialId === undefined ? {} : { trialId }), status },
        nativeArtifacts: native,
      } as never);
      const archiveSha256 = putSealedBytes(options.workspaceDir, archive);
      const archiveIndexPath = join(artifactsDir(options.workspaceDir), "harbor", "archives", "by-dispatch", `${sha256Hex(new TextEncoder().encode(`${runSha256}:${cellKey}:${dispatch}`))}.json`);
      await mkdir(dirname(archiveIndexPath), { recursive: true });
      const archiveIndex = canonicalJsonBytes({ schema: "jinn.network/benchmark-product/harbor-archive-index/1", runSha256, cellKey, dispatchIndex: dispatch, submissionSha256, attemptUri: input.attempt.attemptUri, archiveSha256 } as never);
      try { await writeFile(archiveIndexPath, archiveIndex, { flag: "wx", mode: 0o600 }); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || !Buffer.from(await readFile(archiveIndexPath)).equals(Buffer.from(archiveIndex))) throw cause;
      }
      await writeFile(join(paths.out, "harbor-archive"), archive, { mode: 0o600 });
      if (collectionError !== undefined) throw new Error(collectionError);
      const result = await workspaceHarvest(paths, declaredOutputs);
      return { ...result, manifest: result.manifest.filter((entry) => entry.path === "harbor-archive" || declaredOutputs.some((slot) => slot.name === entry.path)).map((entry) => entry.path === "harbor-archive" ? { ...entry, mediaType: "application/json" } : entry) };
    },
  };
}

function inspectProvisionerContract(
  input: LocalProvisionerInput,
  options: InspectProvisionerOptions,
): ProvisionerContract {
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(_view, paths) {
      await ensureWorkspaceDirectories(paths);
      const nonceParts = input.submission.nonce.split(":");
      const cellKey = nonceParts.at(-2);
      if (cellKey === undefined) throw new Error("Inspect Submission nonce carries no cell key");
      const coordinate = parseCellKey(cellKey);
      const arm = options.manifest.arms.find((candidate) => candidate.armId === coordinate.armId);
      if (arm === undefined) throw new Error(`Inspect selection carries no configuration for arm ${coordinate.armId}`);
      const payload = input.task.payload as { selectionManifestSha256?: unknown; sampleId?: unknown } | undefined;
      let cellManifest = options.manifest;
      if (options.asSpecified !== undefined) {
        if (typeof payload?.sampleId !== "string" && typeof payload?.sampleId !== "number") {
          throw new Error("Inspect-as-specified Task payload must carry the cell sampleId");
        }
        cellManifest = overlayInspectAsSpecifiedCell(options.asSpecified, payload.sampleId);
      } else if (payload?.selectionManifestSha256 !== options.selectionManifestSha256) {
        throw new Error("Inspect Task selection digest does not match the venue's sealed manifest");
      }
      const workerInput = {
        projectDir: options.host.kind === "oci" ? "/jinn/project" : options.host.projectDir,
        outputDir: options.host.kind === "oci" ? "/jinn/output" : paths.out,
        manifest: cellManifest,
        arm,
        selectionManifestSha256: options.selectionManifestSha256,
        cellKey,
        repetition: coordinate.replicate,
      };
      await Promise.all([
        writeFile(join(paths.input, "task.sealed"), input.sealedTaskBytes),
        writeFile(join(paths.input, "inspect-run.json"), JSON.stringify(workerInput), { mode: 0o600 }),
      ]);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      const nativeSource = join(paths.out, "inspect.eval");
      const summarySource = join(paths.out, "inspect-summary.json");
      const nativeBytes = new Uint8Array(await readFile(nativeSource));
      const summaryBytes = new Uint8Array(await readFile(summarySource));
      const observedSummary = InspectCellSummarySchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(summaryBytes)));
      const workerInput = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(paths.input, "inspect-run.json")))) as { manifest?: unknown };
      const scoringManifest = InspectSelectionManifestSchema.parse(workerInput.manifest);
      const summary = observedSummary.schema === "jinn.network/benchmark-product/inspect-cell-summary/2"
        ? {
          ...observedSummary,
          verdict: projectInspectCellVerdict(observedSummary, scoringManifest),
        }
        : observedSummary;
      if (observedSummary.schema === "jinn.network/benchmark-product/inspect-cell-summary/2") {
        await writeFile(summarySource, canonicalJsonBytes(summary));
      }
      if (summary.nativeLogSha256 !== sha256Hex(nativeBytes) || summary.nativeLogBytes !== nativeBytes.length) {
        throw new Error("Inspect summary does not bind the exact native EvalLog bytes");
      }
      await rename(nativeSource, join(paths.out, "inspect-log"));
      await rename(summarySource, join(paths.out, "inspect-summary"));

      if (summary.terminal === "scored" && options.embeddedEvaluator !== undefined) {
        if (summary.verdict === null) throw new Error("Inspect scored terminal carries no verdict");
        let measurements: Array<{ readonly name: string; readonly value: boolean }>;
        if (summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/1") {
          if (summary.measurement === null) throw new Error("Inspect scored terminal carries no measurement");
          measurements = [{ name: "inspect-score-pass", value: summary.measurement }];
        } else {
          measurements = summary.measurements.map((measurement) => {
            if (measurement.value === null) throw new Error("Inspect scored terminal carries no projected measurement");
            return { name: measurement.measurementName, value: measurement.value };
          });
        }
        const taskSha256 = sha256Hex(input.sealedTaskBytes);
        const evaluationSpecSha256 = input.task.evaluation?.digest?.sha256;
        if (evaluationSpecSha256 === undefined) throw new Error("Inspect Task carries no EvaluationSpec digest");
        const unsigned = buildResultEvaluationPayload({
          task: { name: "inspect-task.json", digest: `sha256:${taskSha256}` },
          results: [{
            name: "inspect.eval",
            digest: `sha256:${summary.nativeLogSha256}`,
            mediaType: INSPECT_NATIVE_LOG_MEDIA_TYPE,
            annotations: { "jinn.network/native-runtime": "inspect" },
          }],
          evaluator: {
            id: INSPECT_EMBEDDED_EVALUATOR_ID,
            extensions: { "jinn.network/relationship": "same-execution-scorer" },
          },
          evaluatedAt: summary.evaluatedAt,
          verdict: summary.verdict,
          evaluationSpecification: {
            name: "inspect-score-evaluation-spec.json",
            digest: `sha256:${evaluationSpecSha256}`,
          },
          evaluationMethod: {
            name: "inspect-ai-native-scorer",
            digest: `sha256:${options.manifest.runtime.workerSha256}`,
            annotations: {
              "jinn.network/inspect-version": options.manifest.runtime.inspectVersion,
              ...(summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/1"
                ? { "jinn.network/scorer": summary.scorer }
                : { "jinn.network/scorers": summary.scorers.map((scorer) => scorer.name) }),
            },
          },
          measurements,
          evidence: [{
            name: "inspect.eval",
            digest: `sha256:${summary.nativeLogSha256}`,
            mediaType: INSPECT_NATIVE_LOG_MEDIA_TYPE,
          }],
          explanation: "Projected from the configured scorer in the same Inspect execution; this is not independent evaluation.",
          limitations: ["same-execution-scorer", "self-run-operator-custody"],
        });
        const envelope = await sealVerdictStatement({
          statementBytes: unsigned,
          evaluatorId: INSPECT_EMBEDDED_EVALUATOR_ID,
          expectedEvaluationSpecificationSha256: evaluationSpecSha256,
          signer: options.embeddedEvaluator.signer,
        });
        await writeFile(join(paths.out, "verdict"), envelope, { mode: 0o600, flag: "wx" });
      }

      const result = await workspaceHarvest(paths, declaredOutputs);
      const allowedMediaTypes: Record<string, string> = {
        "inspect-log": INSPECT_NATIVE_LOG_MEDIA_TYPE,
        "inspect-summary": INSPECT_SUMMARY_MEDIA_TYPE,
        verdict: "application/vnd.in-toto+json",
      };
      const manifest = result.manifest
        .filter((entry) => Object.hasOwn(allowedMediaTypes, entry.path))
        .map((entry) => ({ ...entry, mediaType: allowedMediaTypes[entry.path]! }));
      await wipeScratch(paths);
      return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
    },
  };
}

function inspectBinaryJudgeProvisionerContract(
  input: LocalProvisionerInput,
  options: InspectBinaryJudgeProvisionerOptions,
): ProvisionerContract {
  let expected: InspectBinaryJudgeWorkerInput | undefined;
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(view, paths) {
      await ensureWorkspaceDirectories(paths);
      const nonceParts = input.submission.nonce.split(":");
      const annotatedCellKey = input.submission.annotations?.cellKey;
      const cellKey = typeof annotatedCellKey === "string" ? annotatedCellKey : nonceParts.at(-2);
      if (cellKey === undefined) throw new Error("binary-judgment Submission carries no cell key");
      const coordinate = parseCellKey(cellKey);
      const requirement = (view.effectiveRequirements as Record<string, unknown>)[
        BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY
      ];
      if (typeof requirement !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(requirement)) {
        throw new Error("binary-judgment Submission carries no exact instrument requirement");
      }
      const instrumentBytes = getSealedBytes(
        options.workspaceDir,
        requirement.slice("sha256:".length),
      );
      expected = buildInspectBinaryJudgeWorkerInput({
        view,
        sealedTaskBytes: input.sealedTaskBytes,
        manifest: options.manifest,
        selectionManifestSha256: options.selectionManifestSha256,
        instrumentBytes,
        cellKey,
        armId: coordinate.armId,
        replicate: coordinate.replicate,
        outputDir: INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
      });
      await Promise.all([
        writeFile(join(paths.input, STAGED_SEALED_TASK_FILENAME), input.sealedTaskBytes, { mode: 0o400 }),
        writeFile(join(paths.input, INSPECT_BINARY_JUDGE_INSTRUMENT_FILENAME), instrumentBytes, { mode: 0o400 }),
        writeFile(
          join(paths.input, INSPECT_BINARY_JUDGE_SELECTION_FILENAME),
          canonicalJsonBytes(options.manifest),
          { mode: 0o400 },
        ),
        writeFile(
          join(paths.input, INSPECT_BINARY_JUDGE_CONFIG_FILENAME),
          canonicalJsonBytes(expected as never),
          { mode: 0o400 },
        ),
      ]);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs): Promise<HarvestResult> {
      if (expected === undefined) {
        throw new Error("Inspect binary-judge harvest ran before exact input staging");
      }
      const responseBytes = new Uint8Array(await readFile(
        join(paths.out, INSPECT_BINARY_JUDGE_OUTPUT_FILES.response),
      ));
      const observationBytes = new Uint8Array(await readFile(
        join(paths.out, INSPECT_BINARY_JUDGE_OUTPUT_FILES.observation),
      ));
      const observation = BinaryJudgmentObservationSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(observationBytes),
      ));
      if (!Buffer.from(observationBytes).equals(Buffer.from(canonicalJsonBytes(observation)))) {
        throw new Error("binary-judgment observation is not canonical JSON");
      }
      if (
        observation.taskDigest !== expected.taskDigest
        || observation.armId !== expected.armId
        || observation.replicate !== expected.replicate
        || observation.instrumentSha256 !== expected.instrumentSha256
        || observation.requestSha256 !== expected.requestSha256
        || observation.response.digest !== recordDigest(responseBytes)
      ) {
        throw new Error("binary-judgment outputs differ from the exact staged cell binding");
      }
      const result = await workspaceHarvest(paths, declaredOutputs);
      const allowed = new Set<string>(Object.values(INSPECT_BINARY_JUDGE_OUTPUT_FILES));
      const manifest = result.manifest.filter((entry) => allowed.has(entry.path));
      await wipeScratch(paths);
      return {
        manifest,
        omissions: result.omissions,
        integrityViolations: result.integrityViolations,
      };
    },
  };
}

// ── selector ──────────────────────────────────────────────────────────────────────────────────

export interface CreateLocalProvisionerOptions {
  readonly registry: EvaluationCellRegistry;
  /** Ordered venue evaluator identities, each with its own signing key (see `VenueEvaluatorSigner`
   * for the honesty posture). The dispatching Submission's `EVALUATOR_REQUIREMENT_KEY` requirement
   * selects exactly one of these per evaluation attempt. */
  readonly evaluators: readonly VenueEvaluatorSigner[];
  /**
   * TEST-ONLY hook: rewrites the registered `input/evaluation-context.json` bytes per selected
   * evaluator. It exists solely so tests can manufacture a controlled evaluator disagreement;
   * production callers never set it.
   */
  readonly evaluationContextVariationForTesting?: (evaluatorId: string, contextBytes: Uint8Array) => Uint8Array;
  readonly inspect?: InspectProvisionerOptions;
  readonly inspectBinaryJudge?: InspectBinaryJudgeProvisionerOptions;
  readonly harbor?: HarborProvisionerOptions;
  /** Resolves a repository-work Task's `repository-state` descriptor to a local bare mirror.
   * Absent on venues that serve no repository-work cells; a repository-work cell then refuses
   * typed at setup rather than silently provisioning an empty work tree. */
  readonly repositoryMirror?: RepositoryMirrorPort;
  /** Demo-1's exact digest-bound skill/CLAUDE.md inventory. Absent keeps the venue unchanged. */
  readonly demo1Instructions?: Demo1InstructionArtifacts;
}

export function createLocalProvisioner(
  options: CreateLocalProvisionerOptions,
): (input: LocalProvisionerInput) => SelectedProvisioner {
  return (input: LocalProvisionerInput): SelectedProvisioner => {
    const profileUri = input.task.profile.uri;
    if (
      profileUri === BINARY_JUDGMENT_PROFILE_URI
      && options.inspectBinaryJudge !== undefined
    ) {
      return {
        id: "benchmark-product-inspect-binary-judge-dir-v1",
        contract: inspectBinaryJudgeProvisionerContract(input, options.inspectBinaryJudge),
      };
    }
    if ((input.submission.requirements?.harness as { id?: unknown } | undefined)?.id === "harbor" && options.harbor !== undefined) {
      return { id: "benchmark-product-harbor-dir-v1", contract: harborProvisionerContract(input, options.harbor) };
    }
    if (profileUri === PREDICTION_FORECAST_PROFILE_URI) {
      return {
        id: "benchmark-product-solve-dir-v1",
        contract: solveProvisionerContract(input.sealedTaskBytes),
      };
    }
    if (profileUri === EVALUATION_TASK_PROFILE_URI) {
      return {
        id: "benchmark-product-evaluation-dir-v1",
        contract: evaluationProvisionerContract({
          sealedTaskBytes: input.sealedTaskBytes,
          dispatchContextBytes: input.dispatchContextBytes,
          taskSha256: sha256Hex(input.sealedTaskBytes),
          registry: options.registry,
          requestedEvaluator: input.submission.requirements?.[EVALUATOR_REQUIREMENT_KEY],
          evaluators: options.evaluators,
          ...(options.evaluationContextVariationForTesting === undefined
            ? {}
            : { contextVariation: options.evaluationContextVariationForTesting }),
        }),
      };
    }
    if (profileUri === INSPECT_TASK_PROFILE_URI && options.inspect !== undefined) {
      return {
        id: "benchmark-product-inspect-dir-v1",
        contract: inspectProvisionerContract(input, options.inspect),
      };
    }
    if (profileUri === REPOSITORY_WORK_PROFILE_URI) {
      return {
        id: "benchmark-product-repository-work-worktree-v1",
        contract: repositoryWorkProvisionerContract({
          sealedTaskBytes: input.sealedTaskBytes,
          dispatchContextBytes: input.dispatchContextBytes,
          task: input.task,
          mirror: options.repositoryMirror,
          ...(options.demo1Instructions === undefined
            ? {}
            : { demo1Instructions: options.demo1Instructions }),
        }),
      };
    }
    return {
      id: "benchmark-product-unsupported-dir-v1",
      contract: unsupportedProfileProvisionerContract(profileUri),
    };
  };
}
