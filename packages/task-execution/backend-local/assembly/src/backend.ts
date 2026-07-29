// SPDX-License-Identifier: Apache-2.0

import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
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
} from "@jinn-network/task-execution-launchers";
import { interpretResult } from "@jinn-network/task-execution-launchers";
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
import {
  acquireStateRootWriter,
  CapacityGate,
  type StateRootWriter,
} from "./capacity.js";
import {
  assembleCapabilities,
  type CapabilityProvisionerConfig,
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

function parseLaunchPlan(value: unknown): LaunchPlan {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ["argv", "env", "cwd", "validExitCodes", "resultContract", "interruptionBehavior"],
    ["blameExitCodes", "secretForwards"],
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
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
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
  readonly cancellationGraceMs?: number;
  readonly cancellationKillPollCeilingMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => string;
  readonly faults?: LocalBackendFaults;
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
  private closed = false;

  constructor(private readonly config: LocalTaskExecutionBackendConfig) {
    this.writer = acquireStateRootWriter(config.stateRoot);
    this.capacity = new CapacityGate(config.maxConcurrentAttempts ?? 4);
    this.rebuildIndexes();
  }

  private now(): string {
    return this.config.now?.() ?? new Date().toISOString();
  }

  private assertWriter(): void {
    if (this.closed) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: "local backend instance is closed",
      });
    }
    if (!this.writer.acquired) throw this.writer.error;
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
    return openAttemptJournal(this.paths(attempt).meta);
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
      custody: nativeCustodySupport(),
    });
  }

  async capabilities(): Promise<BackendCapabilities> {
    return this.capabilitiesValue();
  }

  async preflight(_request: PreflightRequest): Promise<PreflightReport> {
    this.assertWriter();
    const custody = nativeCustodySupport();
    if (!custody.ready) {
      return {
        ready: false,
        detail: custody.detail ?? "attempt custody support is unavailable",
        error: new TaskExecutionError("backend-unavailable", {
          detail: custody.detail ?? "attempt custody support is unavailable",
        }),
      };
    }
    const probes: ProbeResult[] = await Promise.all(
      this.config.launchers.map(
        async (launcher): Promise<ProbeResult> =>
          launcher.probe?.() ?? { ready: true },
      ),
    );
    const failed = probes.find((probe) => !probe.ready);
    return failed === undefined
      ? { ready: true }
      : {
          ready: false,
          detail: failed.detail ?? "a configured launcher is not ready",
          error: new TaskExecutionError("backend-unavailable", {
            detail: failed.detail ?? "launcher probe failed",
          }),
        };
  }

  async submit(
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
      const launcher = this.selectLauncher(view);
      const plan = launcher.plan(view, this.paths(attempt), identity);
      const spawn: SpawnRequest = {
        argv: plan.argv,
        env: provisioner.executionEnv({ env: plan.env, cwd: plan.cwd }),
        cwd: plan.cwd,
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
      const secretForwards = plan.secretForwards ?? [];
      const forwardTargets = new Set(secretForwards.map(({ target }) => target));
      for (const value of Object.values(spawn.env)) {
        if (!value.startsWith("secrets/")) continue;
        const target = value.slice("secrets/".length);
        if (!forwardTargets.has(target)) {
          throw new Error("launch environment secret reference has no declared secret forward");
        }
      }
      if (secretForwards.length > 0) {
        if (this.config.secretForwardResolver === undefined) {
          throw new Error("launcher requires secret forwards but no SecretForwardResolver is configured");
        }
        await materializeSecretForwards({
          attempt: identity,
          secrets: this.paths(attempt).secrets,
          forwards: secretForwards,
          grants: new Map(grants.map((grant) => [grant.key, grant.descriptor])),
          resolver: this.config.secretForwardResolver,
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
      }).catch((error: unknown) => {
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
    readonly spawn: SpawnRequest;
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

    await this.config.faults?.onCompletionPhase?.("before-outcome-wait");
    const execution = await this.waitForOutcome(attempt, input.paths.meta, input.attempt.nonce);
    await this.config.faults?.onCompletionPhase?.("after-outcome");
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
    const attempt = input.attempt.attemptUri;
    const initialRecord = foldAttemptRecord(this.journal(attempt).read());
    if (initialRecord.terminal && initialRecord.terminalState !== "lost") return;
    const append = (type: JournalEvent["type"], details: Readonly<Record<string, unknown>>) => {
      if (this.journal(attempt).read().some((event) => event.type === type)) return;
      this.journal(attempt).append({ attemptId: attempt, type, time: this.now(), details: { ...details, source: this.config.source } });
    };
    append("exec-finished", { exitCode: input.execution.exitCode ?? null, termSignal: input.execution.signal ?? null });
    append("harvest-started", {});
    await this.config.faults?.onCompletionPhase?.("before-harvest");
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
    await this.config.faults?.onCompletionPhase?.("after-harvest");
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
    const envelope = this.readResultEnvelope(input.paths, input.plan, harvest);
    const interpreted = interpretResult(input.plan, input.execution, envelope);
    const observedEvidence = this.journal(attempt).read()
      .find((event) => event.type === "execution-observed");
    let receipt = observedEvidence === undefined
      ? undefined
      : this.journaledEvidenceLink(observedEvidence);
    if (input.capture !== undefined && observedEvidence === undefined) {
      try {
        await input.capture.captureRuntimeObservation({ kind: "resource", entityId: "runtime/process-exit", name: "Harness process exit", value: input.execution.exitCode ?? input.execution.signal ?? "unknown", propertyId: "https://jinn.network/properties/process-exit", origin: { kind: "producer-observed", observer: this.config.source as `${string}:${string}` } });
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
    await this.config.faults?.onCompletionPhase?.("after-evidence");
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
      this.appendTerminal(attempt, { state: "failed", blame: interpreted.blame ?? "task", category: "protocol-violation", detail: interpreted.reasonCode ?? "executor reported failure" });
      return;
    }
    if (existsSync(this.deliveryCheckpointPath(attempt))) {
      this.recordCheckpointEvent(attempt);
      this.appendTerminal(attempt, { state: "delivered", ...(interpreted.reasonCode === undefined ? {} : { detail: interpreted.reasonCode }) });
      return;
    }
    await this.config.faults?.onCompletionPhase?.("before-delivery-checkpoint");
    const deliveryBytes = sealDelivery({ protocol: "https://jinn.network/profiles/task-execution/1.0", attempt, task: documentDigest(input.taskBytes), outputs: harvest.manifest.map((artifact) => ({ name: artifact.path, ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }), digest: { sha256: String(artifact.sha256).replace(/^sha256:/u, "") } })), outcome: interpreted.outcome ?? "fulfilled", ...(receipt === undefined ? {} : { evidenceRecords: [receipt.record], executionIds: [receipt.executionId] }), createdAt: this.now() });
    await this.recordDelivery(attempt, deliveryBytes);
    this.appendTerminal(attempt, { state: "delivered", ...(interpreted.reasonCode === undefined ? {} : { detail: interpreted.reasonCode }) });
  }

  private async waitForShimFingerprint(meta: string): Promise<NonNullable<ReturnType<typeof readShimFingerprint>>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
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
      if (outcome !== null) {
        return {
          ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
          ...(outcome.termSignal === null ? {} : { signal: outcome.termSignal }),
        };
      }
      if (!probeShimAlive(meta).alive) throw new Error("shim exited without a nonce-matching outcome");
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
    const launcher = harness === undefined
      ? this.config.launchers.find((candidate) =>
          candidate.capabilities().taskProfiles.includes(view.profile.profile))
      : this.config.launchers.find((candidate) => candidate.id === harness);
    if (launcher === undefined) {
      throw new TaskExecutionError("unsupported-requirement", {
        detail: harness === undefined
          ? `no launcher supports profile "${view.profile.profile}"`
          : `no registered launcher has id "${harness}"`,
      });
    }
    return launcher;
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
    const snapshot = await this.observe(ref);
    for (const observation of snapshot.observations) {
      if (cursor === undefined || observation.sequence > cursor.sequence) yield observation;
    }
  }

  async cancel(attempt: AttemptUri, reason: string): Promise<CancelAck> {
    const snapshot = await this.observe(attempt);
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
    const metadata = this.attempts.get(attempt);
    if (metadata === undefined) return;
    const dueAt = Date.parse(metadata.effectiveDeadline);
    const maximumTimerDelayMs = 2_147_483_647;
    if (Number.isFinite(dueAt)) {
      const schedule = (): void => {
        const remainingMs = Math.max(0, dueAt - Date.now());
        const timer = setTimeout(
          remainingMs > maximumTimerDelayMs
            ? schedule
            : () => this.requestStop(attempt, "execution deadline expired", true),
          Math.min(remainingMs, maximumTimerDelayMs),
        );
        timer.unref();
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
      const nowElapsedMs = Number((monotonicNowNs() - BigInt(startedNs)) / 1_000_000n);
      const remainingMs = Math.max(0, metadata.maxAttemptDurationMs! - nowElapsedMs);
      const timer = setTimeout(
        remainingMs > maximumTimerDelayMs
          ? scheduleRelative
          : () => this.requestStop(attempt, "execution deadline expired", true),
        Math.min(remainingMs, maximumTimerDelayMs),
      );
      timer.unref();
    };
    // `elapsedMs` establishes that the stored monotonic reading is usable before a timer is armed.
    void elapsedMs;
    scheduleRelative();
  }

  private recordHeartbeatStaleness(attempt: AttemptUri, meta: string): void {
    if (this.journal(attempt).read().some((event) => event.type === "progress" && event.details["degradation"] === "heartbeat-stale")) return;
    const heartbeat = readHeartbeat(meta);
    if (heartbeat === null) return;
    try {
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
    if (descriptor.uri?.startsWith("file:") !== true) {
      throw new TaskExecutionError("result-unavailable", {
        detail: "this local artifact descriptor has no file locator",
      });
    }
    const bytes = new Uint8Array(readFileSync(new URL(descriptor.uri)));
    const expected = descriptor.digest?.sha256;
    if (expected !== undefined && sha256Hex(bytes) !== expected) {
      throw new TaskExecutionError("content-corruption", {
        detail: "local artifact bytes do not match the descriptor digest",
      });
    }
    return bytes;
  }

  // --- explicit conformance seam ---

  async drive(
    attempt: AttemptUri,
    observations: readonly ProtocolObservation[],
  ): Promise<void> {
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
  ): Promise<void> {
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
    this.reconciliationOverrides.set(ref, outcome);
  }

  deliveryCheckpointPath(attempt: AttemptUri): string {
    return join(this.paths(attempt).meta, "delivery.sealed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.writer.acquired) this.writer.release();
  }

  /** Waits for work already accepted by this embedded backend to stop mutating its state root. */
  async drain(): Promise<void> {
    while (this.workers.size > 0) await Promise.all([...this.workers]);
  }
}

export function makeLocalTaskExecutionBackend(
  config: LocalTaskExecutionBackendConfig,
): LocalTaskExecutionBackend {
  return new LocalTaskExecutionBackend(config);
}
