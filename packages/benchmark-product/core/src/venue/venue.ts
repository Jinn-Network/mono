/**
 * The product's local-venue host (BP-12: the official run path on the real local execution
 * backend). Composes the real `@jinn-network/task-execution-backend-local` backend with:
 *
 * - the platform's `prediction-v1-baseline` launcher, plus the product-bundled `sample-uniform`
 *   launcher (`./sample-uniform.ts`), both real subprocess-spawning arms for prediction-forecast
 *   solve cells (M1 dossier §3 decision 1);
 * - the platform's evaluation-harness launcher, configured with the prediction evaluator adapter
 *   (`@jinn-network/task-execution-evaluator-adapters`);
 * - a product-owned provisioner (`./provisioner.ts`, G1) that writes the right input shape for
 *   each cell kind and normalizes each cell's harvested output manifest;
 * - a product-held Ed25519 verdict-signing key (`./signing.ts`, G2) that DSSE-wraps the
 *   evaluation harness's unsigned Result Evaluation Statement.
 *
 * `resolveTaskProfile` is required because the bundled sample Tasks pin an older, now-drifted
 * profile digest (`e61dc765…`) than what `sealTaskProfile(buildPredictionForecastProfile())`
 * produces today (`sha256:7e451784…`) — a `ProfileStore` alone cannot resolve them, since
 * `resolveProfile` re-seals and compares. The backend's `resolveTaskProfile` config escape hatch
 * fully replaces `resolveProfile` for every descriptor (`backend.ts`'s `private profile(task)`:
 * `this.config.resolveTaskProfile?.(task.profile) ?? resolveProfile(...)`), so this module handles
 * both profile URIs the venue serves and refuses everything else.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type ProvisionerCapabilities,
} from "@jinn-network/task-execution-backend-local";
import { predictionV1BaselineLauncher, type LauncherContract, type LaunchPlan } from "@jinn-network/task-execution-launchers";
import {
  buildEvaluationTaskProfile,
  buildPredictionForecastProfile,
  deriveEvaluationTask,
  EVALUATION_TASK_PROFILE_URI,
  PREDICTION_FORECAST_PROFILE_URI,
  sealTaskProfile,
  type ProfileStore,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import type { TaskSpecification } from "@jinn-network/task-execution-protocol";
import { makeEvaluationLauncher } from "@jinn-network/task-execution-evaluation-harness/launcher";
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorRegistration,
} from "@jinn-network/task-execution-evaluator-adapters";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { refuse } from "../errors.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  createEvaluationCellRegistry,
  createLocalProvisioner,
  type EvaluationCellMaterials,
} from "./provisioner.js";
import { deriveSampleResolution, isSampleForecastPayload } from "./resolution.js";
import { makeSampleUniformLauncher, SAMPLE_UNIFORM_HARNESS_VERSION, SAMPLE_UNIFORM_LAUNCHER_ID } from "./sample-uniform.js";
import { createVerdictDsseSigner, loadOrCreateVerdictSigningKey } from "./signing.js";

export interface LocalVenueOptions {
  readonly workspaceDir: string;
  readonly now: () => string;
}

export interface EvaluationCellInput {
  readonly subjectTaskBytes: Uint8Array;
  readonly subjectDeliveryBytes: Uint8Array;
  readonly resultArtifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly evaluationSpecBytes: Uint8Array;
}

export interface PreparedEvaluationCell {
  readonly taskBytes: Uint8Array;
  /** Bare hex sha256 digest of `taskBytes`. */
  readonly taskSha256: string;
}

export interface LocalVenue {
  readonly backend: LocalTaskExecutionBackend;
  readonly verdictKeyId: string;
  prepareEvaluationCell(input: EvaluationCellInput): PreparedEvaluationCell;
  shutdown(): Promise<void>;
}

/**
 * Structurally matches `@jinn-network/task-execution-backend-local`'s own `LocalLauncherDeployment`
 * / `LauncherReadiness` (`assembly/src/pinning.ts`), which that package does not re-export from
 * its public index — redeclared here rather than imported, same reasoning as `SelectedProvisioner`
 * in `./provisioner.ts`.
 */
interface VerifiedExecutable {
  readonly path: string;
  readonly digest: string;
}
interface LauncherReadiness {
  readonly ready: boolean;
  readonly detail?: string;
  readonly executable: VerifiedExecutable;
  readonly harnessVersions?: readonly string[];
}
interface LocalLauncherDeployment {
  readonly executable: VerifiedExecutable;
  probe(): Promise<LauncherReadiness>;
}

export const SOLVE_HARNESS_PINS = {
  "prediction-v1-baseline": { id: "prediction-v1-baseline", version: "1.0.0" },
  "sample-uniform": { id: SAMPLE_UNIFORM_LAUNCHER_ID, version: SAMPLE_UNIFORM_HARNESS_VERSION },
} as const;

export const EVALUATION_HARNESS_PIN = { id: "evaluation-harness", version: "0.1.0" } as const;

export const VENUE_ISOLATION_POLICY = "unrestricted" as const;

export const VENUE_ISOLATION_INVENTORY: readonly string[] = ["unrestricted"];

/** The venue's fixed evaluator identity — never inferred from Task material (deployment-owned,
 * per `@jinn-network/task-execution-evaluator-adapters`'s `EvaluatorDeploymentOptions` contract). */
const EVALUATOR_ID = "urn:jinn:benchmark-product:local-venue:prediction-evaluator";

/** Portable logical handle only (`defineEvaluatorRegistration`'s `signer.handle` constraint) —
 * inert metadata here (the harness never signs; ./signing.ts does), set to the PEM filename for
 * coherence with where the real key actually lives. */
const SIGNER_HANDLE = "verdict-signing-key.pem";

/**
 * Deployment-owned evaluation method descriptor. The digest is a stable content hash of a fixed
 * label (not a hash of executable bytes — there is no separate "evaluation method" artifact on
 * disk to hash) so the descriptor stays byte-stable across venue instances without depending on
 * an unrelated build.
 */
const EVALUATION_METHOD_DESCRIPTOR = {
  name: "benchmark-product-prediction-evaluation-method",
  digest: { sha256: sha256Hex(new TextEncoder().encode("benchmark-product:local-venue:prediction-evaluation-method@1")) },
} as const;

/**
 * Obtains a launcher's exact planned `node -e` runner source by calling `plan()` once with a
 * harmless probe view (only the harness pin and workspace paths matter to these two launchers'
 * `plan()` — neither reads `view.task`). This is how the venue derives an honest identity digest
 * for `launcherDeployments` without either reaching into the platform launcher's private module
 * internals (its runner string is not exported) or hand-copying a string that could silently
 * drift from the real one. Since `verifyRunPinning` only checks the declared digest against what
 * this venue's own `probe()` echoes back (a self-consistency check, not a supply-chain
 * verification against independently-observed bytes), this technique keeps that self-declared
 * digest a genuine reflection of what will actually execute.
 */
function extractInlineRunnerSource(
  launcher: LauncherContract,
  harnessId: string,
  profile: TaskProfileDocument,
): string {
  const paths: WorkspacePaths = {
    root: "/benchmark-product-identity-probe",
    input: "/benchmark-product-identity-probe/input",
    work: "/benchmark-product-identity-probe/work",
    out: "/benchmark-product-identity-probe/out",
    logs: "/benchmark-product-identity-probe/logs",
    harnessState: "/benchmark-product-identity-probe/harness-state",
    secrets: "/benchmark-product-identity-probe/secrets",
    tmp: "/benchmark-product-identity-probe/tmp",
    meta: "/benchmark-product-identity-probe/meta",
  };
  const attempt: AttemptIdentity = {
    attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000000",
    nonce: "benchmark-product-identity-probe",
    attemptNumber: 1,
  };
  const view: TaskView = {
    task: {} as TaskSpecification,
    effectiveRequirements: { harness: { id: harnessId } },
    profile,
  };
  const plan: LaunchPlan = launcher.plan(view, paths, attempt);
  const runner = plan.argv[2];
  if (plan.argv[1] !== "-e" || typeof runner !== "string" || runner.length === 0) {
    refuse(
      "execution",
      "launcherDeployments",
      `${harnessId}: launcher does not plan the inline "node -e" runner the local venue's identity pin expects`,
    );
  }
  return runner;
}

function resolveEvaluatorAdaptersEntryUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-evaluator-adapters");
}

function resolveEvaluationHarnessLauncherModuleUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-evaluation-harness/launcher");
}

/** Generates `<workspaceDir>/venue/evaluation-deployment.mjs`, the ESM module the spawned
 * evaluation-harness subprocess loads via `JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE`. Embeds an
 * ABSOLUTE `file://` import of the evaluator-adapters package entry (a bare specifier would not
 * resolve from the workspace directory the subprocess runs in). */
function writeEvaluationDeploymentModule(workspaceDir: string): string {
  const evaluatorAdaptersEntryUrl = resolveEvaluatorAdaptersEntryUrl();
  const source = `// Generated by @jinn-network/benchmark-product-core's local venue (src/venue/venue.ts).
// Loaded by the spawned evaluation-harness subprocess via JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE.
// Do not edit by hand -- regenerated on every createLocalVenue() call.
import { createEvaluatorDeployment } from ${JSON.stringify(evaluatorAdaptersEntryUrl)};

export const evaluationHarnessDeployment = createEvaluatorDeployment({
  evaluatorId: ${JSON.stringify(EVALUATOR_ID)},
  signerHandle: ${JSON.stringify(SIGNER_HANDLE)},
  evaluationMethod: ${JSON.stringify(EVALUATION_METHOD_DESCRIPTOR)},
  evidenceWriter: {
    async putClaimEvidence() {
      throw new Error(
        "benchmark-product local venue writes no claim evidence " +
        "(the bundled sample EvaluationSpec declares evidenceConventions.requiredRefs: [])",
      );
    },
  },
  maxClaimEvidenceBytes: 1,
});
`;
  const path = join(workspaceDir, "venue", "evaluation-deployment.mjs");
  writeFileSync(path, source);
  return path;
}

function resolveTaskProfileFor(
  predictionProfile: TaskProfileDocument,
  evaluationProfile: TaskProfileDocument,
): (descriptor: TaskSpecification["profile"]) => TaskProfileDocument {
  return (descriptor) => {
    if (descriptor.uri === PREDICTION_FORECAST_PROFILE_URI) return predictionProfile;
    if (descriptor.uri === EVALUATION_TASK_PROFILE_URI) return evaluationProfile;
    return refuse(
      "execution",
      "task.profile.uri",
      `local venue cannot resolve task profile "${String(descriptor.uri)}"`,
    );
  };
}

export function createLocalVenue(options: LocalVenueOptions): LocalVenue {
  const { workspaceDir } = options;

  const signingKey = loadOrCreateVerdictSigningKey(workspaceDir);
  const signer = createVerdictDsseSigner(signingKey);
  const registry = createEvaluationCellRegistry();
  const provisioner = createLocalProvisioner({ registry, evaluatorId: EVALUATOR_ID, signer });

  const predictionProfile = buildPredictionForecastProfile();
  const evaluationProfile = buildEvaluationTaskProfile();
  const sealedEvaluationProfile = sealTaskProfile(evaluationProfile);
  const profileStore: ProfileStore = {
    get(digest) {
      return digest === sealedEvaluationProfile.digest ? evaluationProfile : undefined;
    },
  };

  const sampleLauncher = makeSampleUniformLauncher();

  const predictionRegistration = createPredictionEvaluatorRegistration({
    evaluatorId: EVALUATOR_ID,
    signerHandle: SIGNER_HANDLE,
    evaluationMethod: EVALUATION_METHOD_DESCRIPTOR,
    resolutionSnapshotSource: contextResolutionSnapshotSource(),
  });
  const evaluationHarnessLauncherModuleUrl = resolveEvaluationHarnessLauncherModuleUrl();
  const evaluationHarnessEntrypointPath = fileURLToPath(new URL("./bin.js", evaluationHarnessLauncherModuleUrl));
  const evaluationHarnessDigest = sha256Hex(readFileSync(evaluationHarnessEntrypointPath));
  const deploymentModulePath = writeEvaluationDeploymentModule(workspaceDir);
  const evaluationLauncher = makeEvaluationLauncher({
    deploymentModule: pathToFileURL(deploymentModulePath).href,
    entrypoint: evaluationHarnessEntrypointPath,
    registrations: [predictionRegistration],
    selectRegistration: () => predictionRegistration,
    probe: async () => ({ ready: true }),
  });

  const baselineRunnerSource = extractInlineRunnerSource(
    predictionV1BaselineLauncher,
    "prediction-v1-baseline",
    predictionProfile,
  );
  const baselineDigest = sha256Hex(new TextEncoder().encode(baselineRunnerSource));
  const sampleDigest = sha256Hex(new TextEncoder().encode(
    extractInlineRunnerSource(sampleLauncher, SAMPLE_UNIFORM_LAUNCHER_ID, predictionProfile),
  ));

  const launcherDeployments: Readonly<Record<string, LocalLauncherDeployment>> = {
    [predictionV1BaselineLauncher.id]: {
      executable: { path: process.execPath, digest: baselineDigest },
      async probe() {
        return {
          ready: true,
          executable: { path: process.execPath, digest: baselineDigest },
          harnessVersions: [SOLVE_HARNESS_PINS["prediction-v1-baseline"].version],
        };
      },
    },
    [sampleLauncher.id]: {
      executable: { path: process.execPath, digest: sampleDigest },
      async probe() {
        return {
          ready: true,
          executable: { path: process.execPath, digest: sampleDigest },
          harnessVersions: [SOLVE_HARNESS_PINS["sample-uniform"].version],
        };
      },
    },
    [evaluationLauncher.id]: {
      executable: { path: evaluationHarnessEntrypointPath, digest: evaluationHarnessDigest },
      async probe() {
        return {
          ready: true,
          executable: { path: evaluationHarnessEntrypointPath, digest: evaluationHarnessDigest },
          harnessVersions: [EVALUATION_HARNESS_PIN.version],
        };
      },
    },
  };

  const provisionerCapabilities: ProvisionerCapabilities = {
    taskProfiles: [PREDICTION_FORECAST_PROFILE_URI, EVALUATION_TASK_PROFILE_URI],
    workspaceKinds: ["dir"],
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: ["application/json", "application/vnd.in-toto+json"],
    isolation: ["process"],
  };

  const backend = makeLocalTaskExecutionBackend({
    stateRoot: join(workspaceDir, "venue", "backend-state"),
    source: "urn:jinn:benchmark-product:local-venue",
    executor: "urn:jinn:benchmark-product:local-venue:executor",
    profileStore,
    resolveTaskProfile: resolveTaskProfileFor(predictionProfile, evaluationProfile),
    launchers: [predictionV1BaselineLauncher, sampleLauncher, evaluationLauncher],
    launcherDeployments,
    provisioner,
    provisionerCapabilities,
    now: options.now,
  });

  function prepareEvaluationCell(input: EvaluationCellInput): PreparedEvaluationCell {
    let subjectTaskDocument: { readonly payload?: { readonly forecast?: unknown } };
    try {
      subjectTaskDocument = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(input.subjectTaskBytes),
      ) as typeof subjectTaskDocument;
    } catch {
      return refuse("validation", "subjectTaskBytes", "subject Task bytes are not valid UTF-8 JSON");
    }
    const forecast = subjectTaskDocument.payload?.forecast;
    if (!isSampleForecastPayload(forecast)) {
      return refuse(
        "validation",
        "subjectTaskBytes",
        "subject Task payload.forecast is not a recognizable sample prediction-forecast payload",
      );
    }
    const resolution = deriveSampleResolution(forecast);
    const evaluationContextBytes = new TextEncoder().encode(JSON.stringify(resolution));

    const subjectTaskDigest = `sha256:${sha256Hex(input.subjectTaskBytes)}` as const;
    const subjectDeliveryDigest = `sha256:${sha256Hex(input.subjectDeliveryBytes)}` as const;
    const evaluationSpecDigest = `sha256:${sha256Hex(input.evaluationSpecBytes)}` as const;
    const subjectResults = input.resultArtifacts.map((artifact) => ({
      name: artifact.name,
      digest: `sha256:${sha256Hex(artifact.bytes)}` as const,
    }));

    const derived = deriveEvaluationTask({
      subjectTask: { name: "subject-task.json", digest: subjectTaskDigest },
      subjectDelivery: { name: "subject-delivery.json", digest: subjectDeliveryDigest },
      subjectResults,
      evaluationSpecDigest,
    });
    const taskSha256 = derived.digest.slice("sha256:".length);

    const materials: EvaluationCellMaterials = {
      subjectTaskBytes: input.subjectTaskBytes,
      subjectDeliveryBytes: input.subjectDeliveryBytes,
      resultArtifacts: input.resultArtifacts,
      evaluationSpecBytes: input.evaluationSpecBytes,
      evaluationContextBytes,
    };
    registry.register(taskSha256, materials);

    return { taskBytes: derived.bytes, taskSha256 };
  }

  return {
    backend,
    verdictKeyId: signingKey.keyId,
    prepareEvaluationCell,
    async shutdown() {
      await backend.shutdown();
    },
  };
}
