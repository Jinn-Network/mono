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

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseCellKey } from "@jinn-network/benchmarking-records";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
import {
  harvest as workspaceHarvest,
  STAGED_SEALED_TASK_FILENAME,
  type DeclaredOutputSlot,
  type HarvestResult,
  type ProvisionerContract,
  type WorkspaceKind,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { DsseSigner } from "@jinn-network/trust-core";
import {
  EVALUATION_TASK_PROFILE_URI,
  PREDICTION_FORECAST_PROFILE_URI,
  REPOSITORY_WORK_PROFILE_URI,
} from "@jinn-network/task-execution-profiles";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import type { ResourceDescriptor, TaskSpecification } from "@jinn-network/task-execution-protocol";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  INSPECT_EMBEDDED_EVALUATOR_ID,
  InspectCellSummarySchema,
  INSPECT_NATIVE_LOG_MEDIA_TYPE,
  INSPECT_SUMMARY_MEDIA_TYPE,
  INSPECT_TASK_PROFILE_URI,
} from "../runtime/inspect/artifacts.js";
import type { InspectHostBinding } from "../runtime/inspect/host.js";
import type { InspectSelectionManifest } from "../runtime/inspect/manifest.js";
import type { RepositoryMirrorPort } from "./repository-mirror.js";
import { sealVerdictStatement } from "./signing.js";

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
      // Both solve launchers (prediction-v1-baseline, sample-uniform) write the Task's sole
      // declared output to out/prediction.json and a structured-output envelope alongside it.
      // Neither name is the Task's declared output name ("prediction"), and the structured
      // envelope must not appear in the delivered manifest at all (it is backend/host metadata,
      // never a Task output) -- so both are normalized before the platform's own `harvest()` walks
      // out/. Moving structured-output.json out of out/ before `readResultEnvelope` runs is safe:
      // with the file absent it returns `undefined`, and an exit-0 process still interprets as
      // `delivered` (`@jinn-network/task-execution-launchers`'s `interpretResult`).
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

const execFileAsync = promisify(execFile);
const REPOSITORY_OID_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * Not a reuse of the platform's `makeWorktreeProvisioner`: reaching it would require the product
 * to implement `WorkspaceRuntimePorts` (process-group gating, meta reserve) it has no business
 * owning, and its inherited `makeDirProvisioner.setup` would materialize the `repository-state`
 * descriptor as a junk FILE via `materializeInput`. Same reasoning as `./sample-uniform.ts`'s
 * self-contained planning guards. The checkout constraints below are the platform's, verbatim:
 * 40-hex oid, HEAD equals the requested oid, and the worktree is detached.
 */
async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

interface RepositoryWorkProvisionerOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly mirror: RepositoryMirrorPort | undefined;
}

/** The Task's declared repository descriptor (`repository-work/1.0` inputConventions). */
function repositoryStateDescriptor(task: TaskSpecification): { uri: string; oid: string } {
  const descriptor = (task.inputs ?? []).find(
    (input: ResourceDescriptor) => input.name === "repository-state",
  );
  if (descriptor === undefined) {
    throw new Error(
      'benchmark-product local venue: repository-work Task declares no "repository-state" input',
    );
  }
  const uri = descriptor.uri;
  const oid = (descriptor.annotations as { ref?: unknown } | undefined)?.ref;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error('benchmark-product local venue: "repository-state" input carries no uri');
  }
  if (typeof oid !== "string" || !REPOSITORY_OID_PATTERN.test(oid)) {
    throw new Error(
      'benchmark-product local venue: "repository-state" annotations.ref must be exactly 40 lowercase hex characters',
    );
  }
  return { uri, oid };
}

function repositoryWorkProvisionerContract(
  options: RepositoryWorkProvisionerOptions,
): ProvisionerContract {
  return {
    workspaceKind: (): WorkspaceKind => "worktree",
    async setup(_view, paths) {
      const { uri, oid } = repositoryStateDescriptor(options.task);
      if (options.mirror === undefined) {
        throw new Error(
          "benchmark-product local venue cannot provision a repository-work cell: no repository mirror is configured",
        );
      }
      await ensureWorkspaceDirectories(paths);
      await Promise.all([
        writeFile(join(paths.input, STAGED_SEALED_TASK_FILENAME), options.sealedTaskBytes),
        writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes),
      ]);
      const mirrorDir = await options.mirror.ensure({ uri, oid });
      // git refuses a worktree destination that already exists.
      await rm(paths.work, { recursive: true, force: true });
      await git(["-C", mirrorDir, "worktree", "add", "--detach", paths.work, oid]);
      const actual = await git(["-C", paths.work, "rev-parse", "HEAD"]);
      if (actual !== oid) throw new Error(`worktree resolved ${actual}, expected ${oid}`);
      const branch = await git(["-C", paths.work, "symbolic-ref", "-q", "HEAD"]).catch(() => "");
      if (branch !== "") throw new Error(`worktree is attached to ${branch}`);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      // Same normalization contract as the solve path above, for this profile's declared slots.
      // Renames run BEFORE `workspaceHarvest` because harvest stamps each artifact's mediaType
      // from the declared slot whose name equals its path -- an artifact still called
      // "patch.diff" would be collected untyped.
      const structuredOutputPath = join(paths.out, "structured-output.json");
      if (existsSync(structuredOutputPath)) {
        await rename(structuredOutputPath, join(paths.meta, "structured-output.json"));
      }
      for (const slot of declaredOutputs) {
        for (const suffix of [".diff", ".patch", ".md", ".json", ".txt"]) {
          const candidate = join(paths.out, `${slot.name}${suffix}`);
          if (!existsSync(join(paths.out, slot.name)) && existsSync(candidate)) {
            await rename(candidate, join(paths.out, slot.name));
          }
        }
      }
      const declared = new Set(declaredOutputs.map((slot) => slot.name));
      const result = await workspaceHarvest(paths, declaredOutputs);
      const manifest = result.manifest.filter((entry) => declared.has(entry.path));
      await wipeScratch(paths);
      return { manifest, omissions: result.omissions, integrityViolations: result.integrityViolations };
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
  readonly evaluator: VenueEvaluatorSigner;
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
      const taskSelection = (input.task.payload as { selectionManifestSha256?: unknown } | undefined)?.selectionManifestSha256;
      if (taskSelection !== options.selectionManifestSha256) {
        throw new Error("Inspect Task selection digest does not match the venue's sealed manifest");
      }
      const workerInput = {
        projectDir: options.host.kind === "oci" ? "/jinn/project" : options.host.projectDir,
        outputDir: options.host.kind === "oci" ? "/jinn/output" : paths.out,
        manifest: options.manifest,
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
      const summary = InspectCellSummarySchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(summaryBytes)));
      if (summary.nativeLogSha256 !== sha256Hex(nativeBytes) || summary.nativeLogBytes !== nativeBytes.length) {
        throw new Error("Inspect summary does not bind the exact native EvalLog bytes");
      }
      await rename(nativeSource, join(paths.out, "inspect-log"));
      await rename(summarySource, join(paths.out, "inspect-summary"));

      if (summary.terminal === "scored") {
        if (summary.verdict === null || summary.measurement === null) {
          throw new Error("Inspect scored terminal carries no verdict/measurement");
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
              "jinn.network/scorer": summary.scorer,
            },
          },
          measurements: [{ name: "inspect-score-pass", value: summary.measurement }],
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
          signer: options.evaluator.signer,
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
  /** Resolves a repository-work Task's `repository-state` descriptor to a local bare mirror.
   * Absent on venues that serve no repository-work cells; a repository-work cell then refuses
   * typed at setup rather than silently provisioning an empty work tree. */
  readonly repositoryMirror?: RepositoryMirrorPort;
}

export function createLocalProvisioner(
  options: CreateLocalProvisionerOptions,
): (input: LocalProvisionerInput) => SelectedProvisioner {
  return (input: LocalProvisionerInput): SelectedProvisioner => {
    const profileUri = input.task.profile.uri;
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
        }),
      };
    }
    return {
      id: "benchmark-product-unsupported-dir-v1",
      contract: unsupportedProfileProvisionerContract(profileUri),
    };
  };
}
