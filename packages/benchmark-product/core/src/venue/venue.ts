/**
 * The product's local-venue host (BP-12: the official run path on the real local execution
 * backend). Composes the real `@jinn-network/task-execution-backend-local` backend with:
 *
 * - the platform's `prediction-v1-baseline` launcher, plus the product-bundled `sample-uniform`
 *   launcher (`./sample-uniform.ts`), both real subprocess-spawning arms for prediction-forecast
 *   solve cells (M1 dossier §3 decision 1);
 * - the platform's evaluation-harness launcher, configured with the prediction adapter plus the
 *   product-owned SWE-rebench registration backed by the pinned OCI grader;
 * - a product-owned provisioner (`./provisioner.ts`, G1) that writes the right input shape for
 *   each cell kind and normalizes each cell's harvested output manifest;
 * - per-evaluator product-held Ed25519 verdict-signing keys (`./signing.ts`, G2 + BP-21) that
 *   DSSE-wrap the evaluation harness's unsigned Result Evaluation Statement, each evaluation
 *   attempt sealed with the key of the evaluator identity its Submission named via
 *   `EVALUATOR_REQUIREMENT_KEY`.
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
import { isAbsolute, join } from "node:path";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type ProvisionerCapabilities,
} from "@jinn-network/task-execution-backend-local";
import { predictionV1BaselineLauncher, type LauncherCapabilities, type LauncherContract, type LaunchPlan } from "@jinn-network/task-execution-launchers";
import {
  buildEvaluationTaskProfile,
  buildPredictionForecastProfile,
  buildRepositoryWorkProfile,
  deriveEvaluationTask,
  EVALUATION_TASK_PROFILE_URI,
  parseEvaluationSpec,
  parserAllowlistKey,
  PREDICTION_FORECAST_PROFILE_URI,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
  verifyEvaluationSubject,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type ProfileStore,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import type { TaskSpecification } from "@jinn-network/task-execution-protocol";
import { makeEvaluationLauncher } from "@jinn-network/task-execution-evaluation-harness/launcher";
import { defineEvaluatorRegistration } from "@jinn-network/task-execution-evaluation-harness";
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
  PREDICTION_PARSER,
  SWE_REBENCH_PARSER,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  ensurePinnedOciImage,
  graderProgramDigest,
  pinnedSweRebenchImage,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
  sweRebenchOciGraderReportSource,
} from "@jinn-network/task-execution-oci-grader";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { EvaluationRuntimeBinding } from "../domain/draft.js";
import { refuse } from "../errors.js";
import {
  buildInspectTaskProfile,
  INSPECT_EMBEDDED_EVALUATOR_ID,
  INSPECT_NATIVE_LOG_MEDIA_TYPE,
  INSPECT_SUMMARY_MEDIA_TYPE,
  INSPECT_TASK_PROFILE_URI,
  InspectCellSummarySchema,
} from "../runtime/inspect/artifacts.js";
import {
  assertInspectSelectionUndrifted,
  inspectWorkerPath,
  readInspectHostBinding,
  readInspectSelectionManifest,
} from "../runtime/inspect/host.js";
import { makeInspectLauncher } from "../runtime/inspect/launcher.js";
import { INSPECT_ADAPTER_ID } from "../runtime/inspect/manifest.js";
import { assertInspectOciBrokerReady, inspectOciRunnerPath } from "../runtime/inspect/oci.js";
import {
  inspectLogVerifierParser,
  inspectLogVerifierMethod,
  type InspectEvaluationStrategy,
} from "../runtime/inspect/assurance.js";
import { HARBOR_ADAPTER_ID, HarborSelectionManifestSchema, type HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { readHarborHostBinding } from "../runtime/harbor/host.js";
import { makeHarborLauncher, HARBOR_LAUNCHER_ID } from "../runtime/harbor/launcher.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  createEvaluationCellRegistry,
  createLocalProvisioner,
  EVALUATOR_REQUIREMENT_KEY,
  type EvaluationCellMaterials,
} from "./provisioner.js";
import { createGitRepositoryMirror } from "./repository-mirror.js";
import { deriveSampleResolution, isSampleForecastPayload } from "./resolution.js";
import {
  INSPECT_OCI_ISOLATION_POLICY,
  VENUE_ISOLATION_POLICY,
  deriveVenueIsolationPosture,
} from "./isolation.js";
import {
  makeSampleRepositoryWorkLauncher,
  SAMPLE_REPOSITORY_WORK_HARNESS_VERSION,
  SAMPLE_REPOSITORY_WORK_LAUNCHER_ID,
} from "./sample-repository-work.js";
import { makeSampleUniformLauncher, SAMPLE_UNIFORM_HARNESS_VERSION, SAMPLE_UNIFORM_LAUNCHER_ID } from "./sample-uniform.js";
import { createVerdictDsseSigner, loadOrCreateEvaluatorSigningKeys } from "./signing.js";
import {
  makeDemo1ClaudeLauncher,
  type Demo1ClaudeRuntimeBinding,
} from "./demo1-claude.js";

/** The Submission requirement key naming the evaluator IRI for an evaluation attempt (BP-21).
 * Homed in `./provisioner.ts` to avoid a module cycle; this is its public re-export. */
export { EVALUATOR_REQUIREMENT_KEY } from "./provisioner.js";

export interface LocalVenueOptions {
  readonly workspaceDir: string;
  /** Workspace containing the immutable runtime selection and its private host binding. This
   * differs from `workspaceDir` only for rehearsals, whose venue state and keys live in an
   * isolated scratch root while the selected runtime remains anchored in the product workspace. */
  readonly runtimeBindingWorkspaceDir?: string;
  /** Opaque, host-owned connection descriptor outside product state/workspaces. */
  readonly inspectHostConnectionDescriptor?: string;
  readonly now: () => string;
  /** Selected evaluation runtime. Absent and `jinn-native` both preserve the original venue. */
  readonly evaluationRuntime?: EvaluationRuntimeBinding;
  /** Product-private strategy derived from the resolved assurance sealed into the Run. */
  readonly inspectEvaluationStrategy?: InspectEvaluationStrategy;
  /** How many venue evaluator identities to mint (integer >= 1, default 1). See
   * `LocalVenue.evaluators` for the honesty posture of what N identities do and do not prove. */
  readonly evaluatorCount?: number;
  /** Product-owned binding for the real SWE-rebench OCI grader. Images are always addressed by
   * digest and pre-staged before evaluation dispatch; the child may only inspect that local
   * digest and runs with `--pull never`. If the image disappears after pre-stage, the child fails
   * the grader attempt without registry access. Public networking remains disabled unless both
   * the sealed EvaluationSpec and this host option explicitly opt in. `dockerPath` is an injection
   * seam for a host-managed runtime executable (and for tests that must not contact a real daemon). */
  readonly sweRebenchGrader?: {
    readonly runtime?: "docker" | "podman";
    readonly dockerPath?: string;
    readonly allowPublicNetwork?: boolean;
  };
  /**
   * TEST-ONLY hook: rewrites an evaluation attempt's `input/evaluation-context.json` bytes per
   * selected evaluator. It exists solely so tests can manufacture a controlled evaluator
   * disagreement; production callers never set it.
   */
  readonly evaluationContextVariationForTesting?: (evaluatorId: string, contextBytes: Uint8Array) => Uint8Array;
  /** TEST-ONLY: blocks each solve launcher's real `node -e` subprocess before its normal runner
   * starts, allowing cancellation tests to observe and kill a genuinely live process. */
  readonly solveStartDelayMsForTesting?: number;
  /** Explicit product-owned Claude Code runtime. Absent means the venue advertises no real
   * Claude arm; no executable path or credential is inferred from ambient environment state. */
  readonly demo1ClaudeRuntime?: Demo1ClaudeRuntimeBinding;
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
  /** Synchronously proves this constructor owns the sole durable state-root writer before a run
   * driver is journaled. Optional only for narrow in-memory unit venues. */
  readonly assertRunOwnership?: () => void;
  /** Async launcher/readiness probes, deliberately performed after driver-started is durable. */
  readonly preflightRun?: () => Promise<void>;
  /** `evaluators[0].keyId`, kept for continuity with the pre-BP-21 single-evaluator surface. */
  readonly verdictKeyId: string;
  /**
   * The venue's workspace-minted evaluator identities, ordered (length = `evaluatorCount`). Each
   * has its own Ed25519 verdict-signing key; an evaluation Submission selects one via the
   * `EVALUATOR_REQUIREMENT_KEY` requirement.
   *
   * HONESTY (product design spec §6): distinct keys prove AGENT-DISTINCTNESS only — that N
   * separately-keyed evaluator agents each signed their own verdict. The same operator runs them
   * all on a self-run venue; this is never third-party or party-independent verification.
   */
  readonly evaluators: readonly { readonly id: string; readonly keyId: string }[];
  /** A native run dispatches separate evaluation Tasks. Inspect produces an attributable score
   * in the solve execution, which must never be represented as independent evaluation. */
  readonly evaluationMode?: "separate" | "embedded";
  readonly interpretEmbeddedEvaluation?: (
    artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[],
  ) =>
    | { readonly kind: "verdict"; readonly evaluatorId: string; readonly verdictBytes: Uint8Array }
    | { readonly kind: "could-not-grade"; readonly detail: string };
  prepareEvaluationCell(input: EvaluationCellInput): PreparedEvaluationCell | Promise<PreparedEvaluationCell>;
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
  readonly models?: readonly string[];
  readonly loadouts?: readonly {
    readonly kind: "jinn.skill.v1" | "jinn.harness-state.v1";
    readonly name: string;
    readonly digest: string;
  }[];
}
interface LocalLauncherDeployment {
  readonly executable: VerifiedExecutable;
  probe(): Promise<LauncherReadiness>;
}

export const SOLVE_HARNESS_PINS = {
  "prediction-v1-baseline": { id: "prediction-v1-baseline", version: "1.0.0" },
  "sample-uniform": { id: SAMPLE_UNIFORM_LAUNCHER_ID, version: SAMPLE_UNIFORM_HARNESS_VERSION },
  "sample-repository-work": { id: SAMPLE_REPOSITORY_WORK_LAUNCHER_ID, version: SAMPLE_REPOSITORY_WORK_HARNESS_VERSION },
} as const;

export const EVALUATION_HARNESS_PIN = { id: "evaluation-harness", version: "0.1.0" } as const;

export { VENUE_ISOLATION_POLICY } from "./isolation.js";

/**
 * Venue evaluator identity IRI, `index` 1-based — deployment-owned, never inferred from Task
 * material (per `@jinn-network/task-execution-evaluator-adapters`'s `EvaluatorDeploymentOptions`
 * contract).
 *
 * HONESTY (product design spec §6): these are N workspace-minted identities run by the SAME
 * operator on a self-run venue. Their distinct Ed25519 keys prove AGENT-DISTINCTNESS only — never
 * third-party or party-independent verification.
 */
function evaluatorIri(index: number): string {
  return `urn:jinn:benchmark-product:local-venue:evaluator-${index}`;
}

/** Evaluator registration id, `index` 1-based — used BOTH parent-side (the launcher's
 * `registrations` + `selectRegistration`) and in the generated deployment module the spawned
 * harness loads; the spawned harness selects by exact id match, so the two must agree. */
type EvaluationAdapterKind = "prediction" | "swe-rebench" | "inspect-log-verifier";

function evaluatorRegistrationId(index: number, kind: EvaluationAdapterKind): string {
  const prefix = kind === "prediction"
    ? "prediction-market"
    : kind === "swe-rebench"
      ? "swe-rebench-v2"
      : "inspect-log-verifier";
  return `${prefix}:evaluator-${index}`;
}

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
const PREDICTION_EVALUATION_METHOD_DESCRIPTOR = {
  name: "benchmark-product-prediction-evaluation-method",
  digest: { sha256: sha256Hex(new TextEncoder().encode("benchmark-product:local-venue:prediction-evaluation-method@1")) },
} as const;

/** The SWE-rebench method is the exact frozen grader-program bytes, not a descriptive label. The
 * evaluation harness seals this descriptor into every Result Evaluation Statement, while the
 * statement's EvaluationSpec reference seals the row material, image, parser, and timeout. */
const SWE_REBENCH_EVALUATION_METHOD_DESCRIPTOR = {
  name: "swe-rebench-oci-grader-program",
  digest: { sha256: graderProgramDigest().slice("sha256:".length) },
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

function withSolveStartDelayForTesting(
  launcher: LauncherContract,
  delayMs: number | undefined,
): LauncherContract {
  if (delayMs === undefined || delayMs === 0) return launcher;
  return {
    id: launcher.id,
    capabilities: () => launcher.capabilities(),
    ...(launcher.probe === undefined ? {} : { probe: () => launcher.probe!() }),
    plan(view, paths, attempt) {
      const plan = launcher.plan(view, paths, attempt);
      const source = plan.argv[2];
      if (plan.argv[0] !== process.execPath || plan.argv[1] !== "-e" || typeof source !== "string") {
        refuse(
          "execution",
          "solveStartDelayMsForTesting",
          `${launcher.id}: test delay requires the venue's ordinary inline node runner`,
        );
      }
      const delayedSource = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});\n${source}`;
      return { ...plan, argv: [plan.argv[0], plan.argv[1], delayedSource, ...plan.argv.slice(3)] };
    },
  };
}

function resolveEvaluatorAdaptersEntryUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-evaluator-adapters");
}

function resolveOciGraderEntryUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-oci-grader");
}

function resolveEvaluationHarnessEntryUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-evaluation-harness");
}

function resolveEvaluationHarnessLauncherModuleUrl(): string {
  return import.meta.resolve("@jinn-network/task-execution-evaluation-harness/launcher");
}

function resolveInspectVerifierRuntimeUrl(): string {
  return new URL("../runtime/inspect/verifier-runtime.mjs", import.meta.url).href;
}

/** Generates `<workspaceDir>/venue/evaluation-deployment.mjs`, the ESM module the spawned
 * evaluation-harness subprocess loads via `JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE`. Embeds
 * ABSOLUTE `file://` imports of the evaluator-adapters, OCI-grader, and evaluation-harness package
 * entries (a bare specifier would not resolve from the workspace directory the subprocess runs
 * in). Builds the `EvaluationHarnessDeployment` object itself rather than calling
 * `createEvaluatorDeployment` — that helper hardcodes ONE evaluator id, and this venue registers
 * one prediction plus one SWE-rebench registration per evaluator identity (BP-21 / Demo-1 P3b). */
function writeEvaluationDeploymentModule(
  workspaceDir: string,
  evaluators: readonly {
    readonly id: string;
    readonly predictionRegistrationId: string;
    readonly sweRebenchRegistrationId: string;
    readonly inspectRegistrationId: string;
  }[],
  grader: {
    readonly runtime: "docker" | "podman";
    readonly dockerPath?: string;
    readonly allowPublicNetwork: boolean;
  },
  inspect?: {
    readonly manifest: ReturnType<typeof readInspectSelectionManifest>;
    readonly selectionManifestSha256: string;
    readonly workerPath: string;
    readonly ociRunnerPath: string;
    readonly host: { readonly kind: "local-python"; readonly pythonPath: string } | {
      readonly kind: "oci";
      readonly dockerPath: string;
      readonly imageDigest: string;
      readonly platform: string;
      readonly user: string;
    };
    readonly evaluationMethod: ReturnType<typeof inspectLogVerifierMethod>;
    readonly parserAllowlistKey: string;
  },
): string {
  const evaluatorAdaptersEntryUrl = resolveEvaluatorAdaptersEntryUrl();
  const ociGraderEntryUrl = resolveOciGraderEntryUrl();
  const evaluationHarnessEntryUrl = resolveEvaluationHarnessEntryUrl();
  const inspectVerifierRuntimeUrl = resolveInspectVerifierRuntimeUrl();
  const source = `// Generated by @jinn-network/benchmark-product-core's local venue (src/venue/venue.ts).
// Loaded by the spawned evaluation-harness subprocess via JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE.
// Do not edit by hand -- regenerated on every createLocalVenue() call.
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
  evaluatorAdaptersParserAllowlist,
} from ${JSON.stringify(evaluatorAdaptersEntryUrl)};
import { sha256Hex, sweRebenchOciGraderReportSource } from ${JSON.stringify(ociGraderEntryUrl)};
import { validateEvaluatorRegistrationSet } from ${JSON.stringify(evaluationHarnessEntryUrl)};
import { createInspectLogVerifierRegistration } from ${JSON.stringify(inspectVerifierRuntimeUrl)};

// One registration per supported parser and workspace-minted evaluator identity. Distinct
// identities prove agent-distinctness only -- the same operator runs every evaluator here.
const EVALUATORS = ${JSON.stringify(evaluators)};
const SWE_REBENCH_GRADER = ${JSON.stringify(grader)};
const INSPECT = ${JSON.stringify(inspect ?? null)};
const sweRebenchGraderReportSource = sweRebenchOciGraderReportSource({
  runtime: SWE_REBENCH_GRADER.runtime,
  allowPublicNetwork: SWE_REBENCH_GRADER.allowPublicNetwork,
  runner: {
    imagePullPolicy: "never",
    ...(SWE_REBENCH_GRADER.dockerPath === undefined
      ? {}
      : { dockerPath: SWE_REBENCH_GRADER.dockerPath }),
  },
});

export const evaluationHarnessDeployment = Object.freeze({
  registrations: validateEvaluatorRegistrationSet(EVALUATORS.flatMap((evaluator) => [
    {
      ...createPredictionEvaluatorRegistration({
        evaluatorId: evaluator.id,
        signerHandle: ${JSON.stringify(SIGNER_HANDLE)},
        evaluationMethod: ${JSON.stringify(PREDICTION_EVALUATION_METHOD_DESCRIPTOR)},
        resolutionSnapshotSource: contextResolutionSnapshotSource(),
      }),
      registrationId: evaluator.predictionRegistrationId,
    },
    {
      ...createSweRebenchEvaluatorRegistration({
        evaluatorId: evaluator.id,
        signerHandle: ${JSON.stringify(SIGNER_HANDLE)},
        evaluationMethod: ${JSON.stringify(SWE_REBENCH_EVALUATION_METHOD_DESCRIPTOR)},
        graderReportSource: sweRebenchGraderReportSource,
      }),
      registrationId: evaluator.sweRebenchRegistrationId,
    },
    ...(INSPECT === null ? [] : [createInspectLogVerifierRegistration({
      ...INSPECT,
      registrationId: evaluator.inspectRegistrationId,
      evaluatorId: evaluator.id,
      signerHandle: ${JSON.stringify(SIGNER_HANDLE)},
    })]),
  ])),
  parserAllowlist: new Set([
    ...evaluatorAdaptersParserAllowlist(),
    ...(INSPECT === null ? [] : [INSPECT.parserAllowlistKey]),
  ]),
  evidenceWriter: {
    async putClaimEvidence({ name, bytes, mediaType }) {
      // A digest-bound data URI keeps bounded grader evidence deletion-portable with the verdict;
      // no evaluator-private filesystem path enters a sealed statement. The harness deliberately
      // refuses the descriptor content field for writer-produced evidence, hence the URI.
      return {
        name,
        digest: { sha256: sha256Hex(bytes) },
        uri: "data:" + (mediaType ?? "application/octet-stream") + ";base64," +
          Buffer.from(bytes).toString("base64"),
        ...(mediaType === undefined ? {} : { mediaType }),
      };
    },
  },
  maxClaimEvidenceBytes: 1024 * 1024,
});
`;
  const path = join(workspaceDir, "venue", "evaluation-deployment.mjs");
  writeFileSync(path, source);
  return path;
}

function resolveTaskProfileFor(
  predictionProfile: TaskProfileDocument,
  evaluationProfile: TaskProfileDocument,
  repositoryWorkProfile: TaskProfileDocument,
  inspectProfile?: TaskProfileDocument,
): (descriptor: TaskSpecification["profile"]) => TaskProfileDocument {
  return (descriptor) => {
    if (descriptor.uri === PREDICTION_FORECAST_PROFILE_URI) return predictionProfile;
    if (descriptor.uri === EVALUATION_TASK_PROFILE_URI) return evaluationProfile;
    if (descriptor.uri === REPOSITORY_WORK_PROFILE_URI) return repositoryWorkProfile;
    if (descriptor.uri === INSPECT_TASK_PROFILE_URI && inspectProfile !== undefined) return inspectProfile;
    return refuse(
      "execution",
      "task.profile.uri",
      `local venue cannot resolve task profile "${String(descriptor.uri)}"`,
    );
  };
}

export function createLocalVenue(options: LocalVenueOptions): LocalVenue {
  const { workspaceDir } = options;
  const runtimeBindingWorkspaceDir = options.runtimeBindingWorkspaceDir ?? workspaceDir;
  const runtimeId = options.evaluationRuntime?.adapterId ?? "jinn-native";
  if (runtimeId !== "jinn-native" && runtimeId !== INSPECT_ADAPTER_ID && runtimeId !== HARBOR_ADAPTER_ID) {
    refuse("venue-unavailable", "evaluationRuntime.adapterId", `unsupported evaluation runtime "${runtimeId}"`);
  }
  const inspectSelection = runtimeId === INSPECT_ADAPTER_ID
    ? readInspectSelectionManifest(runtimeBindingWorkspaceDir, options.evaluationRuntime!.selectionManifestSha256)
    : undefined;
  const inspectHost = runtimeId === INSPECT_ADAPTER_ID
    ? readInspectHostBinding(runtimeBindingWorkspaceDir, options.evaluationRuntime!.selectionManifestSha256)
    : undefined;
  const inspectEvaluationStrategy = inspectSelection === undefined
    ? undefined
    : options.inspectEvaluationStrategy ?? "embedded";
  const harborSelection: HarborSelectionManifest | undefined = runtimeId === HARBOR_ADAPTER_ID
    ? HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(runtimeBindingWorkspaceDir, options.evaluationRuntime!.selectionManifestSha256))))
    : undefined;
  const harborHost = runtimeId === HARBOR_ADAPTER_ID
    ? readHarborHostBinding(runtimeBindingWorkspaceDir, options.evaluationRuntime!.selectionManifestSha256)
    : undefined;

  if (
    options.solveStartDelayMsForTesting !== undefined
    && (!Number.isSafeInteger(options.solveStartDelayMsForTesting)
      || options.solveStartDelayMsForTesting < 0
      || options.solveStartDelayMsForTesting > 60_000)
  ) {
    refuse(
      "validation",
      "solveStartDelayMsForTesting",
      "solveStartDelayMsForTesting must be an integer between 0 and 60000 milliseconds",
    );
  }

  const evaluatorCount = options.evaluatorCount ?? 1;
  if (!Number.isSafeInteger(evaluatorCount) || evaluatorCount < 1) {
    refuse("validation", "evaluatorCount", "evaluatorCount must be an integer >= 1");
  }
  const sweRebenchGrader = {
    runtime: options.sweRebenchGrader?.runtime ?? "docker",
    ...(options.sweRebenchGrader?.dockerPath === undefined
      ? {}
      : { dockerPath: options.sweRebenchGrader.dockerPath }),
    allowPublicNetwork: options.sweRebenchGrader?.allowPublicNetwork ?? false,
  } as const;
  if (sweRebenchGrader.dockerPath !== undefined
    && (sweRebenchGrader.dockerPath.length === 0 || !isAbsolute(sweRebenchGrader.dockerPath))) {
    refuse("validation", "sweRebenchGrader.dockerPath", "grader runtime path must be absolute");
  }
  if (inspectSelection !== undefined && inspectEvaluationStrategy === "embedded" && evaluatorCount !== 1) {
    refuse(
      "validation",
      "evaluatorCount",
      "embedded Inspect scoring exposes exactly one same-execution scorer identity",
    );
  }
  const evaluatorIdentities = inspectSelection !== undefined && inspectEvaluationStrategy === "embedded"
    ? [{ id: INSPECT_EMBEDDED_EVALUATOR_ID }]
    : Array.from({ length: evaluatorCount }, (_, i) => ({ id: evaluatorIri(i + 1) }));
  const signingKeys = loadOrCreateEvaluatorSigningKeys(
    workspaceDir,
    evaluatorIdentities,
  );
  const evaluators = signingKeys.map(({ id, key }, index) => ({
    id,
    keyId: key.keyId,
    signer: createVerdictDsseSigner(key),
    predictionRegistrationId: evaluatorRegistrationId(index + 1, "prediction"),
    sweRebenchRegistrationId: evaluatorRegistrationId(index + 1, "swe-rebench"),
    inspectRegistrationId: evaluatorRegistrationId(index + 1, "inspect-log-verifier"),
  }));
  const registry = createEvaluationCellRegistry();
  const provisioner = createLocalProvisioner({
    registry,
    evaluators: evaluators.map(({ id, signer }) => ({ id, signer })),
    repositoryMirror: createGitRepositoryMirror(join(workspaceDir, "venue", "repositories")),
    ...(options.demo1ClaudeRuntime === undefined
      ? {}
      : { demo1Instructions: options.demo1ClaudeRuntime.artifacts }),
    ...(options.evaluationContextVariationForTesting === undefined
      ? {}
      : { evaluationContextVariationForTesting: options.evaluationContextVariationForTesting }),
    ...(inspectSelection === undefined || inspectHost === undefined
      ? {}
      : {
        inspect: {
          selectionManifestSha256: options.evaluationRuntime!.selectionManifestSha256,
          manifest: inspectSelection,
          host: inspectHost,
          ...(inspectEvaluationStrategy === "embedded"
            ? { embeddedEvaluator: evaluators[0]! }
            : {}),
        },
      }),
    ...(harborSelection === undefined || harborHost === undefined
      ? {}
      : {
        harbor: {
          workspaceDir,
          selectionManifestSha256: options.evaluationRuntime!.selectionManifestSha256,
          manifest: harborSelection,
          host: harborHost,
        },
      }),
  });

  const predictionProfile = buildPredictionForecastProfile();
  const evaluationProfile = buildEvaluationTaskProfile();
  const repositoryWorkProfile = buildRepositoryWorkProfile();
  const inspectProfile = inspectSelection === undefined ? undefined : buildInspectTaskProfile();
  const sealedEvaluationProfile = sealTaskProfile(evaluationProfile);
  const profileStore: ProfileStore = {
    get(digest) {
      return digest === sealedEvaluationProfile.digest ? evaluationProfile : undefined;
    },
  };

  const baselineLauncher = withSolveStartDelayForTesting(
    predictionV1BaselineLauncher,
    options.solveStartDelayMsForTesting,
  );
  const sampleLauncher = withSolveStartDelayForTesting(
    makeSampleUniformLauncher(),
    options.solveStartDelayMsForTesting,
  );
  const repositoryWorkLauncher = withSolveStartDelayForTesting(
    makeSampleRepositoryWorkLauncher(),
    options.solveStartDelayMsForTesting,
  );
  const demo1ClaudeLauncher = options.demo1ClaudeRuntime === undefined
    ? undefined
    : makeDemo1ClaudeLauncher(options.demo1ClaudeRuntime);
  const inspectLauncher = inspectSelection === undefined || inspectHost === undefined
    ? undefined
    : makeInspectLauncher({
      host: inspectHost,
      manifest: inspectSelection,
      hostConnectionDescriptor: options.inspectHostConnectionDescriptor,
    });
  const inspectVerifier = inspectSelection === undefined
    || inspectHost === undefined
    || inspectEvaluationStrategy !== "separate-log-verification"
    ? undefined
    : {
      manifest: inspectSelection,
      selectionManifestSha256: options.evaluationRuntime!.selectionManifestSha256,
      workerPath: inspectWorkerPath(),
      ociRunnerPath: inspectOciRunnerPath(),
      host: inspectHost.kind === "oci"
        ? {
          kind: "oci" as const,
          dockerPath: inspectHost.dockerPath,
          imageDigest: inspectHost.imageDigest,
          platform: inspectHost.platform,
          user: inspectHost.user,
        }
        : { kind: "local-python" as const, pythonPath: inspectHost.pythonPath },
      evaluationMethod: inspectLogVerifierMethod(
        inspectSelection,
        options.evaluationRuntime!.selectionManifestSha256,
      ),
      parserAllowlistKey: parserAllowlistKey(inspectLogVerifierParser(inspectSelection)),
    };
  const harborLauncher = harborSelection === undefined || harborHost === undefined
    ? undefined
    : makeHarborLauncher({ manifest: harborSelection, host: harborHost });

  // One registration per supported parser and evaluator identity, id-matched with the generated
  // child deployment. Factory registration IDs are intentionally overridden per evaluator using
  // the platform's documented spread technique for frozen registration objects.
  const evaluatorRegistrations = evaluators.flatMap((evaluator) => ([
    {
      evaluatorId: evaluator.id,
      kind: "prediction" as const,
      registration: {
        ...createPredictionEvaluatorRegistration({
          evaluatorId: evaluator.id,
          signerHandle: SIGNER_HANDLE,
          evaluationMethod: PREDICTION_EVALUATION_METHOD_DESCRIPTOR,
          resolutionSnapshotSource: contextResolutionSnapshotSource(),
        }),
        registrationId: evaluator.predictionRegistrationId,
      },
    },
    {
      evaluatorId: evaluator.id,
      kind: "swe-rebench" as const,
      registration: {
        ...createSweRebenchEvaluatorRegistration({
          evaluatorId: evaluator.id,
          signerHandle: SIGNER_HANDLE,
          evaluationMethod: SWE_REBENCH_EVALUATION_METHOD_DESCRIPTOR,
          graderReportSource: sweRebenchOciGraderReportSource({
            runtime: sweRebenchGrader.runtime,
            allowPublicNetwork: sweRebenchGrader.allowPublicNetwork,
            runner: {
              imagePullPolicy: "never",
              ...(sweRebenchGrader.dockerPath === undefined
                ? {}
                : { dockerPath: sweRebenchGrader.dockerPath }),
            },
          }),
        }),
        registrationId: evaluator.sweRebenchRegistrationId,
      },
    },
    ...(inspectVerifier === undefined ? [] : [{
      evaluatorId: evaluator.id,
      kind: "inspect-log-verifier" as const,
      registration: defineEvaluatorRegistration({
        registrationId: evaluator.inspectRegistrationId,
        adapter: {
          async evaluate() {
            throw new TypeError("Inspect log verification runs only in the supervised evaluation deployment");
          },
        },
        evaluationMethod: inspectVerifier.evaluationMethod,
        specificationCompatibility: (specification) =>
          specification.family === "deterministic-process"
          && parserAllowlistKey((specification.familyBlock as DeterministicProcessBlock).parser)
            === inspectVerifier.parserAllowlistKey,
        evaluatorIdentity: { id: evaluator.id },
        signer: { handle: SIGNER_HANDLE },
        outcomeValidator: (evaluation) => evaluation,
        interruptionBehavior: "repeatable",
      }),
    }]),
  ]));
  const evaluationSpecKinds = new Map<string, EvaluationAdapterKind>();
  const evaluationHarnessLauncherModuleUrl = resolveEvaluationHarnessLauncherModuleUrl();
  const evaluationHarnessEntrypointPath = fileURLToPath(new URL("./bin.js", evaluationHarnessLauncherModuleUrl));
  const evaluationHarnessDigest = sha256Hex(readFileSync(evaluationHarnessEntrypointPath));
  const deploymentModulePath = writeEvaluationDeploymentModule(
    workspaceDir,
    evaluators.map(({ id, predictionRegistrationId, sweRebenchRegistrationId, inspectRegistrationId }) => ({
      id,
      predictionRegistrationId,
      sweRebenchRegistrationId,
      inspectRegistrationId,
    })),
    sweRebenchGrader,
    inspectVerifier,
  );
  const platformEvaluationLauncher = makeEvaluationLauncher({
    deploymentModule: pathToFileURL(deploymentModulePath).href,
    entrypoint: evaluationHarnessEntrypointPath,
    registrations: evaluatorRegistrations.map(({ registration }) => registration),
    selectRegistration: (view) => {
      const requested = (view.effectiveRequirements as Record<string, unknown>)[EVALUATOR_REQUIREMENT_KEY];
      if (typeof requested !== "string") {
        // NEVER silently default: a missing evaluator requirement on an evaluation Submission is
        // a caller bug (the launcher wraps this into the attempt's typed failure).
        throw new TypeError(
          `evaluation Submission carries no "${EVALUATOR_REQUIREMENT_KEY}" requirement naming the venue evaluator`,
        );
      }
      const evaluationSpec = (view.task.payload as { readonly evaluationSpec?: unknown } | undefined)
        ?.evaluationSpec;
      if (typeof evaluationSpec !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(evaluationSpec)) {
        throw new TypeError("evaluation Task carries no canonical payload.evaluationSpec digest");
      }
      const kind = evaluationSpecKinds.get(evaluationSpec);
      if (kind === undefined) {
        throw new TypeError(`evaluation specification ${evaluationSpec} was not prepared by this venue`);
      }
      const entry = evaluatorRegistrations.find((candidate) =>
        candidate.evaluatorId === requested && candidate.kind === kind);
      if (entry === undefined) {
        throw new TypeError(`"${requested}" is not one of this venue's evaluator identities`);
      }
      return entry.registration;
    },
    probe: async () => ({ ready: true }),
  });
  // Product-owned wrapper over the platform launcher contract, following ./sample-uniform.ts's
  // precedent of declaring an extra runPinning key: same id (launcherDeployments is keyed by it),
  // delegated probe/plan, capabilities extended with the evaluator requirement key so the
  // backend's submit-time capability check admits — and inventory-checks — the evaluator IRI a
  // Submission names. The posture is honestly "enforced": an unknown evaluator refuses at plan
  // time via selectRegistration above.
  const evaluationLauncher: LauncherContract = {
    id: platformEvaluationLauncher.id,
    capabilities: (): LauncherCapabilities => {
      const base = platformEvaluationLauncher.capabilities();
      return {
        ...base,
        runPinning: {
          keys: [
            ...base.runPinning.keys,
            {
              key: EVALUATOR_REQUIREMENT_KEY,
              inventory: evaluators.map(({ id }) => id),
              posture: "enforced",
            },
          ],
        },
      };
    },
    ...(platformEvaluationLauncher.probe === undefined ? {} : { probe: platformEvaluationLauncher.probe }),
    plan: (view, paths, attempt) => platformEvaluationLauncher.plan(view, paths, attempt),
  };

  const baselineRunnerSource = extractInlineRunnerSource(
    baselineLauncher,
    "prediction-v1-baseline",
    predictionProfile,
  );
  const baselineDigest = sha256Hex(new TextEncoder().encode(baselineRunnerSource));
  const sampleDigest = sha256Hex(new TextEncoder().encode(
    extractInlineRunnerSource(sampleLauncher, SAMPLE_UNIFORM_LAUNCHER_ID, predictionProfile),
  ));
  const repositoryWorkDigest = sha256Hex(new TextEncoder().encode(
    extractInlineRunnerSource(repositoryWorkLauncher, SAMPLE_REPOSITORY_WORK_LAUNCHER_ID, repositoryWorkProfile),
  ));

  const launcherDeployments: Record<string, LocalLauncherDeployment> = {
    [baselineLauncher.id]: {
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
    [repositoryWorkLauncher.id]: {
      executable: { path: process.execPath, digest: repositoryWorkDigest },
      async probe() {
        return {
          ready: true,
          executable: { path: process.execPath, digest: repositoryWorkDigest },
          harnessVersions: [SOLVE_HARNESS_PINS["sample-repository-work"].version],
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
  if (demo1ClaudeLauncher !== undefined && options.demo1ClaudeRuntime !== undefined) {
    const runtime = options.demo1ClaudeRuntime;
    launcherDeployments[demo1ClaudeLauncher.id] = {
      executable: runtime.executable,
      probe: () => runtime.probe(),
    };
  }
  if (inspectLauncher !== undefined && inspectSelection !== undefined && inspectHost !== undefined) {
    const selectionManifestSha256 = options.evaluationRuntime!.selectionManifestSha256;
    const executable = inspectHost.kind === "oci"
      ? {
        path: process.execPath,
        digest: inspectSelection.runtime.execution!.runtimeHostSourceSha256,
      }
      : {
        path: inspectHost.pythonPath,
        digest: inspectSelection.runtime.pythonExecutableSha256,
      };
    launcherDeployments[inspectLauncher.id] = {
      executable,
      async probe() {
        await assertInspectSelectionUndrifted(runtimeBindingWorkspaceDir, selectionManifestSha256);
        if (inspectHost.kind === "oci") {
          await assertInspectOciBrokerReady(
            inspectHost,
            inspectSelection,
            options.inspectHostConnectionDescriptor,
          );
        }
        return {
          ready: true,
          executable,
          harnessVersions: [inspectSelection.runtime.inspectVersion],
          models: inspectSelection.arms.map((arm) => arm.model),
        };
      },
    };
  }
  if (harborLauncher !== undefined && harborSelection !== undefined && harborHost !== undefined) {
    launcherDeployments[HARBOR_LAUNCHER_ID] = {
      executable: { path: harborHost.executable, digest: harborSelection.harbor.executableSha256 },
      async probe() {
        const ready = await harborLauncher.probe?.();
        return {
          ready: ready?.ready ?? false,
          ...(ready?.detail === undefined ? {} : { detail: ready.detail }),
          executable: { path: harborHost.executable, digest: harborSelection.harbor.executableSha256 },
          harnessVersions: [harborSelection.harbor.version],
          models: harborSelection.arms.map((arm) => arm.model.id),
        };
      },
    };
  }

  const isolationPosture = deriveVenueIsolationPosture([
    VENUE_ISOLATION_POLICY,
    ...(inspectHost?.kind === "oci" ? [INSPECT_OCI_ISOLATION_POLICY] : []),
  ]);
  const provisionerCapabilities: ProvisionerCapabilities = {
    taskProfiles: [
      PREDICTION_FORECAST_PROFILE_URI,
      EVALUATION_TASK_PROFILE_URI,
      REPOSITORY_WORK_PROFILE_URI,
      ...(inspectProfile === undefined ? [] : [INSPECT_TASK_PROFILE_URI]),
      ...(harborSelection === undefined ? [] : [PREDICTION_FORECAST_PROFILE_URI, REPOSITORY_WORK_PROFILE_URI]),
    ],
    workspaceKinds: ["dir", "worktree"],
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: [
      "application/json",
      "application/vnd.in-toto+json",
      "text/x-diff",
      "text/markdown",
      ...(inspectProfile === undefined ? [] : [INSPECT_NATIVE_LOG_MEDIA_TYPE, INSPECT_SUMMARY_MEDIA_TYPE]),
    ],
    isolation: isolationPosture.provisionerCapabilities,
  };

  const backend = makeLocalTaskExecutionBackend({
    stateRoot: join(workspaceDir, "venue", "backend-state"),
    source: "urn:jinn:benchmark-product:local-venue",
    executor: "urn:jinn:benchmark-product:local-venue:executor",
    profileStore,
    resolveTaskProfile: resolveTaskProfileFor(
      predictionProfile,
      evaluationProfile,
      repositoryWorkProfile,
      inspectProfile,
    ),
    launchers: [
      baselineLauncher,
      sampleLauncher,
      repositoryWorkLauncher,
      ...(demo1ClaudeLauncher === undefined ? [] : [demo1ClaudeLauncher]),
      evaluationLauncher,
      ...(inspectLauncher === undefined ? [] : [inspectLauncher]),
      ...(harborLauncher === undefined ? [] : [harborLauncher]),
    ],
    launcherDeployments,
    provisioner,
    provisionerCapabilities,
    now: options.now,
  });

  async function prepareEvaluationCell(input: EvaluationCellInput): Promise<PreparedEvaluationCell> {
    const verifiedSubject = verifyEvaluationSubject({
      taskBytes: input.subjectTaskBytes,
      deliveryBytes: input.subjectDeliveryBytes,
      results: input.resultArtifacts,
    });
    const subjectTaskDigest = `sha256:${sha256Hex(input.subjectTaskBytes)}` as const;
    const subjectDeliveryDigest = `sha256:${sha256Hex(input.subjectDeliveryBytes)}` as const;
    const evaluationSpecDigest = `sha256:${sha256Hex(input.evaluationSpecBytes)}` as const;
    if (verifiedSubject.evaluationSpecification.digest !== evaluationSpecDigest) {
      return refuse(
        "record-integrity",
        "evaluationSpecBytes",
        `subject Task binds ${verifiedSubject.evaluationSpecification.digest}, not ${evaluationSpecDigest}`,
      );
    }
    const evaluationSpec: EvaluationSpec = parseEvaluationSpec(input.evaluationSpecBytes);
    if (evaluationSpec.family !== "deterministic-process") {
      return refuse("validation", "evaluationSpecBytes", "local venue requires deterministic-process evaluation");
    }
    const familyBlock = evaluationSpec.familyBlock as DeterministicProcessBlock & Record<string, unknown>;
    const parserKey = parserAllowlistKey(familyBlock.parser);
    const adapterKind: EvaluationAdapterKind = parserKey === parserAllowlistKey(PREDICTION_PARSER)
      ? "prediction"
      : parserKey === parserAllowlistKey(SWE_REBENCH_PARSER)
        ? "swe-rebench"
        : inspectVerifier !== undefined && parserKey === inspectVerifier.parserAllowlistKey
          ? "inspect-log-verifier"
          : refuse(
            "validation",
            "evaluationSpecBytes.familyBlock.parser",
            `local venue has no evaluator registration for parser ${familyBlock.parser.id}`,
          );

    let evaluationContextBytes: Uint8Array;
    if (adapterKind === "prediction") {
      const subjectTaskDocument = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(input.subjectTaskBytes),
      ) as { readonly payload?: { readonly forecast?: unknown } };
      const forecast = subjectTaskDocument.payload?.forecast;
      if (!isSampleForecastPayload(forecast)) {
        return refuse(
          "validation",
          "subjectTaskBytes",
          "prediction EvaluationSpec requires a recognizable payload.forecast",
        );
      }
      evaluationContextBytes = new TextEncoder().encode(JSON.stringify(deriveSampleResolution(forecast)));
    } else if (adapterKind === "swe-rebench") {
      const declaredNetwork = familyBlock[SWE_REBENCH_PUBLIC_NETWORK_EXTENSION];
      if (declaredNetwork !== undefined && declaredNetwork !== true) {
        return refuse(
          "validation",
          `evaluationSpecBytes.familyBlock.${SWE_REBENCH_PUBLIC_NETWORK_EXTENSION}`,
          "public-network extension must be exactly true when present",
        );
      }
      if (declaredNetwork === true && !sweRebenchGrader.allowPublicNetwork) {
        return refuse(
          "execution",
          `evaluationSpecBytes.familyBlock.${SWE_REBENCH_PUBLIC_NETWORK_EXTENSION}`,
          "sealed grader network request requires an explicit host allowPublicNetwork opt-in",
        );
      }
      const pinnedImage = pinnedSweRebenchImage(evaluationSpec);
      await ensurePinnedOciImage({
        runtime: sweRebenchGrader.runtime,
        ...pinnedImage,
      }, sweRebenchGrader.dockerPath === undefined ? {} : { dockerPath: sweRebenchGrader.dockerPath });
      // The OCI source consumes the exact subject and EvaluationSpec; it deliberately has no
      // fixture-controlled context port. Keep the generic provisioner's required context file
      // present but semantically empty.
      evaluationContextBytes = new TextEncoder().encode("{}");
    } else {
      const resultNames = input.resultArtifacts.map((artifact) => artifact.name).sort();
      if (resultNames.length !== 2 || resultNames[0] !== "inspect-log" || resultNames[1] !== "inspect-summary") {
        return refuse(
          "validation",
          "resultArtifacts",
          "Inspect log verification requires exactly inspect-log and inspect-summary solve outputs",
        );
      }
      evaluationContextBytes = new TextEncoder().encode("{}");
    }

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
    evaluationSpecKinds.set(evaluationSpecDigest, adapterKind);

    return { taskBytes: derived.bytes, taskSha256 };
  }

  return {
    backend,
    assertRunOwnership() {
      backend.assertStateRootOwnership();
    },
    async preflightRun() {
      const preflight = await backend.preflight({});
      if (!preflight.ready) {
        throw new Error(preflight.detail ?? preflight.error?.message ?? "local venue is not ready");
      }
    },
    verdictKeyId: evaluators[0]!.keyId,
    evaluators: evaluators.map(({ id, keyId }) => ({ id, keyId })),
    evaluationMode: inspectSelection === undefined || inspectEvaluationStrategy === "separate-log-verification"
      ? "separate"
      : "embedded",
    ...(inspectSelection === undefined || inspectEvaluationStrategy !== "embedded"
      ? {}
      : {
        interpretEmbeddedEvaluation(
          artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[],
        ) {
          const summaryArtifact = artifacts.find((artifact) => artifact.name === "inspect-summary");
          if (summaryArtifact === undefined) {
            return { kind: "could-not-grade" as const, detail: "Inspect summary artifact is absent" };
          }
          let rawSummary: unknown;
          try {
            rawSummary = JSON.parse(
              new TextDecoder("utf8", { fatal: true }).decode(summaryArtifact.bytes),
            );
          } catch {
            return { kind: "could-not-grade" as const, detail: "Inspect summary artifact is invalid" };
          }
          const parsedSummary = InspectCellSummarySchema.safeParse(rawSummary);
          if (!parsedSummary.success) {
            return { kind: "could-not-grade" as const, detail: "Inspect summary artifact is invalid" };
          }
          const summary = parsedSummary.data;
          if (summary.terminal !== "scored") {
            const providerDetail = summary.provider?.terminalStatus !== undefined
              ? `; provider ${summary.provider.terminalStatus}`
              : "";
            return {
              kind: "could-not-grade" as const,
              detail: `Inspect execution was unscorable (${String(summary.inspectStatus ?? "unknown")}${providerDetail})`,
            };
          }
          const verdict = artifacts.find((artifact) => artifact.name === "verdict");
          if (verdict === undefined) {
            return {
              kind: "could-not-grade" as const,
              detail: "Inspect scored execution has no attributable verdict",
            };
          }
          return {
            kind: "verdict" as const,
            evaluatorId: INSPECT_EMBEDDED_EVALUATOR_ID,
            verdictBytes: verdict.bytes,
          };
        },
      }),
    prepareEvaluationCell,
    async shutdown() {
      await backend.shutdown();
    },
  };
}
