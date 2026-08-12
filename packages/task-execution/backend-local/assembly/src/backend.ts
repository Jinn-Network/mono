// SPDX-License-Identifier: Apache-2.0

import {
  constants,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fsyncBestEffortSync } from "@jinn-network/task-execution-supervisor";
import type {
  AttemptUri,
  BackendCapabilities,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  PreflightReport,
  PreflightRequest,
  ReconciliationReport,
  SubmissionAck,
  SubmissionUri,
  TaskExecutionBackend,
  TwoPartyEngagement,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type {
  LaunchPlan,
  LauncherContract,
  ProbeResult,
  ResultEnvelope,
  HostSecretForwardDeclaration,
} from "@jinn-network/task-execution-launchers";
import { interpretResult } from "@jinn-network/task-execution-launchers";
import { selectProfileSafeLauncher } from "@jinn-network/task-execution-launchers";
import {
  ProfilesError,
  resolveProfile,
  type ProfileStore,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import type {
  AttemptDescriptor,
  ComparisonClass,
  DispatchContext,
  JsonValue,
  ProtocolObservation,
  SubmissionRecord,
  TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import {
  documentDigest,
  foldObservations,
  isValidUrnUuid,
  mergeRequirements,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
  sha256Hex,
  validateDelivery,
  validateDispatchContext,
  validateSubmission,
  validateTask,
} from "@jinn-network/task-execution-protocol";
import type {
  AttemptIdentity,
  JournalEvent,
  OutcomeFile,
  SpawnRequest,
} from "@jinn-network/task-execution-supervisor";
import {
  foldAttemptRecord,
  heartbeatIsStale,
  listProcessGroupPids,
  openAttemptJournal,
  openSubmissionSegment,
  probeShimAlive,
  readHeartbeat,
  readShimCancellationResult,
  readOutcome,
  readShimFingerprint,
  reconcileAttempt,
  requestShimCancellation,
  spawnShim,
  nativeCustodySupport,
  writeShimCancellationCommand,
} from "@jinn-network/task-execution-supervisor";
import type {
  CapabilityGrant,
  HarvestResult,
  ProvisionerContract,
  TaskView,
  WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import { ProvisioningRejectedError } from "@jinn-network/task-execution-workspace";
// #2538 F5: the two backend-written stdio capture filenames — one source, shared with the harvest
// that deliberately excludes them from the Delivery's `outputs`.
import {
  HARNESS_STDERR_LOG,
  HARNESS_STDOUT_LOG,
} from "@jinn-network/task-execution-workspace";
import {
  acquireStateRootWriter,
  CapacityGate,
  type StateRootWriter,
} from "./capacity.js";
import {
  assembleCapabilities,
  type CapabilityProvisionerConfig,
  type DeliverySigningKey,
  type RecorderAvailability,
  type TrustKeyConfig,
} from "./capabilities.js";
import { projectObservations } from "./observation.js";
import {
  createEvidenceJoin,
  type EvidenceBindingPorts,
  type EvidenceCaptureSession,
} from "./evidence-join.js";
import { materializeSecretForwards, type SecretForwardResolver } from "./secret-forwards.js";
import { materializeHostSecretForwards, type HostSecretResolver } from "./host-secret-forwards.js";
import { type LocalLauncherDeployment, verifyRunPinning } from "./pinning.js";
import { ObservationWatchRegistry } from "./watch-registry.js";

// Core requirement comparison classes (profiles §5.1 / program §7.3). Profile-added entries
// are overlaid after resolution, so the resolved document is authoritative for its own keys.
const CORE_REQUIREMENT_CLASSES: Readonly<Record<string, ComparisonClass>> = {
  maxAttemptDurationMs: "ceiling",
  maxTokens: "ceiling",
  maxCost: "ceiling",
  isolation: "exact",
  networkPolicy: "exact",
  evidenceCapture: "exact",
  harness: "exact",
  model: "constraint",
  loadout: "exact",
  isolationPolicy: "exact",
};

const SCOPE_DELIMITER = "\u001f";
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * How much captured stderr rides along in the terminal observation's `detail`. The observation
 * schema bounds free text at 4096 characters and the reason code shares the field, so this stays
 * well inside it; `logs/harness.stderr.log` holds the untruncated stream either way.
 */
const TERMINAL_DETAIL_STDERR_BUDGET = 1024;

/**
 * The tail of a captured harness log, whitespace-collapsed to one line so it can ride in a
 * bounded observation `detail`. Absent or unreadable is not an error: this is a diagnostic, and
 * an unreadable diagnostic must never change an attempt's outcome.
 */
export function harnessLogTail(path: string, budget = TERMINAL_DETAIL_STDERR_BUDGET): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= budget ? collapsed : `…${collapsed.slice(-budget)}`;
}

function scopeKey(requester: string, key: string): string {
  return `${requester}${SCOPE_DELIMITER}${key}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(bytes));
}

function detail(errors: readonly { readonly path: string; readonly message: string }[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function directoryKey(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

function validProvisionerId(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function monotonicNowNs(): bigint {
  return process.hrtime.bigint();
}

function monotonicClockIdentity(): string | undefined {
  try {
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (process.platform === "darwin") {
      const boot = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
      return boot.length === 0 ? undefined : `darwin:${boot}`;
    }
  } catch {
    // A platform without a durable boot identity cannot safely re-arm a relative duration.
  }
  return undefined;
}

function positiveSafeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface ShimOutcomeResult {
  readonly exitCode?: number;
  readonly signal?: string;
}

function shimOutcomeResult(outcome: OutcomeFile): ShimOutcomeResult {
  return {
    ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    ...(outcome.termSignal === null ? {} : { signal: outcome.termSignal }),
  };
}

/**
 * Resolves the wait once the shim has been observed dead. The liveness probe races the shim's
 * own final moments: it can write `outcome.json` and `exit(0)` between the poll's outcome read
 * and the probe that follows it, so the earlier miss is not by itself evidence that nothing was
 * delivered. Re-read before concluding — only a miss that survives the death observation proves
 * the shim exited without recording an outcome. Exported for direct coverage of this branch.
 */
export function resolveOutcomeAfterShimDeath(meta: string, nonce: string): ShimOutcomeResult {
  const outcome = readOutcome(meta, nonce);
  if (outcome === null) throw new Error("shim exited without a nonce-matching outcome");
  return shimOutcomeResult(outcome);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validSecretForwardTarget(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")
    && nonEmptyString(value);
}

function declaredSecretForwards(plan: LaunchPlan): readonly { readonly grantKey: string; readonly target: string }[] {
  return plan.secretForwards ?? [];
}

function validateSecretForwardPlan(
  launcher: LauncherContract,
  plan: LaunchPlan,
): readonly { readonly grantKey: string; readonly target: string }[] {
  const declared = launcher.capabilities().secretForwards;
  const planned = declaredSecretForwards(plan);
  if (
    declared.length !== planned.length
    || declared.some((forward, index) =>
      forward.grantKey !== planned[index]?.grantKey || forward.target !== planned[index]?.target)
  ) {
    throw new Error("LaunchPlan secret forwards must exactly match the launcher capability declaration");
  }
  const targets = new Set<string>();
  const grantKeys = new Set<string>();
  for (const forward of declared) {
    if (
      !nonEmptyString(forward.grantKey)
      || !validSecretForwardTarget(forward.target)
      || targets.has(forward.target)
      || grantKeys.has(forward.grantKey)
    ) {
      throw new Error("launcher secret forward declarations are invalid");
    }
    targets.add(forward.target);
    grantKeys.add(forward.grantKey);
  }
  for (const value of Object.values(plan.env)) {
    if (!value.startsWith("secrets/")) continue;
    const target = value.slice("secrets/".length);
    if (declared.filter((forward) => forward.target === target).length !== 1) {
      throw new Error("launch environment secret reference has no declared secret forward");
    }
  }
  return planned;
}

function declaredHostSecretForwards(plan: LaunchPlan): readonly HostSecretForwardDeclaration[] {
  return plan.hostSecretForwards ?? [];
}

function validateHostSecretForwardPlan(
  launcher: LauncherContract,
  plan: LaunchPlan,
): readonly HostSecretForwardDeclaration[] {
  const declared = launcher.capabilities().hostSecretForwards ?? [];
  const planned = declaredHostSecretForwards(plan);
  if (
    declared.length !== planned.length
    || declared.some((forward, index) => {
      const candidate = planned[index];
      return candidate === undefined
        || forward.handle !== candidate.handle
        || forward.target !== candidate.target
        || forward.role !== candidate.role
        || forward.evaluator !== candidate.evaluator
        || forward.registrationId !== candidate.registrationId
        || forward.evaluationMethodDigest !== candidate.evaluationMethodDigest;
    })
  ) throw new Error("LaunchPlan host secret forwards must exactly match the launcher capability declaration");
  const handles = new Set<string>();
  const targets = new Set<string>();
  for (const forward of declared) {
    if (
      !validSecretForwardTarget(forward.handle)
      || !validSecretForwardTarget(forward.target)
      || forward.role !== "evaluator"
      || !nonEmptyString(forward.evaluator)
      || !nonEmptyString(forward.registrationId)
      || !/^sha256:[0-9a-f]{64}$/u.test(forward.evaluationMethodDigest)
      || handles.has(forward.handle)
      || targets.has(forward.target)
    ) throw new Error("launcher host secret declarations are invalid");
    handles.add(forward.handle);
    targets.add(forward.target);
  }
  return planned;
}

function parseLaunchPlan(value: unknown): LaunchPlan {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ["argv", "env", "cwd", "validExitCodes", "resultContract", "interruptionBehavior"],
    ["blameExitCodes", "secretForwards", "hostSecretForwards"],
  )) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan has missing or unknown fields",
    });
  }
  const argv = value.argv;
  const env = value.env;
  const validExitCodes = value.validExitCodes;
  const resultContract = value.resultContract;
  if (
    !Array.isArray(argv)
    || argv.length === 0
    || !nonEmptyString(argv[0])
    || !argv.every((entry) => typeof entry === "string" && !entry.includes("\u0000"))
    || !isRecord(env)
    || !Object.entries(env).every(
      ([key, entry]) => nonEmptyString(key) && !key.includes("=")
        && typeof entry === "string" && !entry.includes("\u0000"),
    )
    || !nonEmptyString(value.cwd)
    || !Array.isArray(validExitCodes)
    || validExitCodes.length === 0
    || new Set(validExitCodes).size !== validExitCodes.length
    || !validExitCodes.every(
      (entry) => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255,
    )
    || !["repeatable", "recoverable", "nonrepeatable"].includes(
      String(value.interruptionBehavior),
    )
  ) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan invocation fields are structurally invalid",
    });
  }
  if (!isRecord(resultContract) || !hasOnlyKeys(
    resultContract,
    ["envelopeFormat"],
    ["outputSchemaFlag", "structuredOutputArtifact", "correlationFields"],
  ) || !nonEmptyString(resultContract.envelopeFormat)) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan result contract is structurally invalid",
    });
  }
  for (const field of ["outputSchemaFlag", "structuredOutputArtifact"] as const) {
    const entry = resultContract[field];
    if (entry !== undefined && !nonEmptyString(entry)) {
      throw new TaskExecutionError("invalid-document", {
        detail: `journaled LaunchPlan resultContract.${field} is invalid`,
      });
    }
  }
  const correlationFields = resultContract.correlationFields;
  if (correlationFields !== undefined && (
    !Array.isArray(correlationFields)
    || new Set(correlationFields).size !== correlationFields.length
    || !correlationFields.every((entry) =>
      ["harnessVersion", "capabilities", "sessionId"].includes(String(entry)))
  )) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan correlation fields are structurally invalid",
    });
  }
  const blameExitCodes = value.blameExitCodes;
  if (blameExitCodes !== undefined && (
    !Array.isArray(blameExitCodes)
    || !blameExitCodes.every((candidate) => {
      if (!isRecord(candidate) || !hasOnlyKeys(
        candidate,
        ["match", "blame", "reasonCode"],
      ) || !isRecord(candidate.match) || !hasOnlyKeys(
        candidate.match,
        [],
        ["exitCode", "signal"],
      )) return false;
      const { exitCode, signal } = candidate.match;
      const hasMatch = exitCode !== undefined || signal !== undefined;
      return hasMatch
        && (exitCode === undefined
          || (Number.isSafeInteger(exitCode) && Number(exitCode) >= 0 && Number(exitCode) <= 255))
        && (signal === undefined || nonEmptyString(signal))
        && (candidate.blame === "task" || candidate.blame === "infrastructure")
        && nonEmptyString(candidate.reasonCode);
    })
  )) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan blame rules are structurally invalid",
    });
  }
  const secretForwards = value.secretForwards;
  if (secretForwards !== undefined) {
    if (!Array.isArray(secretForwards) || !secretForwards.every((candidate) =>
      isRecord(candidate)
      && hasOnlyKeys(candidate, ["grantKey", "target"])
      && nonEmptyString(candidate.grantKey)
      && nonEmptyString(candidate.target)
      && validSecretForwardTarget(candidate.target))
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "journaled LaunchPlan secret forwards are structurally invalid",
      });
    }
    const grantKeys = secretForwards.map((candidate) => candidate.grantKey);
    const targets = secretForwards.map((candidate) => candidate.target);
    if (new Set(grantKeys).size !== grantKeys.length || new Set(targets).size !== targets.length) {
      throw new TaskExecutionError("invalid-document", {
        detail: "journaled LaunchPlan secret forwards are not unique",
      });
    }
  }
  const hostSecretForwards = value.hostSecretForwards;
  if (hostSecretForwards !== undefined) {
    if (!Array.isArray(hostSecretForwards) || !hostSecretForwards.every((candidate) =>
      isRecord(candidate)
      && hasOnlyKeys(candidate, [
        "handle", "target", "role", "evaluator", "registrationId", "evaluationMethodDigest",
      ])
      && validSecretForwardTarget(String(candidate.handle))
      && validSecretForwardTarget(String(candidate.target))
      && candidate.role === "evaluator"
      && nonEmptyString(candidate.evaluator)
      && nonEmptyString(candidate.registrationId)
      && typeof candidate.evaluationMethodDigest === "string"
      && /^sha256:[0-9a-f]{64}$/u.test(candidate.evaluationMethodDigest))
    ) throw new TaskExecutionError("invalid-document", {
      detail: "journaled LaunchPlan host secret forwards are structurally invalid",
    });
    const handles = hostSecretForwards.map((candidate) => candidate.handle);
    const targets = hostSecretForwards.map((candidate) => candidate.target);
    if (new Set(handles).size !== handles.length || new Set(targets).size !== targets.length) {
      throw new TaskExecutionError("invalid-document", {
        detail: "journaled LaunchPlan host secret forwards are not unique",
      });
    }
  }
  return value as unknown as LaunchPlan;
}

function parseHarvestResult(event: JournalEvent): HarvestResult {
  const manifest = event.details["manifest"];
  const omissions = event.details["omissions"];
  const integrityViolations = event.details["integrityViolations"];
  const digest = /^sha256:[0-9a-f]{64}$/u;
  if (
    !Array.isArray(manifest)
    || !Array.isArray(omissions)
    || !Array.isArray(integrityViolations)
    || !manifest.every((candidate) =>
      isRecord(candidate)
      && hasOnlyKeys(candidate, ["path", "sizeBytes", "sha256"], ["mediaType"])
      && nonEmptyString(candidate.path)
      && Number.isSafeInteger(candidate.sizeBytes)
      && Number(candidate.sizeBytes) >= 0
      && typeof candidate.sha256 === "string"
      && digest.test(candidate.sha256)
      && (candidate.mediaType === undefined || nonEmptyString(candidate.mediaType)))
    || !omissions.every(nonEmptyString)
    || !integrityViolations.every((candidate) =>
      isRecord(candidate)
      && hasOnlyKeys(candidate, ["path", "reason"])
      && nonEmptyString(candidate.path)
      && nonEmptyString(candidate.reason))
  ) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled harvest result is structurally invalid",
    });
  }
  const paths = manifest.map((candidate) => candidate.path);
  if (new Set(paths).size !== paths.length || new Set(omissions).size !== omissions.length) {
    throw new TaskExecutionError("invalid-document", {
      detail: "journaled harvest result contains duplicate paths",
    });
  }
  return {
    manifest: manifest as unknown as HarvestResult["manifest"],
    omissions,
    integrityViolations: integrityViolations as unknown as HarvestResult["integrityViolations"],
  };
}

function requestedInventoryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  if (typeof record.id === "string") return record.id;
  if (typeof record.kind === "string") return record.kind;
  return undefined;
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncBestEffortSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directoryFd = openSync(directory, "r");
  try {
    fsyncBestEffortSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function errorCategory(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof ProfilesError) {
    return new TaskExecutionError(error.code, { detail: error.message });
  }
  return new TaskExecutionError("backend-unavailable", {
    detail: error instanceof Error ? error.message : "local backend operation failed",
  });
}

export interface ProvisionerCapabilities extends CapabilityProvisionerConfig {}

export interface LocalProvisionerInput {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly submission: SubmissionRecord;
  readonly attempt: AttemptIdentity;
}

/** Durable selector result: recovery replays this identity, never heuristically picks a provisioner. */
export interface SelectedProvisioner {
  readonly id: string;
  readonly contract: ProvisionerContract;
}

export interface LocalBackendFaults {
  /** Test-only crash injection after the Delivery checkpoint is durable but before its event. */
  readonly afterDeliveryCheckpoint?: () => void;
  /** Test-only restart boundary injection; production compositions leave this absent. */
  readonly onCompletionPhase?: (
    phase:
      | "before-outcome-wait"
      | "after-outcome"
      | "before-harvest"
      | "after-harvest"
      | "after-evidence"
      | "before-delivery-checkpoint",
  ) => void | Promise<void>;
}

export interface LocalTaskExecutionBackendConfig {
  readonly stateRoot: string;
  readonly source: string;
  readonly executor: string;
  readonly profileStore: ProfileStore;
  readonly resolveTaskProfile?: (
    descriptor: TaskSpecification["profile"],
  ) => TaskProfileDocument;
  readonly launchers: readonly LauncherContract[];
  /** Deployment-owned executable identities and launcher-specific pin/readiness probes. */
  readonly launcherDeployments?: Readonly<Record<string, LocalLauncherDeployment>>;
  readonly provisioner: (input: LocalProvisionerInput) => SelectedProvisioner;
  readonly provisionerCapabilities: ProvisionerCapabilities;
  readonly maxConcurrentAttempts?: number;
  readonly recorderAvailability?: RecorderAvailability;
  readonly trustKeys?: TrustKeyConfig;
  readonly evidence?: EvidenceBindingPorts;
  readonly capabilityGrants?: (
    grants: Readonly<Record<string, unknown>>,
  ) => readonly CapabilityGrant[];
  readonly secretForwardResolver?: SecretForwardResolver;
  /** Deployment-owned authority, isolated from requester capability grants. */
  readonly hostSecretResolver?: HostSecretResolver;
  readonly cancellationGraceMs?: number;
  readonly cancellationKillPollCeilingMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => string;
  readonly faults?: LocalBackendFaults;
  /**
   * Host-supplied namespaced Delivery extensions (TEP §21.3). Keys must be absolute URIs; the
   * backend adds no semantics of its own. Used by the operator runtime's bridge era only.
   */
  readonly deliveryExtensions?: (input: {
    readonly attempt: AttemptUri;
    readonly harvest: HarvestResult;
    readonly task: TaskSpecification;
    /**
     * The workKind noted for this attempt via `LocalTaskExecutionBackend.noteAttemptWorkKind`
     * (cutover stage 1, C7 workKind seam / finding E24) -- `undefined` when the host never noted
     * one for this attempt (including every caller that predates this field).
     */
    readonly workKind?: string;
    /**
     * The today-generation marketplace requestId noted alongside `workKind`, when the caller had
     * one (absent for revised-generation attempts, which mint no requestId, or when never noted).
     */
    readonly requestId?: `0x${string}`;
  }) => Readonly<Record<string, JsonValue>>;
}

interface StoredSubmission {
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly parsed: SubmissionRecord;
  readonly taskDigest: `sha256:${string}`;
  readonly attempt: AttemptUri;
}

interface AttemptMeta {
  readonly attempt: AttemptUri;
  readonly task: `sha256:${string}`;
  readonly submission: SubmissionUri;
  readonly effectiveDeadline: string;
  readonly maxAttemptDurationMs?: number;
  readonly execStartedAtMonotonicNs?: string;
  readonly monotonicClockIdentity?: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

interface PersistedSubmission {
  readonly digest: `sha256:${string}`;
  readonly taskDigest: `sha256:${string}`;
  readonly attempt: AttemptUri;
  readonly submission: SubmissionUri;
  readonly requester: string;
  readonly idempotencyKey: string;
}

interface PersistedAttempt extends AttemptMeta {}

function asAttemptUri(value: string): AttemptUri {
  return value as AttemptUri;
}

function asSubmissionUri(value: string): SubmissionUri {
  return value as SubmissionUri;
}

// ── Finding E31: real executor delivery signing ─────────────────────────────────────────────
//
// `completeAttempt` seals a Delivery's bytes exactly once (unchanged); when a delivery-signing
// key is configured it then produces a DSSE envelope over those EXACT sealed bytes (TEP §9.1
// seal-once; `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5 "Sealed once,
// forever" -- canonicalize once at seal time, those bytes are the document forever). The
// coordinator's ruling on this finding is explicit: no re-sealing, no
// re-canonicalizing. An earlier proposal would have embedded the signature as a reserved Delivery
// field (seal minus the field, sign, merge the signature in, seal again) -- rejected, because an
// embedded field cannot cover its own bytes without that second seal pass, which IS
// re-canonicalization. The envelope is therefore carried OUTSIDE the Delivery document entirely,
// retrievable via `getDeliverySignature(digest)` keyed by the Delivery's own digest -- the only
// identity `@jinn-network/marketplace-binding`'s `SettlementGradeVerificationInput` carries across
// that package boundary (see `client/src/daemon/settlement-grade.ts`, the consumer this exists
// for).

/** The DSSE envelope's `payloadType` for the executor-binding signature (finding E31). Mirrors
 * `client/src/daemon/settlement-grade.ts`'s `EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE` constant --
 * duplicated, not imported, because this package has no dependency on the client or on
 * `@jinn-network/trust-core` (see below); the two literals must stay byte-identical. */
const EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE =
  "application/vnd.jinn.marketplace.executor-binding.v1+json";

/**
 * DSSE v1 pre-authentication encoding (PAE) -- the bytes actually signed. Ported verbatim from
 * `@jinn-network/trust-core`'s `dssePreAuthEncoding` (`packages/trust/core/src/dsse.ts`, itself
 * ported from `packages/evidence/protocol/src/claims.ts`). This package has no dependency on
 * trust-core -- adding one is a `package.json` edit outside this task's write scope -- so this
 * four-line, spec-frozen byte layout is duplicated rather than imported, following the same
 * cross-boundary-duplication precedent `settlement-grade.ts`'s own `idempotencyKeyFor` already
 * uses. `client/test/daemon/settlement-grade.ts` proves this copy round-trips against the real
 * trust-core functions.
 */
function dssePreAuthEncoding(payloadType: string, payloadBytes: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(payloadType);
  const head = new TextEncoder().encode(`DSSEv1 ${typeBytes.length} `);
  const mid = new TextEncoder().encode(` ${payloadBytes.length} `);
  const bytes = new Uint8Array(head.length + typeBytes.length + mid.length + payloadBytes.length);
  let offset = 0;
  for (const part of [head, typeBytes, mid, payloadBytes]) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Signs the Delivery's own already-sealed bytes and wraps the result in a DSSE envelope (a JSON
 * object `{payload, payloadType, signatures}`, matching `@jinn-network/trust-core`'s
 * `DsseEnvelope` shape exactly). `deliveryBytes` is passed through untouched as the envelope's
 * `payload` -- seal-once: it is never re-encoded, re-ordered, or re-canonicalized here.
 *
 * The ENVELOPE's own encoding is RFC 8785 JCS (sorted keys, compact separators) via
 * `serializeCanonicalJson` -- the same sealer every other canonical byte production in this
 * file already uses -- byte-identical to what trust-core's `sealDsseEnvelope` emits. That is
 * load-bearing, not cosmetic (defect #34): the authority-bearing consumer of
 * these bytes is `parseExactDsseEnvelope` (reached via the client's `verifyNativeDsse` ->
 * `client/src/evaluator/native-subject-authority.ts`), which accepts ONLY the sole producer
 * encoding and rejects every alternate spelling by reconstructing through `sealDsseEnvelope`
 * and comparing bytes. This previously emitted plain `JSON.stringify` in `payloadType, payload,
 * signatures` insertion order -- structurally fine under the LOOSE `parseDsseEnvelope` the
 * settlement-grade checker uses (so the producing operator's own side passed), but refused by
 * the strict cross-operator parse, surfacing as `envelope-signature-invalid` even though the
 * Ed25519 signature was perfectly valid. Loosening the strict parser would be the wrong repair;
 * its fail-closed strictness is the design.
 *
 * `serializeCanonicalJson` is the protocol package's own JCS re-implementation (Global
 * Constraints -- never a shared runtime dep with trust-core), the same
 * cross-boundary-duplication precedent `dssePreAuthEncoding` above already follows. Both sort
 * keys with an identical `compareCodeUnitStrings` and emit compact separators, so for this
 * envelope's flat all-string shape the two serializers agree byte-for-byte;
 * `backend.evidence.test.ts` pins the exact bytes against an independently hand-sorted
 * expectation, and `client/test/daemon/settlement-grade.test.ts` round-trips these production
 * bytes through the real `parseExactDsseEnvelope`/`verifyNativeDsse` path.
 */
function sealExecutorBindingEnvelope(
  deliveryBytes: Uint8Array,
  key: DeliverySigningKey,
): Uint8Array {
  const preAuthEncoding = dssePreAuthEncoding(EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE, deliveryBytes);
  const signature = key.sign(preAuthEncoding);
  const envelope = {
    payloadType: EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(deliveryBytes).toString("base64"),
    signatures: [{ keyid: key.keyId, sig: Buffer.from(signature).toString("base64") }],
  };
  return serializeCanonicalJson(envelope as unknown as JsonValue);
}

/**
 * The reference local backend. The three conformance-driving methods (`drive`,
 * `recordDelivery`, `simulateReconciliation`) are explicit implementation seams used by the
 * unchanged Layer-2 kit; applications consume this value only as `TaskExecutionBackend`.
 */
export class LocalTaskExecutionBackend implements TaskExecutionBackend {
  private readonly writer: StateRootWriter;
  private readonly capacity: CapacityGate;
  private readonly submissionsByScope = new Map<string, StoredSubmission>();
  private readonly submissionsByUri = new Map<SubmissionUri, StoredSubmission>();
  private readonly attempts = new Map<AttemptUri, AttemptMeta>();
  private readonly reconciliationOverrides = new Map<string, ReconciliationReport>();
  private readonly workers = new Set<Promise<void>>();
  private readonly workerAttempts = new Map<AttemptUri, number>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly attemptTimers = new Map<AttemptUri, Set<NodeJS.Timeout>>();
  private readonly watchRegistry = new ObservationWatchRegistry();
  /**
   * Host-injected per-attempt bridge context (cutover stage 1, C7 workKind seam / finding E24),
   * read once by `deliveryExtensions` at delivery-sealing time and then discarded. Additive:
   * nothing in this class's own control flow ever populates this map -- a host that never calls
   * `noteAttemptWorkKind` sees byte-identical `deliveryExtensions` input to before this map
   * existed (`workKind`/`requestId` are simply absent from the input object).
   */
  private readonly attemptWorkKinds = new Map<
    AttemptUri,
    { readonly workKind: string; readonly requestId?: `0x${string}` }
  >();
  private closed = false;
  private closeInvoked = false;
  private shutdownStarted = false;
  private shutdownComplete = false;
  private shutdownPromise?: Promise<void>;
  private readonly shutdownDrainFailures: Error[] = [];

  constructor(private readonly config: LocalTaskExecutionBackendConfig) {
    // #36. When capture is on, `createEvidenceJoin` puts `executor` and `source` (as the
    // recording's `producer`) into the evidence graph as two SEPARATE `agent`-kind identities
    // under two differently-named descriptors, and the execution recorder correctly refuses one
    // identity claiming both roles. A composition that passes one IRI twice can therefore never
    // record an attempt -- which stayed latent until the first live run, where it surfaced as an
    // opaque `dependency-unavailable` terminal after the attempt had already been claimed.
    // Refuse the composition instead of every attempt it would go on to start.
    if ((config.recorderAvailability ?? "none") !== "none" && config.source === config.executor) {
      throw new Error(
        "local backend source and executor must be distinct graph identities when evidence capture is enabled",
      );
    }
    this.writer = acquireStateRootWriter(config.stateRoot);
    this.capacity = new CapacityGate(config.maxConcurrentAttempts ?? 4);
    this.rebuildIndexes();
  }

  private now(): string {
    return this.config.now?.() ?? new Date().toISOString();
  }

  private assertWriter(): void {
    if (this.closed || this.shutdownStarted) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: this.shutdownStarted
          ? "local backend instance is shutting down"
          : "local backend instance is closed",
      });
    }
    if (!this.writer.acquired) throw this.writer.error;
  }

  /** Synchronous host seam proving this constructor owns the state-root writer. Unlike
   * `preflight`, this performs no launcher/readiness probes and therefore cannot cross an async
   * response boundary before ownership is known. */
  assertStateRootOwnership(): void {
    this.assertWriter();
  }

  private recordShutdownDrainFailure(error: unknown): void {
    this.shutdownDrainFailures.push(error instanceof Error ? error : new Error(String(error)));
  }

  private trackInflight<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    return promise.finally(() => {
      this.inflight.delete(promise);
    });
  }

  private trackAttemptTimer(attempt: AttemptUri, timer: NodeJS.Timeout): void {
    let timers = this.attemptTimers.get(attempt);
    if (timers === undefined) {
      timers = new Set();
      this.attemptTimers.set(attempt, timers);
    }
    timers.add(timer);
  }

  private clearAttemptTimers(attempt: AttemptUri): void {
    const timers = this.attemptTimers.get(attempt);
    if (timers === undefined) return;
    for (const timer of timers) clearTimeout(timer);
    this.attemptTimers.delete(attempt);
  }

  private clearAllAttemptTimers(): void {
    for (const attempt of [...this.attemptTimers.keys()]) {
      this.clearAttemptTimers(attempt);
    }
  }

  private notifyObservationTail(attempt: AttemptUri): void {
    const observations = this.observations(attempt);
    const latest = observations.at(-1)?.sequence ?? "0000000000000000";
    this.watchRegistry.notify(attempt, latest);
  }

  private async invokeCompletionPhase(
    phase:
      | "before-outcome-wait"
      | "after-outcome"
      | "before-harvest"
      | "after-harvest"
      | "after-evidence"
      | "before-delivery-checkpoint",
  ): Promise<void> {
    const hook = this.config.faults?.onCompletionPhase;
    if (hook === undefined) return;
    try {
      await hook(phase);
    } catch (error) {
      if (this.closeInvoked) {
        this.recordShutdownDrainFailure(error);
        return;
      }
      throw error;
    }
  }

  private workerMayContinue(): boolean {
    return !this.shutdownStarted;
  }

  private trackWorker(attempt: AttemptUri, worker: Promise<void>): void {
    this.workers.add(worker);
    this.workerAttempts.set(attempt, (this.workerAttempts.get(attempt) ?? 0) + 1);
    void worker.finally(() => {
      this.workers.delete(worker);
      const remaining = (this.workerAttempts.get(attempt) ?? 1) - 1;
      if (remaining <= 0) {
        this.workerAttempts.delete(attempt);
      } else {
        this.workerAttempts.set(attempt, remaining);
      }
    });
  }

  private submissionDirectory(identity: string): string {
    return join(this.config.stateRoot, "submissions", directoryKey(identity));
  }

  private attemptRoot(attempt: AttemptUri): string {
    return join(this.config.stateRoot, "attempts", attempt.slice("urn:uuid:".length));
  }

  private paths(attempt: AttemptUri): WorkspacePaths {
    const root = this.attemptRoot(attempt);
    return {
      root,
      input: join(root, "input"),
      work: join(root, "work"),
      out: join(root, "out"),
      logs: join(root, "logs"),
      harnessState: join(root, "harness-state"),
      secrets: join(root, "secrets"),
      tmp: join(root, "tmp"),
      meta: join(root, "meta"),
    };
  }

  private journal(attempt: AttemptUri) {
    const base = openAttemptJournal(this.paths(attempt).meta);
    const notify = (): void => {
      this.notifyObservationTail(attempt);
    };
    return {
      append: (intent: Parameters<typeof base.append>[0]) => {
        const event = base.append(intent);
        notify();
        return event;
      },
      fsyncedAppend: (intent: Parameters<typeof base.fsyncedAppend>[0]) => {
        const event = base.fsyncedAppend(intent);
        notify();
        return event;
      },
      appendAndEmit: (
        intent: Parameters<typeof base.appendAndEmit>[0],
        emit: Parameters<typeof base.appendAndEmit>[1],
      ) => {
        const event = base.appendAndEmit(intent, emit);
        notify();
        return event;
      },
      read: base.read.bind(base),
      durableSeq: base.durableSeq.bind(base),
    };
  }

  private reject(
    identity: string,
    category: TaskExecutionError["category"],
    options: {
      readonly detail?: string;
      readonly annotations?: Readonly<Record<string, unknown>>;
    } = {},
  ): SubmissionAck {
    const error = new TaskExecutionError(category, {
      detail: options.detail,
      annotations: options.annotations === undefined
        ? undefined
        : { ...options.annotations },
    });
    openSubmissionSegment(this.submissionDirectory(identity)).append({
      submission: identity,
      type: "submission-rejected",
      time: this.now(),
      details: {
        category,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      },
    });
    return { accepted: false, error };
  }

  private decodeAndSealCheck(
    taskBytes: Uint8Array,
    submissionBytes: Uint8Array,
  ):
    | {
        readonly ok: true;
        readonly task: TaskSpecification;
        readonly submission: SubmissionRecord;
      }
    | { readonly ok: false; readonly identity: string; readonly detail: string } {
    let submissionIdentity = `invalid:${documentDigest(submissionBytes)}`;
    try {
      const taskDocument = decode(taskBytes);
      const taskValidation = validateTask(taskDocument);
      if (!taskValidation.conforms) {
        return { ok: false, identity: submissionIdentity, detail: detail(taskValidation.errors) };
      }
      if (!bytesEqual(sealTask(taskDocument), taskBytes)) {
        return {
          ok: false,
          identity: submissionIdentity,
          detail: "Task bytes are valid JSON but are not the exact canonical sealed bytes",
        };
      }

      const submissionDocument = decode(submissionBytes);
      if (
        typeof submissionDocument === "object"
        && submissionDocument !== null
        && typeof (submissionDocument as { submission?: unknown }).submission === "string"
      ) {
        submissionIdentity = String(
          (submissionDocument as { submission: unknown }).submission,
        );
      }
      const submissionValidation = validateSubmission(submissionDocument);
      if (!submissionValidation.conforms) {
        return {
          ok: false,
          identity: submissionIdentity,
          detail: detail(submissionValidation.errors),
        };
      }
      if (!bytesEqual(sealSubmission(submissionDocument), submissionBytes)) {
        return {
          ok: false,
          identity: submissionIdentity,
          detail: "Submission bytes are valid JSON but are not the exact canonical sealed bytes",
        };
      }
      return {
        ok: true,
        task: taskDocument as TaskSpecification,
        submission: submissionDocument as SubmissionRecord,
      };
    } catch (error) {
      return {
        ok: false,
        identity: submissionIdentity,
        detail: error instanceof Error ? error.message : "document decoding failed",
      };
    }
  }

  private profile(task: TaskSpecification): TaskProfileDocument {
    return this.config.resolveTaskProfile?.(task.profile)
      ?? resolveProfile(task.profile, this.config.profileStore);
  }

  private capabilitiesValue(): BackendCapabilities {
    return assembleCapabilities({
      launchers: this.config.launchers,
      provisioner: this.config.provisionerCapabilities,
      recorderAvailability: this.config.recorderAvailability ?? "none",
      trustKeys: this.config.trustKeys ?? {},
      secretForwardResolverConfigured: this.config.secretForwardResolver !== undefined,
      hostSecretResolverConfigured: this.config.hostSecretResolver !== undefined,
      custody: nativeCustodySupport(),
      enforcedLauncherIds: new Set(Object.keys(this.config.launcherDeployments ?? {})),
    });
  }

  async capabilities(): Promise<BackendCapabilities> {
    return this.capabilitiesValue();
  }

  private preflightLaunchers(request: PreflightRequest): readonly LauncherContract[] {
    const harness = requestedInventoryValue(request.requirements?.["harness"]);
    if (request.taskProfile === undefined) {
      return harness === undefined
        ? this.config.launchers
        : this.config.launchers.filter((launcher) => launcher.id === harness);
    }
    try {
      return [selectProfileSafeLauncher(this.config.launchers, request.taskProfile, harness)];
    } catch {
      return [];
    }
  }

  private preflightUnavailable(detail: string): PreflightReport {
    return {
      ready: false,
      detail,
      error: new TaskExecutionError("backend-unavailable", { detail }),
    };
  }

  async preflight(request: PreflightRequest): Promise<PreflightReport> {
    this.assertWriter();
    const custody = nativeCustodySupport();
    if (!custody.ready) {
      return this.preflightUnavailable(custody.detail ?? "attempt custody support is unavailable");
    }
    const candidates = this.preflightLaunchers(request);
    if (candidates.length === 0) {
      return this.preflightUnavailable("no configured launcher matches the requested task profile and harness");
    }
    const viable = candidates.filter((launcher) =>
      (this.config.secretForwardResolver !== undefined
        || launcher.capabilities().secretForwards.length === 0)
      && (this.config.hostSecretResolver !== undefined
        || (launcher.capabilities().hostSecretForwards?.length ?? 0) === 0));
    if (viable.length === 0) {
      return this.preflightUnavailable("selected launcher requires secret forwards but no SecretForwardResolver is configured");
    }
    const probes: ProbeResult[] = await Promise.all(viable.map(async (launcher): Promise<ProbeResult> => {
      const deployment = this.config.launcherDeployments?.[launcher.id];
      if (deployment !== undefined) {
        const pinning = await verifyRunPinning(deployment, request.requirements ?? {});
        if (!pinning.ready) return pinning;
      }
      return launcher.probe?.() ?? { ready: true };
    }));
    const failed = probes.find((probe) => !probe.ready);
    return failed === undefined
      ? { ready: true }
      : this.preflightUnavailable(failed.detail ?? "launcher probe failed");
  }

  /**
   * Notes the workKind (and, for today-generation claims, the marketplace requestId) that will
   * produce this attempt, so `deliveryExtensions` can read it back at delivery-sealing time
   * (cutover stage 1, C7 workKind seam / finding E24). A two-party caller (e.g. `work-loop.ts`)
   * knows `attempt` before it ever calls `submit()`, so this is safe to call first. Not part of
   * the `TaskExecutionBackend` interface -- callers hold a concrete `LocalTaskExecutionBackend`
   * reference, not the abstract type, to reach it.
   */
  noteAttemptWorkKind(attempt: AttemptUri, workKind: string, requestId?: `0x${string}`): void {
    this.attemptWorkKinds.set(attempt, {
      workKind,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  async submit(
    taskBytes: Uint8Array,
    submissionBytes: Uint8Array,
    engagement?: TwoPartyEngagement,
  ): Promise<SubmissionAck> {
    return this.trackInflight(this.submitAccepted(taskBytes, submissionBytes, engagement));
  }

  private async submitAccepted(
    taskBytes: Uint8Array,
    submissionBytes: Uint8Array,
    engagement?: TwoPartyEngagement,
  ): Promise<SubmissionAck> {
    try {
      this.assertWriter();
    } catch (error) {
      return { accepted: false, error: errorCategory(error) };
    }
    const checked = this.decodeAndSealCheck(taskBytes, submissionBytes);
    if (!checked.ok) {
      return this.reject(checked.identity, "invalid-document", { detail: checked.detail });
    }
    const { task, submission } = checked;
    const submissionUri = asSubmissionUri(submission.submission);

    if (engagement !== undefined) {
      if (!isValidUrnUuid(engagement.attemptUri)) {
        return this.reject(submissionUri, "invalid-document", {
          detail: `engagement.attemptUri "${engagement.attemptUri}" is not a well-formed urn:uuid`,
        });
      }
      const dispatchValidation = validateDispatchContext(engagement.dispatchContext);
      if (!dispatchValidation.conforms) {
        return this.reject(submissionUri, "invalid-document", {
          detail: detail(dispatchValidation.errors),
        });
      }
    }

    const taskDigest = documentDigest(taskBytes);
    const boundTaskDigest = submission.task.digest?.sha256;
    if (boundTaskDigest !== taskDigest.slice("sha256:".length)) {
      return this.reject(submissionUri, "invalid-reference", {
        detail: `Submission task digest sha256:${boundTaskDigest ?? "none"} does not match ${taskDigest}`,
      });
    }

    const scope = scopeKey(submission.requester, submission.idempotencyKey);
    const existing = this.submissionsByScope.get(scope);
    if (existing !== undefined) {
      if (
        bytesEqual(existing.taskBytes, taskBytes)
        && bytesEqual(existing.submissionBytes, submissionBytes)
      ) {
        return {
          accepted: true,
          submission: asSubmissionUri(existing.parsed.submission),
          digest: existing.digest,
        };
      }
      return this.reject(submissionUri, "submission-conflict", {
        detail: `idempotencyKey "${submission.idempotencyKey}" already has different exact bytes in this requester/backend scope`,
      });
    }

    let resolvedProfile: TaskProfileDocument;
    try {
      resolvedProfile = this.profile(task);
    } catch (error) {
      const mapped = errorCategory(error);
      return this.reject(submissionUri, mapped.category, { detail: mapped.detail });
    }

    const keyClasses: Record<string, ComparisonClass> = {
      ...CORE_REQUIREMENT_CLASSES,
      ...Object.fromEntries(
        resolvedProfile.requirementKeys.map(({ key, comparisonClass }) => [
          key,
          comparisonClass,
        ]),
      ),
    };
    const merged = mergeRequirements(
      task.requirements,
      submission.requirements,
      keyClasses,
    );
    if (!merged.ok) {
      return this.reject(submissionUri, merged.category, {
        detail: `requirement "${merged.key}" violates its ${keyClasses[merged.key] ?? "conservative"} comparison class`,
        annotations: { key: merged.key },
      });
    }

    const requestedMaxAttemptDurationMs = merged.effective["maxAttemptDurationMs"];
    const maxAttemptDurationMs = requestedMaxAttemptDurationMs === undefined
      ? undefined
      : positiveSafeDuration(requestedMaxAttemptDurationMs);
    if (requestedMaxAttemptDurationMs !== undefined && maxAttemptDurationMs === undefined) {
      return this.reject(submissionUri, "invalid-document", {
        detail: "requirement \"maxAttemptDurationMs\" must be a positive safe integer",
        annotations: { key: "maxAttemptDurationMs" },
      });
    }

    const capabilities = this.capabilitiesValue();
    const supportByKey = new Map(
      capabilities.runPinning.keys.map((support) => [support.key, support]),
    );
    for (const [key, value] of Object.entries(merged.effective)) {
      if (key === "maxAttemptDurationMs") continue;
      const support = supportByKey.get(key);
      if (support === undefined) {
        return this.reject(submissionUri, "unsupported-requirement", {
          detail: `requirement "${key}" is not declared by this backend`,
          annotations: { key },
        });
      }
      const requested = requestedInventoryValue(value);
      if (
        support.inventory.length > 0
        && !support.inventory.includes("*")
        && (requested === undefined || !support.inventory.includes(requested))
      ) {
        return this.reject(submissionUri, "unsupported-requirement", {
          detail: `requirement "${key}" requests a value outside this backend's inventory`,
          annotations: { key },
        });
      }
    }

    if (submission.evaluationRequirements !== undefined) {
      return this.reject(submissionUri, "unsupported-requirement", {
        detail: "no configured deployment profile interprets evaluationRequirements",
        annotations: { key: "evaluationRequirements" },
      });
    }
    if (submission.profileParameters !== undefined) {
      return this.reject(submissionUri, "unsupported-requirement", {
        detail: "the resolved profile does not declare profileParameters",
        annotations: { key: "profileParameters" },
      });
    }
    if (submission.closeAt !== undefined) {
      return this.reject(submissionUri, "unsupported-requirement", {
        detail: "this embedded local backend cannot enforce closeAt",
        annotations: { key: "closeAt" },
      });
    }
    if (submission.capabilityGrants !== undefined && this.config.capabilityGrants === undefined) {
      return this.reject(submissionUri, "unsupported-requirement", {
        detail: "no capability-grant resolver is configured",
        annotations: { key: "capabilityGrants" },
      });
    }
    if (engagement === undefined) {
      for (const key of ["maxTotal", "maxConcurrent"] as const) {
        const requested = submission.attempts?.[key];
        if (requested !== undefined && requested !== 1) {
          return this.reject(submissionUri, "unsupported-requirement", {
            detail: `attempts.${key}=${requested} is outside the local backend's [1, 1] range`,
            annotations: { key: `attempts.${key}` },
          });
        }
      }
    }

    const attempt = engagement?.attemptUri ?? asAttemptUri(`urn:uuid:${crypto.randomUUID()}`);
    const capacity = this.capacity.tryAcquire(attempt);
    if (!capacity.acquired) {
      return this.reject(submissionUri, capacity.error.category, {
        detail: capacity.error.detail,
        annotations: capacity.error.annotations,
      });
    }

    const dispatchContext: DispatchContext = engagement?.dispatchContext ?? {
      taskDigest,
      submission: submissionUri,
      nonce: submission.nonce,
      attempt,
    };
    if (
      dispatchContext.taskDigest !== taskDigest
      || dispatchContext.submission !== submissionUri
      || dispatchContext.nonce !== submission.nonce
      || dispatchContext.attempt !== attempt
    ) {
      this.capacity.release(attempt);
      return this.reject(submissionUri, "invalid-reference", {
        detail: "the supplied dispatch context does not bind the submitted Task, Submission, nonce, and Attempt",
      });
    }
    const dispatchContextBytes = serializeCanonicalJson(dispatchContext as JsonValue);
    const dispatchContextDescriptor = {
      uri: `urn:jinn:backend-local:dispatch-context:${attempt.slice("urn:uuid:".length)}`,
      digest: { sha256: sha256Hex(dispatchContextBytes) },
    };

    const identity: AttemptIdentity = {
      attemptUri: attempt,
      nonce: submission.nonce,
      attemptNumber: 1,
    };
    const meta: AttemptMeta = {
      attempt,
      task: taskDigest,
      submission: submissionUri,
      effectiveDeadline: submission.deadline,
      ...(maxAttemptDurationMs === undefined ? {} : { maxAttemptDurationMs }),
      ...(submission.annotations === undefined
        ? {}
        : { annotations: submission.annotations }),
    };
    const view: TaskView = {
      task,
      effectiveRequirements: merged.effective,
      profile: resolvedProfile,
    };
    let selectedLauncher: LauncherContract;
    let preplanned: LaunchPlan;
    try {
      selectedLauncher = this.selectLauncher(view);
      const deployment = this.config.launcherDeployments?.[selectedLauncher.id];
      const requiredDirectPins = ["harness", "model", "loadout"]
        .filter((key) => merged.effective[key] !== undefined);
      if (deployment === undefined && requiredDirectPins.length > 0) {
        this.capacity.release(attempt);
        return this.reject(submissionUri, "unsupported-requirement", {
          detail: `selected launcher has no configured direct verification for ${requiredDirectPins.join(", ")}`,
        });
      }
      if (deployment !== undefined) {
        const pinning = await verifyRunPinning(
          deployment,
          merged.effective as Record<string, unknown>,
        );
        if (!pinning.ready) {
          this.capacity.release(attempt);
          return this.reject(submissionUri, "unsupported-requirement", {
            detail: pinning.detail ?? "selected launcher is not ready for the requested pins",
          });
        }
      }
      preplanned = selectedLauncher.plan(view, this.paths(attempt), identity);
    } catch (error) {
      this.capacity.release(attempt);
      const mapped = errorCategory(error);
      return this.reject(submissionUri, mapped.category === "backend-unavailable"
        ? "unsupported-requirement"
        : mapped.category, { detail: mapped.detail });
    }
    const selectedProvisioner = this.config.provisioner({
      sealedTaskBytes: taskBytes.slice(),
      dispatchContextBytes,
      task,
      submission,
      attempt: identity,
    });
    if (!validProvisionerId(selectedProvisioner.id)) {
      this.capacity.release(attempt);
      return this.reject(submissionUri, "backend-unavailable", {
        detail: "provisioner selector returned an empty or non-canonical id",
      });
    }
    mkdirSync(this.paths(attempt).meta, { recursive: true, mode: 0o700 });
    this.journal(attempt).append({
      attemptId: attempt,
      type: "attempt-engaged",
      time: this.now(),
      details: {
        attempt,
        taskDigest,
        submission: submissionUri,
        executor: this.config.executor,
        effectiveDeadline: submission.deadline,
        source: this.config.source,
        dispatchContext: dispatchContextDescriptor,
        attemptNumber: 1,
        ...(submission.annotations === undefined
          ? {}
          : { annotations: submission.annotations }),
      },
    });

    const digest = documentDigest(submissionBytes);
    const stored: StoredSubmission = {
      taskBytes: taskBytes.slice(),
      submissionBytes: submissionBytes.slice(),
      digest,
      parsed: submission,
      taskDigest,
      attempt,
    };
    this.attempts.set(attempt, meta);
    this.submissionsByScope.set(scope, stored);
    this.submissionsByUri.set(submissionUri, stored);
    this.persistAccepted(stored, meta);
    openSubmissionSegment(this.submissionDirectory(submissionUri)).append({
      submission: submissionUri,
      type: "submission-accepted",
      time: this.now(),
      details: { taskDigest, digest, attempt },
    });

    const provisioner = selectedProvisioner.contract;
    atomicWrite(join(this.paths(attempt).meta, "dispatch-context.sealed"), dispatchContextBytes);
    const grants = submission.capabilityGrants === undefined
      ? []
      : [...(this.config.capabilityGrants?.(submission.capabilityGrants) ?? [])];
    try {
      await provisioner.setup(
        view,
        this.paths(attempt),
        grants,
      );
    } catch (error) {
      if (error instanceof ProvisioningRejectedError) {
        this.journal(attempt).append({
          attemptId: attempt,
          type: "attempt-terminal",
          time: this.now(),
          details: {
            state: "rejected",
            category: "invalid-reference",
            detail: error.reason,
            neverExecuted: true,
            source: this.config.source,
          },
        });
      } else {
        this.journal(attempt).append({
          attemptId: attempt,
          type: "attempt-terminal",
          time: this.now(),
          details: {
            state: "failed",
            blame: "infrastructure",
            category: "backend-unavailable",
            detail: error instanceof Error ? error.message : "provisioning failed",
            source: this.config.source,
          },
          failsAttempt: true,
        });
      }
      this.capacity.release(attempt);
      return { accepted: true, submission: submissionUri, digest };
    }

    try {
      const launcher = selectedLauncher;
      const plan = preplanned;
      // #2538 F5: the shim has always supported redirecting the harness's stdio into `logs/`
      // (backend-written, outside the executor's write surface — design §7.1), but nothing ever
      // passed the paths, so every launcher's stdout and stderr went to `ignore`. Live, the
      // prediction launcher wrote a precise one-line diagnostic to stderr and exited 2; the
      // attempt's `logs/` and `out/` were empty and the terminal detail read `"failed"`, which is
      // why the defect was first misread as a different one. The harness's own words are the
      // cheapest diagnostic there is; keep them.
      const spawn: SpawnRequest & { readonly stdoutPath: string; readonly stderrPath: string } = {
        argv: plan.argv,
        env: provisioner.executionEnv({ env: plan.env, cwd: plan.cwd }),
        cwd: plan.cwd,
        stdoutPath: join(this.paths(attempt).logs, HARNESS_STDOUT_LOG),
        stderrPath: join(this.paths(attempt).logs, HARNESS_STDERR_LOG),
      };
      const planBytes = serializeCanonicalJson({
        argv: [...plan.argv],
        env: { ...plan.env },
        cwd: plan.cwd,
        validExitCodes: [...plan.validExitCodes],
        ...(plan.blameExitCodes === undefined ? {} : { blameExitCodes: plan.blameExitCodes }),
        resultContract: plan.resultContract,
        interruptionBehavior: plan.interruptionBehavior,
        ...(plan.secretForwards === undefined ? {} : { secretForwards: plan.secretForwards }),
        ...(plan.hostSecretForwards === undefined ? {} : { hostSecretForwards: plan.hostSecretForwards }),
      } as unknown as JsonValue);
      this.journal(attempt).fsyncedAppend({
        attemptId: attempt,
        type: "spawn-intended",
        time: this.now(),
        details: {
          nonce: submission.nonce,
          launcher: launcher.id,
          provisioner: selectedProvisioner.id,
          launchPlanDigest: documentDigest(planBytes),
          launchPlan: JSON.parse(textDecoder.decode(planBytes)),
          source: this.config.source,
        },
      });
      const secretForwards = validateSecretForwardPlan(launcher, plan);
      if (secretForwards.length > 0) {
        if (this.config.secretForwardResolver === undefined) {
          throw new Error("launcher requires secret forwards but no SecretForwardResolver is configured");
        }
        await materializeSecretForwards({
          attempt: identity,
          secrets: this.paths(attempt).secrets,
          forwards: secretForwards,
          grants,
          resolver: this.config.secretForwardResolver,
        });
      }
      const hostSecretForwards = validateHostSecretForwardPlan(launcher, plan);
      if (hostSecretForwards.length > 0) {
        if (this.config.hostSecretResolver === undefined) {
          throw new Error("launcher requires host secret forwards but no HostSecretResolver is configured");
        }
        await materializeHostSecretForwards({
          authorization: {
            attempt: identity,
            launcherId: launcher.id,
            taskDigest,
            submission: submissionUri,
            submissionDigest: digest,
            taskProfile: view.profile.profile,
            deadline: submission.deadline,
          },
          secrets: this.paths(attempt).secrets,
          forwards: hostSecretForwards,
          resolver: this.config.hostSecretResolver,
        });
      }
      const worker = this.runAcceptedAttempt({
        attempt: identity,
        taskBytes,
        task,
        dispatchContextBytes,
        paths: this.paths(attempt),
        provisioner,
        plan,
        planBytes,
        spawn,
      }).finally(() => {
        rmSync(this.paths(attempt).secrets, { recursive: true, force: true });
      }).catch((error: unknown) => {
        if (this.closeInvoked) {
          this.recordShutdownDrainFailure(error);
          return;
        }
        if (this.shutdownStarted) return;
        const record = foldAttemptRecord(this.journal(attempt).read());
        if (!record.terminal) {
          this.appendTerminal(attempt, {
            state: "failed",
            blame: "infrastructure",
            category: "backend-unavailable",
            detail: error instanceof Error ? error.message : "shim supervision failed",
          });
        }
      });
      this.trackWorker(attempt, worker);
    } catch (error) {
      // Terminal planning/materialization failures must never retain a secret forward.
      rmSync(this.paths(attempt).secrets, { recursive: true, force: true });
      rmSync(this.paths(attempt).tmp, { recursive: true, force: true });
      this.journal(attempt).append({
        attemptId: attempt,
        type: "attempt-terminal",
        time: this.now(),
        details: {
          state: "failed",
          blame: "infrastructure",
          category: "backend-unavailable",
          neverExecuted: true,
          detail: error instanceof Error ? error.message : "launcher planning failed",
          source: this.config.source,
        },
        failsAttempt: true,
      });
      this.capacity.release(attempt);
    }

    return { accepted: true, submission: submissionUri, digest };
  }

  private appendTerminal(
    attempt: AttemptUri,
    details: Readonly<Record<string, unknown>>,
  ): void {
    this.clearAttemptTimers(attempt);
    this.journal(attempt).append({
      attemptId: attempt,
      type: "attempt-terminal",
      time: this.now(),
      details: { ...details, source: this.config.source },
      ...(details["state"] === "failed" || details["state"] === "lost"
        ? { failsAttempt: true }
        : {}),
    });
    this.capacity.release(attempt);
    // Secret material is never retention data. Terminal cleanup is idempotent and happens even
    // when the caller reached this path through a post-execution failure.
    rmSync(this.paths(attempt).secrets, { recursive: true, force: true });
    rmSync(this.paths(attempt).tmp, { recursive: true, force: true });
  }

  private async runAcceptedAttempt(input: {
    readonly attempt: AttemptIdentity;
    readonly taskBytes: Uint8Array;
    readonly task: TaskSpecification;
    readonly dispatchContextBytes: Uint8Array;
    readonly paths: WorkspacePaths;
    readonly provisioner: ProvisionerContract;
    readonly plan: LaunchPlan;
    readonly planBytes: Uint8Array;
    readonly spawn: SpawnRequest & { readonly stdoutPath?: string; readonly stderrPath?: string };
  }): Promise<void> {
    const attempt = input.attempt.attemptUri;
    const capturePosture = this.config.recorderAvailability ?? "none";
    let capture: EvidenceCaptureSession | undefined;
    if (capturePosture !== "none") {
      if (this.config.evidence === undefined) {
        if (capturePosture === "always") {
          this.appendTerminal(attempt, {
            state: "failed",
            blame: "infrastructure",
            category: "dependency-unavailable",
            detail: "evidence capture is required but no EvidenceBindingPorts were injected",
          });
          return;
        }
      } else {
        try {
          capture = await createEvidenceJoin({
            ports: this.config.evidence,
            source: this.config.source as `${string}:${string}`,
            executor: this.config.executor as `${string}:${string}`,
            now: () => this.now(),
          }).start({
            paths: input.paths,
            attempt,
            taskDigest: documentDigest(input.taskBytes),
            taskBytes: input.taskBytes,
            dispatchContextBytes: input.dispatchContextBytes,
            launchPlanBytes: input.planBytes,
            startedAt: this.now(),
          });
        } catch (error) {
          if (capturePosture === "always") {
            this.appendTerminal(attempt, {
              state: "failed",
              blame: "infrastructure",
              category: "dependency-unavailable",
              detail:
                error instanceof Error
                  ? `evidence capture start failed: ${error.message}`
                  : "evidence capture start failed",
            });
            return;
          }
        }
      }
    }

    spawnShim({
      attemptId: attempt,
      nonce: input.attempt.nonce,
      metaDir: input.paths.meta,
      secretsDir: input.paths.secrets,
      ...(this.config.heartbeatIntervalMs === undefined ? {} : { heartbeatMs: this.config.heartbeatIntervalMs }),
    }, input.spawn);
    const fingerprint = await this.waitForShimFingerprint(input.paths.meta);
    const execStartedAtMonotonicNs = monotonicNowNs().toString();
    const clockIdentity = monotonicClockIdentity();
    this.journal(attempt).append({
      attemptId: attempt,
      type: "spawned",
      time: this.now(),
      details: {
        nonce: input.attempt.nonce,
        pid: fingerprint.pid,
        startTime: fingerprint.startTime,
        source: this.config.source,
      },
    });
    this.journal(attempt).append({
      attemptId: attempt,
      type: "attempt-started",
      time: this.now(),
      details: {
        startedAt: this.now(),
        executor: this.config.executor,
        ...(this.attempts.get(attempt)?.maxAttemptDurationMs === undefined
          ? {}
          : { maxAttemptDurationMs: this.attempts.get(attempt)!.maxAttemptDurationMs }),
        execStartedAtMonotonicNs,
        ...(clockIdentity === undefined ? {} : { monotonicClockIdentity: clockIdentity }),
        source: this.config.source,
      },
    });
    const currentMetadata = this.attempts.get(attempt);
    if (currentMetadata !== undefined) {
      const updated: AttemptMeta = {
        ...currentMetadata,
        execStartedAtMonotonicNs,
        ...(clockIdentity === undefined ? {} : { monotonicClockIdentity: clockIdentity }),
      };
      this.attempts.set(attempt, updated);
      this.persistAttemptMetadata(updated);
    }
    this.armExpiry(attempt);
    this.relayPendingCancellation(attempt);

    await this.invokeCompletionPhase("before-outcome-wait");
    if (!this.workerMayContinue()) return;
    const execution = await this.waitForOutcome(attempt, input.paths.meta, input.attempt.nonce);
    if (!this.workerMayContinue()) return;
    await this.invokeCompletionPhase("after-outcome");
    if (!this.workerMayContinue()) return;
    await this.completeAttempt({ ...input, execution, capture, capturePosture });
  }

  /** Shared post-outcome path. Recovery supplies the exact persisted plan and a resumed recorder. */
  private async completeAttempt(input: {
    readonly attempt: AttemptIdentity;
    readonly taskBytes: Uint8Array;
    readonly task: TaskSpecification;
    readonly paths: WorkspacePaths;
    readonly provisioner: ProvisionerContract;
    readonly plan: LaunchPlan;
    readonly execution: { readonly exitCode?: number; readonly signal?: string };
    readonly capture?: EvidenceCaptureSession;
    readonly capturePosture: RecorderAvailability;
  }): Promise<void> {
    if (!this.workerMayContinue()) return;
    const attempt = input.attempt.attemptUri;
    const initialRecord = foldAttemptRecord(this.journal(attempt).read());
    if (initialRecord.terminal && initialRecord.terminalState !== "lost") return;
    const append = (type: JournalEvent["type"], details: Readonly<Record<string, unknown>>) => {
      if (this.journal(attempt).read().some((event) => event.type === type)) return;
      this.journal(attempt).append({ attemptId: attempt, type, time: this.now(), details: { ...details, source: this.config.source } });
    };
    append("exec-finished", { exitCode: input.execution.exitCode ?? null, termSignal: input.execution.signal ?? null });
    append("harvest-started", {});
    await this.invokeCompletionPhase("before-harvest");
    if (!this.workerMayContinue()) return;
    // The shim's bounded cleanup result is authoritative: waiting for generic group emptiness
    // first would turn a deliberate ceiling terminal into an unrelated harvest failure.
    const cancellationResult = readShimCancellationResult(input.paths.meta, input.attempt.nonce);
    if (cancellationResult !== null && cancellationResult.residualPids.length > 0) {
      this.appendTerminal(attempt, {
        state: "failed",
        blame: "infrastructure",
        category: "backend-unavailable",
        detail: `residual live processes: ${cancellationResult.residualPids.join(",")}`,
        residualPids: cancellationResult.residualPids,
      });
      return;
    }
    let harvest: HarvestResult;
    const harvested = this.journal(attempt).read().find((event) => event.type === "harvested");
    try {
      await this.waitForHarnessGroupEmpty(input.paths);
      harvest = harvested === undefined
        ? await input.provisioner.harvest(input.paths, input.task.outputs)
        : this.journaledHarvest(harvested);
    } catch (error) {
      if (error instanceof TaskExecutionError && error.category === "invalid-document") {
        throw error;
      }
      this.appendTerminal(attempt, { state: "failed", blame: "infrastructure", category: "backend-unavailable", detail: error instanceof Error ? `harvest failed: ${error.message}` : "harvest failed" });
      return;
    }
    if (harvested === undefined) append("harvested", { manifest: harvest.manifest, omissions: harvest.omissions, integrityViolations: harvest.integrityViolations });
    await this.invokeCompletionPhase("after-harvest");
    if (!this.workerMayContinue()) return;
    const envelope = this.readResultEnvelope(input.paths, input.plan, harvest);
    const interpreted = interpretResult(input.plan, input.execution, envelope);
    const observedEvidence = this.journal(attempt).read()
      .find((event) => event.type === "execution-observed");
    let receipt = observedEvidence === undefined
      ? undefined
      : this.journaledEvidenceLink(observedEvidence);
    if (input.capture !== undefined && observedEvidence === undefined) {
      try {
        await input.capture.captureRuntimeObservation({ kind: "resource", entityId: "runtime/process-exit", name: "Harness process exit", value: input.execution.exitCode ?? input.execution.signal ?? "unknown", propertyId: "https://spec.jinn.network/properties/process-exit", origin: { kind: "producer-observed", observer: this.config.source as `${string}:${string}` } });
        receipt = await input.capture.finalize({ harvest, outcome: interpreted.state === "delivered" ? "completed" : "failed", endedAt: this.now() });
      } catch (error) {
        if (input.capturePosture === "always") {
          this.appendTerminal(attempt, { state: "failed", blame: "infrastructure", category: "dependency-unavailable", detail: error instanceof Error ? `evidence capture finalization failed: ${error.message}` : "evidence capture finalization failed" });
          return;
        }
        append("progress", { degradation: "evidence-capture-finalization-failed" });
      }
    }
    if (receipt !== undefined) append("execution-observed", { executionId: receipt.executionId, evidenceRecord: receipt.record });
    await this.invokeCompletionPhase("after-evidence");
    if (!this.workerMayContinue()) return;
    // Cancellation is an intent, never an outcome channel.  The shim remains the sole outcome
    // recorder: only a signal outcome after that intent becomes `cancelled`; a natural exit
    // continues through normal interpretation and therefore wins a race with cancellation.
    const cancellationRequested = this.journal(attempt).read().some(
      (event) => event.type === "cancel-requested",
    );
    if (cancellationRequested && input.execution.signal !== undefined) {
      const deadlineRequested = this.journal(attempt).read().some(
        (event) => event.type === "cancel-requested" && event.details["deadline"] === true,
      );
      this.appendTerminal(attempt, {
        state: deadlineRequested ? "expired" : "cancelled",
        detail: input.execution.signal,
      });
      return;
    }
    if (interpreted.state === "failed") {
      // #2538 F5: name what the harness said, not just how it exited. `invalid-exit` alone sent a
      // live diagnosis down the wrong path for most of a round.
      const stderrTail = harnessLogTail(join(input.paths.logs, HARNESS_STDERR_LOG));
      const reason = interpreted.reasonCode ?? "executor reported failure";
      this.appendTerminal(attempt, {
        state: "failed",
        blame: interpreted.blame ?? "task",
        category: "protocol-violation",
        detail: stderrTail === undefined ? reason : `${reason}: ${stderrTail}`,
      });
      return;
    }
    if (existsSync(this.deliveryCheckpointPath(attempt))) {
      this.recordCheckpointEvent(attempt);
      this.appendTerminal(attempt, { state: "delivered", ...(interpreted.reasonCode === undefined ? {} : { detail: interpreted.reasonCode }) });
      return;
    }
    await this.invokeCompletionPhase("before-delivery-checkpoint");
    if (!this.workerMayContinue()) return;
    // C7 workKind seam (finding E24): read once and discard -- a host-noted bridge context is
    // relevant to exactly one delivery-sealing pass for its attempt.
    const bridgeNote = this.attemptWorkKinds.get(attempt);
    this.attemptWorkKinds.delete(attempt);
    const extensions = this.config.deliveryExtensions?.({
      attempt,
      harvest,
      task: input.task,
      ...(bridgeNote === undefined ? {} : bridgeNote),
    }) ?? {};
    for (const key of Object.keys(extensions)) {
      if (!/^[a-z][a-z0-9+.-]*:/iu.test(key)) {
        throw new Error("Delivery extension keys must be absolute URIs");
      }
    }
    // Reserved keys win: `extensions` spreads first so no extension can shadow a canonical
    // Delivery field below.
    const deliveryBytes = sealDelivery({ ...extensions, protocol: "https://spec.jinn.network/profiles/task-execution/v1", attempt, task: documentDigest(input.taskBytes), outputs: harvest.manifest.map((artifact) => ({ name: artifact.path, ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }), digest: { sha256: String(artifact.sha256).replace(/^sha256:/u, "") } })), outcome: interpreted.outcome ?? "fulfilled", ...(receipt === undefined ? {} : { evidenceRecords: [receipt.record], executionIds: [receipt.executionId] }), createdAt: this.now() });
    // Finding E31: sign the Delivery's own already-sealed bytes exactly once, never re-seal --
    // see the module-level comment above `sealExecutorBindingEnvelope`. Additive: with no
    // delivery-signing key configured, `deliveryBytes` above is computed identically to before
    // this finding, and no envelope is ever produced.
    const deliverySigningKey = this.config.trustKeys?.deliverySigningKey;
    const executorBindingEnvelope = deliverySigningKey === undefined
      ? undefined
      : sealExecutorBindingEnvelope(deliveryBytes, deliverySigningKey);
    await this.recordDelivery(attempt, deliveryBytes, executorBindingEnvelope);
    this.appendTerminal(attempt, { state: "delivered", ...(interpreted.reasonCode === undefined ? {} : { detail: interpreted.reasonCode }) });
  }

  private async waitForShimFingerprint(meta: string): Promise<NonNullable<ReturnType<typeof readShimFingerprint>>> {
    // Hosted runners can take longer than two seconds to schedule the native shim after spawn.
    // The fingerprint remains the only readiness authority; waiting longer never treats an
    // unverified PID as live and keeps a slow-but-valid launch from being misclassified.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const fingerprint = readShimFingerprint(meta);
      if (fingerprint !== null) return fingerprint;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("shim did not publish a fingerprint");
  }

  private readResultEnvelope(
    paths: WorkspacePaths,
    plan: LaunchPlan,
    harvest: { readonly manifest: readonly { readonly path: string }[]; readonly integrityViolations: readonly { readonly path: string }[] },
  ): ResultEnvelope | undefined {
    const artifact = plan.resultContract.structuredOutputArtifact;
    if (artifact === undefined) return undefined;
    if (!artifact.startsWith("out/") || artifact.includes("..") || artifact.includes("\\")) {
      throw new Error("launcher result envelope artifact must be a contained out/ path");
    }
    const path = join(paths.root, artifact);
    if (!existsSync(path)) return undefined;
    const relative = artifact.slice("out/".length);
    if (!harvest.manifest.some((entry) => entry.path === relative)
      || harvest.integrityViolations.some((entry) => entry.path === relative)) {
      throw new Error("launcher result envelope was not admitted by verified harvest");
    }
    const out = realpathSync(paths.out);
    const resolved = realpathSync(path);
    if (!resolved.startsWith(`${out}/`)) throw new Error("launcher result envelope escaped out/");
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("launcher result envelope must be a JSON object");
    }
    return parsed as ResultEnvelope;
  }

  private async waitForOutcome(attempt: AttemptUri, meta: string, nonce: string): Promise<{ readonly exitCode?: number; readonly signal?: string }> {
    for (;;) {
      this.recordHeartbeatStaleness(attempt, meta);
      const outcome = readOutcome(meta, nonce);
      if (outcome !== null) return shimOutcomeResult(outcome);
      if (!probeShimAlive(meta).alive) return resolveOutcomeAfterShimDeath(meta, nonce);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private recordCheckpointEvent(attempt: AttemptUri): void {
    const bytes = new Uint8Array(readFileSync(this.deliveryCheckpointPath(attempt)));
    const digest = documentDigest(bytes);
    if (!this.journal(attempt).read().some((event) => event.type === "delivery-recorded" && event.details["digest"] === digest)) {
      this.journal(attempt).append({ attemptId: attempt, type: "delivery-recorded", time: this.now(), details: { digest, source: this.config.source } });
    }
  }

  private journaledPlan(event: JournalEvent): LaunchPlan {
    const raw = event.details["launchPlan"];
    if (!isRecord(raw)) {
      throw new TaskExecutionError("invalid-document", {
        detail: "spawn intent has no structural LaunchPlan",
      });
    }
    const bytes = serializeCanonicalJson(raw as JsonValue);
    if (event.details["launchPlanDigest"] !== documentDigest(bytes)) {
      throw new TaskExecutionError("invalid-document", {
        detail: "journaled LaunchPlan digest does not bind its exact bytes",
      });
    }
    return parseLaunchPlan(raw);
  }

  private journaledHarvest(event: JournalEvent): HarvestResult {
    return parseHarvestResult(event);
  }

  private journaledEvidenceLink(event: JournalEvent): {
    readonly executionId: `urn:uuid:${string}`;
    readonly record: { readonly family: string; readonly digest: `sha256:${string}` };
  } {
    const executionId = event.details["executionId"];
    const record = event.details["evidenceRecord"];
    if (
      typeof executionId !== "string"
      || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(executionId)
      || !isRecord(record)
      || !hasOnlyKeys(record, ["family", "digest"])
      || !nonEmptyString(record.family)
      || typeof record.digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/u.test(record.digest)
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "journaled execution-observed evidence link is structurally invalid",
      });
    }
    return {
      executionId: executionId as `urn:uuid:${string}`,
      record: {
        family: record.family,
        digest: record.digest as `sha256:${string}`,
      },
    };
  }

  private async waitForHarnessGroupEmpty(paths: WorkspacePaths): Promise<void> {
    const fingerprint = readShimFingerprint(paths.meta);
    if (fingerprint?.harnessPid === undefined) return;
    for (let tries = 0; tries < 200; tries += 1) {
      if (listProcessGroupPids(fingerprint.harnessPid).length === 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new TaskExecutionError("backend-unavailable", { detail: "harness group is not empty; refusing harvest" });
  }

  private harnessGroupPids(paths: WorkspacePaths): readonly number[] {
    const fingerprint = readShimFingerprint(paths.meta);
    if (fingerprint?.harnessPid === undefined) return [];
    return listProcessGroupPids(fingerprint.harnessPid);
  }

  private async killHarnessGroup(paths: WorkspacePaths): Promise<readonly number[]> {
    const fingerprint = readShimFingerprint(paths.meta);
    if (fingerprint?.harnessPid === undefined) return [];
    const pids = [...listProcessGroupPids(fingerprint.harnessPid)];
    if (pids.length === 0) return [];
    try {
      process.kill(-fingerprint.harnessPid, "SIGTERM");
    } catch {
      // Exited races are verified by the process-group scan below.
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (listProcessGroupPids(fingerprint.harnessPid).length === 0) return pids;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    try {
      process.kill(-fingerprint.harnessPid, "SIGKILL");
    } catch {
      // Exited races are verified by the process-group scan below.
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (listProcessGroupPids(fingerprint.harnessPid).length === 0) return pids;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new TaskExecutionError("backend-unavailable", {
      detail: `recovery kill ladder left live process-group members: ${listProcessGroupPids(fingerprint.harnessPid).join(",")}`,
    });
  }

  private async resumeEvidenceCapture(
    attempt: AttemptUri,
    paths: WorkspacePaths,
    posture: RecorderAvailability,
  ): Promise<EvidenceCaptureSession | undefined> {
    if (posture === "none") return undefined;
    if (this.config.evidence === undefined) {
      if (posture === "always") {
        this.appendTerminal(attempt, {
          state: "failed",
          blame: "infrastructure",
          category: "dependency-unavailable",
          detail: "evidence capture is required but no EvidenceBindingPorts were injected",
        });
      } else {
        this.journal(attempt).append({
          attemptId: attempt,
          type: "progress",
          time: this.now(),
          details: {
            degradation: "evidence-capture-unavailable",
            source: this.config.source,
          },
        });
      }
      return undefined;
    }
    try {
      return await createEvidenceJoin({
        ports: this.config.evidence,
        source: this.config.source as `${string}:${string}`,
        executor: this.config.executor as `${string}:${string}`,
        now: () => this.now(),
      }).resume(paths);
    } catch (error) {
      if (posture === "always") {
        this.appendTerminal(attempt, {
          state: "failed",
          blame: "infrastructure",
          category: "dependency-unavailable",
          detail: error instanceof Error
            ? `evidence capture resume failed: ${error.message}`
            : "evidence capture resume failed",
        });
      } else {
        this.journal(attempt).append({
          attemptId: attempt,
          type: "progress",
          time: this.now(),
          details: {
            degradation: "evidence-capture-resume-failed",
            source: this.config.source,
          },
        });
      }
      return undefined;
    }
  }

  private selectLauncher(view: TaskView): LauncherContract {
    const harness = requestedInventoryValue(
      (view.effectiveRequirements as Record<string, unknown>).harness,
    );
    try {
      return selectProfileSafeLauncher(this.config.launchers, view.profile.profile, harness);
    } catch (error) {
      throw new TaskExecutionError("unsupported-requirement", {
        detail: error instanceof Error ? error.message : "no launcher supports the resolved profile",
      });
    }
  }

  private persistAccepted(stored: StoredSubmission, attempt: AttemptMeta): void {
    const submissionDirectory = this.submissionDirectory(stored.parsed.submission);
    atomicWrite(join(submissionDirectory, "task.sealed"), stored.taskBytes);
    atomicWrite(join(submissionDirectory, "submission.sealed"), stored.submissionBytes);
    atomicWrite(
      join(submissionDirectory, "metadata.json"),
      serializeCanonicalJson({
        digest: stored.digest,
        taskDigest: stored.taskDigest,
        attempt: stored.attempt,
        submission: asSubmissionUri(stored.parsed.submission),
        requester: stored.parsed.requester,
        idempotencyKey: stored.parsed.idempotencyKey,
      } satisfies PersistedSubmission as unknown as JsonValue),
    );
    this.persistAttemptMetadata(attempt);
  }

  private persistAttemptMetadata(attempt: AttemptMeta): void {
    atomicWrite(
      join(this.paths(attempt.attempt).meta, "attempt.json"),
      serializeCanonicalJson(attempt as unknown as JsonValue),
    );
  }

  private rebuildIndexes(): void {
    const submissionsRoot = join(this.config.stateRoot, "submissions");
    if (existsSync(submissionsRoot)) {
      for (const entry of readdirSync(submissionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(submissionsRoot, entry.name);
        const metadataPath = join(directory, "metadata.json");
        const taskPath = join(directory, "task.sealed");
        const submissionPath = join(directory, "submission.sealed");
        if (
          !existsSync(metadataPath)
          || !existsSync(taskPath)
          || !existsSync(submissionPath)
        ) {
          continue;
        }
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as PersistedSubmission;
          const submissionBytes = new Uint8Array(readFileSync(submissionPath));
          const parsed = decode(submissionBytes) as SubmissionRecord;
          const stored: StoredSubmission = {
            taskBytes: new Uint8Array(readFileSync(taskPath)),
            submissionBytes,
            digest: metadata.digest,
            parsed,
            taskDigest: metadata.taskDigest,
            attempt: metadata.attempt,
          };
          this.submissionsByScope.set(
            scopeKey(metadata.requester, metadata.idempotencyKey),
            stored,
          );
          this.submissionsByUri.set(metadata.submission, stored);
        } catch {
          // A corrupt durable entry is surfaced by recover for its reference; one malformed
          // directory must not make unrelated accepted submissions disappear at startup.
        }
      }
    }

    const live: AttemptUri[] = [];
    const attemptsRoot = join(this.config.stateRoot, "attempts");
    if (existsSync(attemptsRoot)) {
      for (const entry of readdirSync(attemptsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const attempt = asAttemptUri(`urn:uuid:${entry.name}`);
        const metadataPath = join(attemptsRoot, entry.name, "meta", "attempt.json");
        if (!existsSync(metadataPath)) continue;
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as PersistedAttempt;
          this.attempts.set(attempt, metadata);
          if (!foldAttemptRecord(this.journal(attempt).read()).terminal) live.push(attempt);
        } catch {
          // recover(ref) is the fail-loud reconciliation surface for corrupt attempts.
        }
      }
    }
    this.capacity.restore(live);
  }

  private resolveAttempt(ref: SubmissionUri | AttemptUri): AttemptUri {
    if (this.attempts.has(ref as AttemptUri)) return ref as AttemptUri;
    const stored = this.submissionsByUri.get(ref as SubmissionUri);
    if (stored !== undefined) return stored.attempt;
    throw new TaskExecutionError("attempt-not-found", {
      detail: `no Attempt or Submission for ref "${ref}"`,
    });
  }

  private observations(attempt: AttemptUri): ProtocolObservation[] {
    return projectObservations(this.journal(attempt).read(), {
      defaultSource: this.config.source,
    });
  }

  async observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot> {
    const attempt = this.resolveAttempt(ref);
    const metadata = this.attempts.get(attempt);
    if (metadata === undefined) {
      throw new TaskExecutionError("attempt-not-found", {
        detail: `no Attempt for ref "${ref}"`,
      });
    }
    const observations = this.observations(attempt);
    const derived = foldObservations(observations, {
      now: this.now(),
      effectiveDeadline: metadata.effectiveDeadline,
    });
    const descriptor: AttemptDescriptor = {
      attempt,
      task: metadata.task,
      submission: metadata.submission,
      ...(metadata.annotations === undefined
        ? {}
        : { annotations: metadata.annotations }),
      derived,
    };
    return {
      descriptor,
      cursor: {
        sequence: observations.at(-1)?.sequence ?? "0000000000000000",
      },
      observations,
    };
  }

  async *watch(
    ref: SubmissionUri | AttemptUri,
    cursor?: ObservationCursor,
  ): AsyncIterable<ProtocolObservation> {
    this.assertWriter();
    const attempt = this.resolveAttempt(ref);
    let lastSequence = cursor?.sequence ?? "0000000000000000";
    const abort = new AbortController();
    try {
      while (true) {
        const snapshot = await this.observe(ref);
        for (const observation of snapshot.observations) {
          if (observation.sequence > lastSequence) {
            yield observation;
            lastSequence = observation.sequence;
          }
        }
        if (snapshot.descriptor.derived.terminal || this.shutdownStarted) return;
        if (this.observations(attempt).some((observation) => observation.sequence > lastSequence)) {
          continue;
        }
        await this.watchRegistry.wait(attempt, lastSequence, abort.signal);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "watch cancelled") return;
      throw error;
    } finally {
      abort.abort();
    }
  }

  async cancel(attempt: AttemptUri, reason: string): Promise<CancelAck> {
    this.assertWriter();
    const snapshot = await this.observe(attempt);
    this.assertWriter();
    if (snapshot.descriptor.derived.terminal) {
      return {
        requested: false,
        terminalState: snapshot.descriptor.derived.state,
      };
    }
    if (this.journal(attempt).read().some((event) => event.type === "cancel-requested")) {
      return { requested: true };
    }
    this.requestStop(attempt, reason, false);
    return { requested: true };
  }

  /** Requests the shim-owned termination ladder. It intentionally records intent, not outcome. */
  private requestStop(attempt: AttemptUri, reason: string, deadline: boolean): void {
    if (this.shutdownStarted || !this.writer.acquired) return;
    if (foldAttemptRecord(this.journal(attempt).read()).terminal) return;
    if (this.journal(attempt).read().some((event) => event.type === "cancel-requested")) return;
    this.journal(attempt).append({
      attemptId: attempt,
      type: "cancel-requested",
      time: this.now(),
      details: {
        reason,
        requestedBy: "TaskExecutionBackend.cancel",
        ...(deadline ? { deadline: true } : {}),
        source: this.config.source,
      },
    });
    this.relayPendingCancellation(attempt);
  }

  /** The assembly records intent, then wakes only the fingerprint-verified shim. */
  private relayPendingCancellation(attempt: AttemptUri): void {
    if (!this.journal(attempt).read().some((event) => event.type === "cancel-requested")) return;
    const paths = this.paths(attempt);
    const fingerprint = readShimFingerprint(paths.meta);
    if (fingerprint === null) return;
    writeShimCancellationCommand(paths.meta, {
      nonce: fingerprint.nonce,
      graceMs: this.config.cancellationGraceMs ?? 10_000,
      killPollCeilingMs: this.config.cancellationKillPollCeilingMs ?? 30_000,
    });
    requestShimCancellation(paths.meta, fingerprint);
  }

  /** Deadline timing starts at `attempt-started`; preparation is deliberately excluded. */
  private armExpiry(attempt: AttemptUri, recovering = false): void {
    this.clearAttemptTimers(attempt);
    const metadata = this.attempts.get(attempt);
    if (metadata === undefined) return;
    const dueAt = Date.parse(metadata.effectiveDeadline);
    const maximumTimerDelayMs = 2_147_483_647;
    if (Number.isFinite(dueAt)) {
      const schedule = (): void => {
        if (this.shutdownStarted || !this.writer.acquired) return;
        const remainingMs = Math.max(0, dueAt - Date.now());
        const timer = setTimeout(
          remainingMs > maximumTimerDelayMs
            ? schedule
            : () => {
                if (this.shutdownStarted || !this.writer.acquired) return;
                this.requestStop(attempt, "execution deadline expired", true);
              },
          Math.min(remainingMs, maximumTimerDelayMs),
        );
        timer.unref();
        this.trackAttemptTimer(attempt, timer);
      };
      schedule();
    }
    if (metadata.maxAttemptDurationMs === undefined) return;
    const startedNs = metadata.execStartedAtMonotonicNs;
    const identity = metadata.monotonicClockIdentity;
    const currentIdentity = monotonicClockIdentity();
    if (startedNs === undefined || (recovering && (identity === undefined || currentIdentity === undefined || identity !== currentIdentity))) {
      this.journal(attempt).append({
        attemptId: attempt,
        type: "progress",
        time: this.now(),
        details: { degradation: "relative-deadline-monotonic-unavailable", source: this.config.source },
      });
      this.requestStop(attempt, "relative execution deadline cannot be safely re-armed", true);
      return;
    }
    let elapsedMs: number;
    try {
      const elapsedNs = monotonicNowNs() - BigInt(startedNs);
      if (elapsedNs < 0n) throw new Error("monotonic clock reset");
      elapsedMs = Number(elapsedNs / 1_000_000n);
      if (!Number.isSafeInteger(elapsedMs)) throw new Error("monotonic duration is unusable");
    } catch {
      this.journal(attempt).append({
        attemptId: attempt,
        type: "progress",
        time: this.now(),
        details: { degradation: "relative-deadline-monotonic-unavailable", source: this.config.source },
      });
      this.requestStop(attempt, "relative execution deadline cannot be safely re-armed", true);
      return;
    }
    const scheduleRelative = (): void => {
      if (this.shutdownStarted || !this.writer.acquired) return;
      const nowElapsedMs = Number((monotonicNowNs() - BigInt(startedNs)) / 1_000_000n);
      const remainingMs = Math.max(0, metadata.maxAttemptDurationMs! - nowElapsedMs);
      const timer = setTimeout(
        remainingMs > maximumTimerDelayMs
          ? scheduleRelative
          : () => {
              if (this.shutdownStarted || !this.writer.acquired) return;
              this.requestStop(attempt, "execution deadline expired", true);
            },
        Math.min(remainingMs, maximumTimerDelayMs),
      );
      timer.unref();
      this.trackAttemptTimer(attempt, timer);
    };
    // `elapsedMs` establishes that the stored monotonic reading is usable before a timer is armed.
    void elapsedMs;
    scheduleRelative();
  }

  private recordHeartbeatStaleness(attempt: AttemptUri, meta: string): void {
    if (this.shutdownStarted || !this.writer.acquired) return;
    if (this.journal(attempt).read().some((event) => event.type === "progress" && event.details["degradation"] === "heartbeat-stale")) return;
    try {
      const heartbeat = readHeartbeat(meta);
      if (heartbeat === null) return;
      const lastMonotonicMs = Number(BigInt(heartbeat.monotonicMs) / 1_000_000n);
      const nowMonotonicMs = Number(monotonicNowNs() / 1_000_000n);
      if (!Number.isSafeInteger(lastMonotonicMs) || !Number.isSafeInteger(nowMonotonicMs)
        || !heartbeatIsStale({ lastMonotonicMs, nowMonotonicMs, intervalMs: this.config.heartbeatIntervalMs ?? 15_000 })) return;
      this.journal(attempt).append({
        attemptId: attempt,
        type: "progress",
        time: this.now(),
        details: { degradation: "heartbeat-stale", source: this.config.source },
      });
    } catch {
      // A malformed executor-owned heartbeat is not an outcome and must not kill the attempt.
    }
  }

  private reconstructRecoveryContext(
    attempt: AttemptUri,
    events: readonly JournalEvent[],
  ): {
    readonly taskBytes: Uint8Array;
    readonly task: TaskSpecification;
    readonly provisioner: ProvisionerContract;
    readonly plan: LaunchPlan;
    readonly identity: AttemptIdentity;
  } {
    const record = foldAttemptRecord(events);
    const metadata = this.attempts.get(attempt);
    const intent = events.find((event) => event.type === "spawn-intended");
    const engaged = events.find((event) => event.type === "attempt-engaged");
    if (
      metadata === undefined
      || intent === undefined
      || engaged === undefined
      || typeof intent.details["provisioner"] !== "string"
    ) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: "recovery lacks durable attempt, engagement, or provisioner identity",
      });
    }
    const stored = this.submissionsByUri.get(metadata.submission);
    if (stored === undefined || stored.attempt !== attempt) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: "recovery lacks the exact persisted Task and Submission bytes",
      });
    }
    const checked = this.decodeAndSealCheck(stored.taskBytes, stored.submissionBytes);
    if (!checked.ok) {
      throw new TaskExecutionError("invalid-document", {
        detail: `persisted Task or Submission failed exact recovery validation: ${checked.detail}`,
      });
    }
    const taskDigest = documentDigest(stored.taskBytes);
    const submissionDigest = documentDigest(stored.submissionBytes);
    if (
      taskDigest !== stored.taskDigest
      || taskDigest !== metadata.task
      || record.taskDigest !== taskDigest
      || engaged.details["taskDigest"] !== taskDigest
      || submissionDigest !== stored.digest
      || checked.submission.submission !== metadata.submission
      || stored.parsed.submission !== metadata.submission
      || record.submissionUri !== metadata.submission
      || engaged.details["submission"] !== metadata.submission
      || record.attemptUri !== attempt
      || engaged.details["attempt"] !== attempt
      || record.nonce !== checked.submission.nonce
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "persisted recovery identities do not bind the exact Task, Submission, and Attempt",
      });
    }
    const dispatchPath = join(this.paths(attempt).meta, "dispatch-context.sealed");
    let dispatchContextBytes: Uint8Array;
    let dispatchDocument: unknown;
    try {
      dispatchContextBytes = new Uint8Array(readFileSync(dispatchPath));
      dispatchDocument = decode(dispatchContextBytes);
    } catch (error) {
      throw new TaskExecutionError("invalid-document", {
        detail: error instanceof Error
          ? `persisted dispatch context is unreadable: ${error.message}`
          : "persisted dispatch context is unreadable",
      });
    }
    const dispatchValidation = validateDispatchContext(dispatchDocument);
    if (
      !dispatchValidation.conforms
      || !bytesEqual(
        serializeCanonicalJson(dispatchDocument as JsonValue),
        dispatchContextBytes,
      )
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "persisted dispatch context is not exact canonical conforming bytes",
      });
    }
    const dispatch = dispatchDocument as DispatchContext;
    if (
      dispatch.taskDigest !== taskDigest
      || dispatch.submission !== metadata.submission
      || dispatch.nonce !== checked.submission.nonce
      || dispatch.attempt !== attempt
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "persisted dispatch context does not bind this Task, Submission, nonce, and Attempt",
      });
    }
    const dispatchDescriptor = engaged.details["dispatchContext"];
    if (
      !isRecord(dispatchDescriptor)
      || !isRecord(dispatchDescriptor.digest)
      || dispatchDescriptor.uri !== `urn:jinn:backend-local:dispatch-context:${attempt.slice("urn:uuid:".length)}`
      || dispatchDescriptor.digest["sha256"] !== sha256Hex(dispatchContextBytes)
    ) {
      throw new TaskExecutionError("invalid-document", {
        detail: "attempt engagement does not bind the persisted dispatch-context bytes",
      });
    }
    const profile = this.profile(checked.task);
    const merged = mergeRequirements(
      checked.task.requirements,
      checked.submission.requirements,
      {
        ...CORE_REQUIREMENT_CLASSES,
        ...Object.fromEntries(
          profile.requirementKeys.map(({ key, comparisonClass }) => [key, comparisonClass]),
        ),
      },
    );
    if (!merged.ok) {
      throw new TaskExecutionError("invalid-document", {
        detail: `persisted requirements no longer merge at ${merged.key}`,
      });
    }
    const identity: AttemptIdentity = {
      attemptUri: attempt,
      nonce: checked.submission.nonce,
      attemptNumber: record.attemptNumber ?? 1,
    };
    const selected = this.config.provisioner({
      sealedTaskBytes: stored.taskBytes.slice(),
      dispatchContextBytes: dispatchContextBytes.slice(),
      task: checked.task,
      submission: checked.submission,
      attempt: identity,
    });
    if (
      !validProvisionerId(selected.id)
      || selected.id !== intent.details["provisioner"]
    ) {
      const existing = this.journal(attempt).read().some((event) =>
        event.type === "reconciliation"
        && event.details["classification"] === "contradictory"
        && event.details["reason"] === "provisioner-identity-mismatch");
      if (!existing) {
        this.journal(attempt).append({
          attemptId: attempt,
          type: "reconciliation",
          time: this.now(),
          details: {
            classification: "contradictory",
            reason: "provisioner-identity-mismatch",
            expected: intent.details["provisioner"],
            actual: selected.id,
            source: this.config.source,
          },
        });
      }
      throw new TaskExecutionError("backend-unavailable", {
        detail: "recovery provisioner identity differs from spawn intent",
      });
    }
    return {
      taskBytes: stored.taskBytes.slice(),
      task: checked.task,
      provisioner: selected.contract,
      plan: this.journaledPlan(intent),
      identity,
    };
  }

  async recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport> {
    return this.trackInflight(this.recoverRef(ref));
  }

  private async recoverRef(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport> {
    this.assertWriter();
    const override = this.reconciliationOverrides.get(ref);
    if (override !== undefined) return override;
    let attempt: AttemptUri;
    try {
      attempt = this.resolveAttempt(ref);
    } catch {
      return { classification: "absent", detail: `no durable record for ref "${ref}"` };
    }
    const events = this.journal(attempt).read();
    const record = foldAttemptRecord(events);
    const paths = this.paths(attempt);
    const checkpoint = this.deliveryCheckpointPath(attempt);
    // An active in-process worker owns observation and completion for every nonterminal phase.
    // Recovery remains restart-capable because ownership is deliberately process-local.
    if ((this.workerAttempts.get(attempt) ?? 0) > 0 && !record.terminal) {
      return { classification: "matching" };
    }
    const shim = probeShimAlive(paths.meta);
    const rawOutcome = readOutcome(paths.meta);
    const outcome = rawOutcome !== null && rawOutcome.nonce === record.nonce ? rawOutcome : null;
    const groupPids = this.harnessGroupPids(paths);
    let reconciliation = reconcileAttempt(record, {
      processAlive: shim.alive || groupPids.length > 0,
      shimAlive: shim.alive,
      outcomePresent: rawOutcome !== null,
      nonceMatches: rawOutcome === null ? undefined : outcome !== null,
      deliveryCheckpointPresent: existsSync(checkpoint),
      shimFingerprintVerifiedSurvivorsAlive: record.terminal && groupPids.length > 0,
      pids: groupPids,
    });
    let staleOutcome = false;
    if (reconciliation.classification === "stale-foreign") {
      staleOutcome = true;
      reconciliation = reconcileAttempt(record, {
        processAlive: shim.alive || groupPids.length > 0,
        shimAlive: shim.alive,
        outcomePresent: false,
        deliveryCheckpointPresent: existsSync(checkpoint),
        shimFingerprintVerifiedSurvivorsAlive: record.terminal && groupPids.length > 0,
        pids: groupPids,
      });
      this.journal(attempt).append({
        attemptId: attempt,
        type: "reconciliation",
        time: this.now(),
        details: {
          classification: "stale-foreign",
          action: "ignored-nonce-mismatched-outcome",
          source: this.config.source,
        },
      });
    }
    if (reconciliation.classification === "orphaned" || reconciliation.classification === "contradictory") {
      const killedPids = await this.killHarnessGroup(paths);
      this.journal(attempt).append({
        attemptId: attempt,
        type: "reconciliation",
        time: this.now(),
        details: {
          classification: reconciliation.classification,
          killedPids,
          source: this.config.source,
        },
      });
      if (reconciliation.classification === "orphaned") {
        this.appendTerminal(attempt, { state: "lost", blame: "infrastructure", category: "backend-unavailable", detail: "dead shim left live harness group", killedPids });
      }
      return reconciliation.classification === "contradictory"
        ? { classification: "contradictory", detail: "terminal state contradicted live survivors or durable terminals" }
        : { classification: "matching", detail: "orphaned" };
    }
    if (!existsSync(checkpoint) && (reconciliation.classification === "absent-never-executed" || reconciliation.classification === "absent")) {
      this.appendTerminal(attempt, {
        state: reconciliation.terminalState,
        ...(reconciliation.blame === undefined ? {} : { blame: reconciliation.blame }),
        category: "backend-unavailable",
        detail: reconciliation.classification === "absent-never-executed"
          ? "attempt was never spawned"
          : "spawn intent has no recoverable shim or outcome",
        ...(reconciliation.classification === "absent-never-executed" ? { neverExecuted: true } : {}),
      });
      return {
        classification: "absent",
        detail: staleOutcome ? "stale-foreign" : reconciliation.classification,
      };
    }
    if (existsSync(checkpoint)) {
      const checkpointBytes = new Uint8Array(readFileSync(checkpoint));
      await this.recordDelivery(attempt, checkpointBytes);
      const current = foldAttemptRecord(this.journal(attempt).read());
      if (!current.terminal || current.terminalState === "lost") {
        this.appendTerminal(attempt, { state: "delivered" });
      }
      return { classification: "matching" };
    }
    if (reconciliation.classification === "matching" && record.terminal) {
      return { classification: "matching" };
    }

    // Every completion-capable row reconstructs from the exact durable contracts. The launcher
    // is deliberately absent from this path: recovery parses the fsynced LaunchPlan.
    const recovered = this.reconstructRecoveryContext(attempt, events);
    const completionClassifications = new Set([
      "matching-late",
      "harvesting-resume",
      "recording-resume",
      "corrected",
    ]);
    if (completionClassifications.has(reconciliation.classification)) {
      const finished = this.journal(attempt).read().find((event) => event.type === "exec-finished");
      const execution = outcome === null
        ? { ...(typeof finished?.details["exitCode"] === "number" ? { exitCode: finished.details["exitCode"] } : {}), ...(typeof finished?.details["termSignal"] === "string" ? { signal: finished.details["termSignal"] } : {}) }
        : { ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }), ...(outcome.termSignal === null ? {} : { signal: outcome.termSignal }) };
      const posture = this.config.recorderAvailability ?? "none";
      const capture = await this.resumeEvidenceCapture(attempt, paths, posture);
      await this.completeAttempt({ attempt: recovered.identity, taskBytes: recovered.taskBytes, task: recovered.task, paths, provisioner: recovered.provisioner, plan: recovered.plan, execution, capture, capturePosture: posture });
    } else if (reconciliation.classification === "matching") {
      // The real shim remains the custodian; recovery only resumes observation and completion.
      // The durable monotonic start reading is re-armed only when it belongs to this same boot.
      const metadata = this.attempts.get(attempt);
      if (metadata !== undefined) this.armExpiry(attempt, true);
      const posture = this.config.recorderAvailability ?? "none";
      const worker = this.waitForOutcome(attempt, paths.meta, recovered.identity.nonce)
        .then(async (execution) => this.completeAttempt({ attempt: recovered.identity, taskBytes: recovered.taskBytes, task: recovered.task, paths, provisioner: recovered.provisioner, plan: recovered.plan, execution, capture: await this.resumeEvidenceCapture(attempt, paths, posture), capturePosture: posture }))
        .catch((error: unknown) => {
          if (this.closeInvoked) {
            this.recordShutdownDrainFailure(error);
            return;
          }
          if (this.shutdownStarted) return;
          if (!foldAttemptRecord(this.journal(attempt).read()).terminal) {
            this.appendTerminal(attempt, { state: "lost", blame: "infrastructure", category: "backend-unavailable", detail: error instanceof Error ? error.message : "resumed shim supervision failed" });
          }
        });
      this.trackWorker(attempt, worker);
    }
    return {
      classification: "matching",
    };
  }

  async deliveries(attempt: AttemptUri): Promise<DeliveryRef[]> {
    if (!this.attempts.has(attempt)) {
      throw new TaskExecutionError("attempt-not-found", {
        detail: `no Attempt "${attempt}"`,
      });
    }
    const checkpoint = this.deliveryCheckpointPath(attempt);
    if (!existsSync(checkpoint)) return [];
    const bytes = new Uint8Array(readFileSync(checkpoint));
    return [{ attempt, digest: documentDigest(bytes) }];
  }

  async fetchDelivery(ref: DeliveryRef): Promise<Uint8Array> {
    const checkpoint = this.deliveryCheckpointPath(ref.attempt);
    if (!existsSync(checkpoint)) {
      throw new TaskExecutionError("result-unavailable", {
        detail: `no Delivery recorded for Attempt "${ref.attempt}"`,
      });
    }
    const bytes = new Uint8Array(readFileSync(checkpoint));
    if (documentDigest(bytes) !== ref.digest) {
      throw new TaskExecutionError("result-unavailable", {
        detail: `Delivery "${ref.digest}" is not recorded for Attempt "${ref.attempt}"`,
      });
    }
    return bytes;
  }

  async fetchArtifact(descriptor: {
    readonly uri?: string;
    readonly digest?: Readonly<Record<string, string>>;
  }): Promise<Uint8Array> {
    if (descriptor.uri?.startsWith("file:") === true) {
      const bytes = new Uint8Array(readFileSync(new URL(descriptor.uri)));
      const expected = descriptor.digest?.sha256;
      if (expected !== undefined && sha256Hex(bytes) !== expected) {
        throw new TaskExecutionError("content-corruption", {
          detail: "local artifact bytes do not match the descriptor digest",
        });
      }
      return bytes;
    }

    const expected = descriptor.digest?.sha256;
    if (expected === undefined || !/^[0-9a-f]{64}$/u.test(expected)) {
      throw new TaskExecutionError("result-unavailable", {
        detail: "this local artifact descriptor has neither a file locator nor a valid sha256 digest",
      });
    }

    for (const attempt of this.attempts.keys()) {
      const harvested = this.journal(attempt).read().find((event) => event.type === "harvested");
      if (harvested === undefined) continue;
      const artifact = this.journaledHarvest(harvested).manifest.find(
        (candidate) => String(candidate.sha256).replace(/^sha256:/u, "") === expected,
      );
      if (artifact === undefined) continue;
      if (
        artifact.path.startsWith("/")
        || artifact.path.includes("\\")
        || artifact.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw new TaskExecutionError("content-corruption", {
          detail: "journaled artifact path is not a contained output path",
        });
      }
      const out = realpathSync(this.paths(attempt).out);
      const candidate = realpathSync(join(out, artifact.path));
      if (!candidate.startsWith(`${out}/`)) {
        throw new TaskExecutionError("content-corruption", {
          detail: "journaled artifact path escaped the Attempt output directory",
        });
      }
      const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
      if (bytes.byteLength !== artifact.sizeBytes || sha256Hex(bytes) !== expected) {
        throw new TaskExecutionError("content-corruption", {
          detail: "harvested artifact bytes do not match the journaled digest and size",
        });
      }
      return bytes;
    }

    throw new TaskExecutionError("result-unavailable", {
      detail: `no harvested output is recorded for sha256:${expected}`,
    });
  }

  // --- explicit conformance seam ---

  async drive(
    attempt: AttemptUri,
    observations: readonly ProtocolObservation[],
  ): Promise<void> {
    this.assertWriter();
    if (!this.attempts.has(attempt)) {
      throw new TaskExecutionError("attempt-not-found", {
        detail: `no Attempt "${attempt}"`,
      });
    }
    for (const observation of observations) {
      let type: JournalEvent["type"];
      let details: Record<string, unknown> = {
        ...observation.data,
        source: this.config.source,
      };
      switch (observation.type) {
        case "network.jinn.task-execution.attempt-started.v1":
          type = "attempt-started";
          break;
        case "network.jinn.task-execution.progress.v1":
          type = "progress";
          break;
        case "network.jinn.task-execution.cancel-requested.v1":
          type = "cancel-requested";
          break;
        case "network.jinn.task-execution.cancel-acknowledged.v1":
          type = "cancel-acknowledged";
          break;
        case "network.jinn.task-execution.execution-observed.v1":
          type = "execution-observed";
          break;
        case "network.jinn.task-execution.attempt-terminal.v1":
          type = "attempt-terminal";
          break;
        default:
          continue;
      }
      this.journal(attempt).append({
        attemptId: attempt,
        type,
        time: observation.time,
        details,
        ...(type === "attempt-terminal"
          && (details["state"] === "failed" || details["state"] === "lost")
          ? { failsAttempt: true }
          : {}),
      });
      if (type === "attempt-terminal") this.capacity.release(attempt);
    }
  }

  async recordDelivery(
    attempt: AttemptUri,
    deliveryBytes: Uint8Array,
    executorBindingEnvelope?: Uint8Array,
  ): Promise<void> {
    return this.trackInflight(this.recordDeliveryBytes(attempt, deliveryBytes, executorBindingEnvelope));
  }

  private async recordDeliveryBytes(
    attempt: AttemptUri,
    deliveryBytes: Uint8Array,
    executorBindingEnvelope?: Uint8Array,
  ): Promise<void> {
    this.assertWriter();
    const metadata = this.attempts.get(attempt);
    if (metadata === undefined) {
      throw new TaskExecutionError("attempt-not-found", {
        detail: `no Attempt "${attempt}"`,
      });
    }
    let document: unknown;
    try {
      document = decode(deliveryBytes);
    } catch (error) {
      throw new TaskExecutionError("invalid-document", {
        detail: error instanceof Error ? error.message : "Delivery decoding failed",
      });
    }
    const validation = validateDelivery(document);
    if (!validation.conforms) {
      throw new TaskExecutionError("invalid-document", {
        detail: detail(validation.errors),
      });
    }
    if (!bytesEqual(sealDelivery(document), deliveryBytes)) {
      throw new TaskExecutionError("invalid-document", {
        detail: "Delivery bytes are not the exact canonical sealed bytes",
      });
    }
    const delivery = document as { readonly attempt: string; readonly task: string };
    if (delivery.attempt !== attempt || delivery.task !== metadata.task) {
      throw new TaskExecutionError("invalid-reference", {
        detail: "Delivery does not bind this Attempt and Task",
      });
    }

    const checkpoint = this.deliveryCheckpointPath(attempt);
    if (existsSync(checkpoint)) {
      const existing = new Uint8Array(readFileSync(checkpoint));
      if (!bytesEqual(existing, deliveryBytes)) {
        throw new TaskExecutionError("protocol-violation", {
          detail: "seal-once checkpoint already contains different Delivery bytes",
        });
      }
    } else {
      atomicWrite(checkpoint, deliveryBytes);
      this.journal(attempt).append({
        attemptId: attempt,
        type: "delivery-checkpointed",
        time: this.now(),
        details: {
          digest: documentDigest(deliveryBytes),
          source: this.config.source,
          // Finding E31: present only when a delivery-signing key was configured at seal time --
          // absent leaves this event's `details` identical to before this finding (additive).
          // Carried here (not a new journal event type, and not embedded in `deliveryBytes`
          // itself) because `JOURNAL_EVENT_TYPES` is a frozen vocabulary
          // (`@jinn-network/task-execution-supervisor`) this package does not own, and the
          // envelope must never be part of the Delivery's own sealed bytes (seal-once).
          ...(executorBindingEnvelope === undefined
            ? {}
            : { executorBindingEnvelope: Buffer.from(executorBindingEnvelope).toString("base64") }),
        },
      });
      this.config.faults?.afterDeliveryCheckpoint?.();
    }

    const digest = documentDigest(deliveryBytes);
    const recorded = this.journal(attempt).read().some(
      (event) =>
        event.type === "delivery-recorded"
        && event.details["digest"] === digest,
    );
    if (!recorded) {
      this.journal(attempt).append({
        attemptId: attempt,
        type: "delivery-recorded",
        time: this.now(),
        details: { digest, source: this.config.source },
      });
    }
  }

  simulateReconciliation(
    ref: SubmissionUri | AttemptUri,
    outcome: ReconciliationReport,
  ): void {
    this.assertWriter();
    this.reconciliationOverrides.set(ref, outcome);
  }

  deliveryCheckpointPath(attempt: AttemptUri): string {
    return join(this.paths(attempt).meta, "delivery.sealed");
  }

  /**
   * Looks up the DSSE executor-binding envelope produced when a Delivery was first sealed and
   * signed (finding E31), keyed by the Delivery's own digest -- `SettlementGradeVerificationInput`
   * (`@jinn-network/marketplace-binding`) carries no AttemptUri, only `deliveryDigest`, so digest
   * is the only identity available across that package boundary (see
   * `client/src/daemon/settlement-grade.ts`). Returns `undefined` when no delivery-signing key
   * was configured at seal time (the additive default), or the digest is unknown to this backend.
   * An explicit implementation seam, like `recordDelivery` -- not part of `TaskExecutionBackend`.
   */
  getDeliverySignature(digest: `sha256:${string}`): Uint8Array | undefined {
    for (const attempt of this.attempts.keys()) {
      const event = this.journal(attempt).read().find(
        (candidate) => candidate.type === "delivery-checkpointed" && candidate.details["digest"] === digest,
      );
      if (event === undefined) continue;
      const envelope = event.details["executorBindingEnvelope"];
      return typeof envelope === "string" ? Uint8Array.from(Buffer.from(envelope, "base64")) : undefined;
    }
    return undefined;
  }

  close(): void {
    this.closeInvoked = true;
    void this.shutdown().catch(() => {
      // Sync close must not leave an unhandled rejection; await shutdown() surfaces it.
    });
  }

  /** Drains accepted workers and in-flight state-root mutations, then releases the writer lock. */
  async shutdown(): Promise<void> {
    if (this.shutdownComplete) return;
    if (this.shutdownPromise === undefined) {
      this.shutdownStarted = true;
      this.closed = true;
      this.watchRegistry.closeAll();
      this.clearAllAttemptTimers();
      this.shutdownPromise = this.runShutdown();
    }
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    const drainFailures = await this.drainFixedPoint();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const failures = [...this.shutdownDrainFailures, ...drainFailures];
    if (this.writer.acquired) this.writer.release();
    this.shutdownComplete = true;
    if (failures.length > 0 && this.closeInvoked) {
      throw failures[0];
    }
  }

  /** Waits for work already accepted by this embedded backend to stop mutating its state root. */
  async drain(): Promise<void> {
    await this.drainFixedPoint();
  }

  private async drainFixedPoint(): Promise<Error[]> {
    const failures: Error[] = [];
    while (this.workers.size > 0 || this.inflight.size > 0) {
      const pending = [...this.workers, ...this.inflight];
      if (pending.length === 0) break;
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
        }
      }
    }
    return failures;
  }
}

export function makeLocalTaskExecutionBackend(
  config: LocalTaskExecutionBackendConfig,
): LocalTaskExecutionBackend {
  return new LocalTaskExecutionBackend(config);
}
