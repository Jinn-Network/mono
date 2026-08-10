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

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
} from "@jinn-network/task-execution-profiles";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import { sha256Hex } from "../workspace/sealed-store.js";
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
    return {
      id: "benchmark-product-unsupported-dir-v1",
      contract: unsupportedProfileProvisionerContract(profileUri),
    };
  };
}
