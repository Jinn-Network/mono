/**
 * The G1 custom provisioner (spec
 * `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md` §2 G1): the
 * platform's generic `makeDirProvisioner` writes `input/task.sealed`, but the baseline launcher's
 * runner parses only `*.json` files — a mismatch that produces zero native Tasks and exit 2. This
 * module is the product's own `ProvisionerContract` factory, branching on the sealed Task's own
 * profile URI:
 *
 * - solve cells (prediction-forecast) write `input/task.json` = the sealed Task bytes verbatim,
 *   and nothing else parseable as a native Task.
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
      await writeFile(join(paths.input, "task.json"), sealedTaskBytes);
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
  readonly evaluatorId: string;
  readonly signer: DsseSigner;
}

function evaluationProvisionerContract(options: EvaluationProvisionerOptions): ProvisionerContract {
  let materials: EvaluationCellMaterials | undefined;
  return {
    workspaceKind: (): WorkspaceKind => "dir",
    async setup(_view, paths) {
      await ensureWorkspaceDirectories(paths);
      materials = options.registry.get(options.taskSha256);
      if (materials === undefined) {
        throw new Error(
          `benchmark-product local venue has no registered evaluation-cell materials for evaluation `
          + `Task sha256:${options.taskSha256} -- prepareEvaluationCell() must be called, and its `
          + "returned taskBytes submitted, before this evaluation Task is dispatched",
        );
      }
      await Promise.all([
        writeFile(join(paths.input, "task.sealed"), options.sealedTaskBytes),
        writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes),
        writeFile(join(paths.input, "subject-task.json"), materials.subjectTaskBytes),
        writeFile(join(paths.input, "subject-delivery.json"), materials.subjectDeliveryBytes),
        ...materials.resultArtifacts.map((artifact) => writeFile(join(paths.input, artifact.name), artifact.bytes)),
        writeFile(join(paths.input, "evaluation-spec.json"), materials.evaluationSpecBytes),
        writeFile(join(paths.input, "evaluation-context.json"), materials.evaluationContextBytes),
      ]);
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
      if (materials === undefined) {
        throw new Error("benchmark-product local venue harvest ran before setup registered evaluation-cell materials");
      }
      const verdictPath = join(paths.out, "verdict");
      const statementBytes = new Uint8Array(await readFile(verdictPath));
      const envelopeBytes = await sealVerdictStatement({
        statementBytes,
        evaluatorId: options.evaluatorId,
        expectedEvaluationSpecificationSha256: sha256Hex(materials.evaluationSpecBytes),
        signer: options.signer,
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
  readonly evaluatorId: string;
  readonly signer: DsseSigner;
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
          evaluatorId: options.evaluatorId,
          signer: options.signer,
        }),
      };
    }
    return {
      id: "benchmark-product-unsupported-dir-v1",
      contract: unsupportedProfileProvisionerContract(profileUri),
    };
  };
}
