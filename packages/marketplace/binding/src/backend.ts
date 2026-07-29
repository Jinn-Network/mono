// SPDX-License-Identifier: MIT

// The requester-facing `TaskExecutionBackend` (design §13 read together with Finding F2: the
// design's §13 "the TEP kit runs against this binding" implies a requester-facing backend
// subject; this module makes it explicit). `submit` posts (today-mode, via posting.ts);
// `observe`/`deliveries`/`fetchDelivery` project through the injected `MarketplaceObservePort`
// (the real projector, Milestone M4, is not yet built -- see backend-ports.ts); `cancel` is
// honestly unimplemented at this milestone (wires to lifecycle.ts, Milestone M3.4).
//
// This module implements the `TestableBackend` SEAM structurally (ruling §7.19: "any backend put
// under the core kit implements its `TestableBackend` seam explicitly") WITHOUT importing the
// type from `@jinn-network/task-execution-testing` -- that package is forbidden to `binding` by
// the source-boundaries guard (testing-only concerns live in the `marketplace-testing` tree,
// M2.5). `MarketplaceTestableBackend` below is a local, hand-rolled type matching that seam's
// exact shape; TypeScript's structural typing lets `marketplace-testing` pass this backend to
// `describeTaskExecutionBackendContract` without a cast.
import { TaskExecutionError, type BackendCapabilities, type CancelAck, type DeliveryRef, type ObservationCursor, type ObservationSnapshot, type PreflightReport, type PreflightRequest, type ReconciliationReport, type SubmissionAck, type SubmissionUri, type TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import {
  documentDigest,
  mergeRequirements,
  sealSubmission,
  sealTask,
  validateSubmission,
  validateTask,
  type ProtocolObservation,
  type SubmissionRecord,
  type TaskSpecification,
  type ValidationResult,
} from "@jinn-network/task-execution-protocol";
import type { MarketplaceChainConfig } from "./addresses.js";
import { BroadcastUncertainError } from "./broadcast-intent.js";
import { assertIJsonUnicode } from "./canonical-json.js";
import { MARKETPLACE_CORE_KEY_CLASSES, marketplaceCapabilities } from "./capabilities.js";
import { honorOrRejectToday } from "./honor-or-reject.js";
import {
  closeSubmission as closeMarketplaceSubmission,
  signalCancel,
} from "./lifecycle.js";
import { postTask } from "./posting.js";
import type { MarketplaceBackendPorts } from "./backend-ports.js";

type AttemptUri = `urn:uuid:${string}`;

/** The `TestableBackend` seam, implemented structurally -- see the module doc for why this is not imported. */
export interface MarketplaceTestableBackend extends TaskExecutionBackend {
  drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void>;
  recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void>;
  simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void;
  /** Marketplace requester close, distinct from standard Attempt cancellation (program §7.54). */
  closeSubmission?(taskId: bigint): Promise<void>;
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function requestedPinningId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

type CanonicalAdmission<T> =
  | { readonly ok: true; readonly document: T }
  | { readonly ok: false; readonly error: TaskExecutionError };

/**
 * Fatal decode → schema validation → I-JSON scalar check → protocol re-seal → byte equality.
 * This runs before idempotency scope lookup, WAL ownership, upload, or wallet effects.
 */
function admitCanonicalDocument<T>(
  bytes: Uint8Array,
  label: "Task" | "Submission",
  validate: (document: unknown) => ValidationResult,
  seal: (document: unknown) => Uint8Array,
): CanonicalAdmission<T> {
  let document: unknown;
  try {
    document = decodeJson(bytes);
  } catch (cause) {
    return {
      ok: false,
      error: new TaskExecutionError("invalid-document", {
        detail: `${label} bytes are not valid fatal UTF-8 JSON: ${String(cause)}`,
      }),
    };
  }

  const validation = validate(document);
  if (!validation.conforms) {
    return {
      ok: false,
      error: new TaskExecutionError("invalid-document", {
        detail: validation.errors
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      }),
    };
  }

  let canonical: Uint8Array;
  try {
    assertIJsonUnicode(document);
    canonical = seal(document);
  } catch (cause) {
    return {
      ok: false,
      error: new TaskExecutionError("invalid-document", {
        detail: `${label} violates canonical I-JSON sealing: ${String(cause)}`,
      }),
    };
  }
  if (!bytesEqual(bytes, canonical)) {
    return {
      ok: false,
      error: new TaskExecutionError("invalid-document", {
        detail:
          `${label} bytes are not the exact protocol canonical seal `
          + "(pretty/reordered/duplicate-key encodings are not accepted)",
      }),
    };
  }
  return { ok: true, document: document as T };
}

/**
 * The requester-facing marketplace `TaskExecutionBackend` (design §7, §13). `config` selects the
 * chain-generation-specific addresses (M0.3); `ports` supplies the posting mechanics (M2.3) and
 * the observation surface (M2.4, standing in for the not-yet-built projector).
 */
export function makeMarketplaceBackend(
  config: MarketplaceChainConfig,
  ports: MarketplaceBackendPorts,
): MarketplaceTestableBackend {
  async function capabilities(): Promise<BackendCapabilities> {
    return marketplaceCapabilities({ cancel: ports.lifecycle !== undefined });
  }

  async function submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck> {
    const taskAdmission = admitCanonicalDocument<TaskSpecification>(
      taskBytes,
      "Task",
      validateTask,
      sealTask,
    );
    if (!taskAdmission.ok) {
      return { accepted: false, error: taskAdmission.error };
    }
    const submissionAdmission = admitCanonicalDocument<SubmissionRecord>(
      submissionBytes,
      "Submission",
      validateSubmission,
      sealSubmission,
    );
    if (!submissionAdmission.ok) {
      return { accepted: false, error: submissionAdmission.error };
    }

    const task = taskAdmission.document;
    const submission = submissionAdmission.document;

    // A sealed Submission commits to the exact Task bytes it was paired with. This is a bad
    // reference, rather than a malformed document: both documents have already passed schema
    // validation, but they do not belong together (§8).
    const taskDigest = documentDigest(taskBytes);
    const submissionDigest = documentDigest(submissionBytes);
    const boundTaskDigestHex = submission.task.digest?.sha256;
    if (boundTaskDigestHex !== taskDigest.replace(/^sha256:/, "")) {
      return {
        accepted: false,
        error: new TaskExecutionError("invalid-reference", {
          detail: `Submission's task digest (sha256:${boundTaskDigestHex ?? "none"}) does not match the provided Task bytes' digest (${taskDigest})`,
        }),
      };
    }

    // TEP §12.2 idempotent resubmission: same (requester, idempotencyKey) scope. Byte-identical
    // resubmission returns the existing ack; a same-key/different-bytes resubmission is a typed
    // `submission-conflict`. This is a DIFFERENT concern from postTask's broadcast-crash WAL
    // (broadcast-intent.ts) -- that guards the chain broadcast itself, this guards the
    // application-level submit contract.
    const existingScope = await ports.observe.lookupSubmissionByScope(submission.requester, submission.idempotencyKey);
    if (existingScope !== undefined) {
      if (bytesEqual(existingScope.submissionBytes, submissionBytes)) {
        return { accepted: true, submission: existingScope.submissionUri, digest: existingScope.digest };
      }
      return {
        accepted: false,
        error: new TaskExecutionError("submission-conflict", {
          detail: `idempotencyKey "${submission.idempotencyKey}" already used with different Submission bytes in this scope`,
        }),
      };
    }

    const backendCapabilities = await marketplaceCapabilities();
    for (const [key, value] of Object.entries(submission.requirements ?? {})) {
      const support = backendCapabilities.runPinning.keys.find((entry) => entry.key === key);
      if (support === undefined) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `run-pinning key "${key}" is not declared in this backend's capability inventory`,
            annotations: { key },
          }),
        };
      }
      const requestedId = requestedPinningId(value);
      if (support.inventory.length > 0 && !support.inventory.includes("*")
        && (requestedId === undefined || !support.inventory.includes(requestedId))) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `run-pinning key "${key}" requested a value outside this backend's declared inventory`,
            annotations: { key },
          }),
        };
      }
    }

    // The requester binding transports capability-grant references byte-exactly and never
    // redeems them. Today mode supports exactly the first-verdict (`minVerdicts === 1`) rail;
    // `honorOrRejectToday` below rejects unknown or stronger requirements (program §7.54).
    for (const [key, grant] of Object.entries(submission.capabilityGrants ?? {})) {
      const uri =
        grant !== null && typeof grant === "object"
          ? (grant as { readonly uri?: unknown }).uri
          : undefined;
      if (typeof uri !== "string" || uri.length === 0) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `capability grant "${key}" is not a transportable capability reference`,
            annotations: { key: `capabilityGrants.${key}` },
          }),
        };
      }
    }

    for (const key of ["maxTotal", "maxConcurrent"] as const) {
      const requested = submission.attempts?.[key];
      const declared = backendCapabilities.attempts[key];
      if (requested !== undefined && (declared === undefined || requested < declared[0] || requested > declared[1])) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `attempts.${key} value ${requested} is outside this backend's declared bounds ${declared === undefined ? "(not declared)" : `[${declared[0]}, ${declared[1]}]`}`,
            annotations: { key: `attempts.${key}` },
          }),
        };
      }
    }

    const merged = mergeRequirements(task.requirements, submission.requirements, MARKETPLACE_CORE_KEY_CLASSES);
    if (!merged.ok) {
      return {
        accepted: false,
        error: new TaskExecutionError("invalid-document", {
          detail: `requirement "${merged.key}" does not satisfy its comparison class between Task and Submission`,
          annotations: { key: merged.key },
        }),
      };
    }

    const honorResult = honorOrRejectToday(submission, merged.effective, backendCapabilities);
    if (!honorResult.ok) {
      return {
        accepted: false,
        error: new TaskExecutionError(honorResult.category, {
          detail: `today-mode cannot honor requirement "${honorResult.key}" (TEP §8 forbids silent degradation; ruling §7.20)`,
          annotations: { key: honorResult.key },
        }),
      };
    }

    let outcome;
    try {
      outcome = await postTask(taskBytes, submissionBytes, ports.terms, config, ports.creatorSafe, ports.posting);
    } catch (err) {
      if (err instanceof TaskExecutionError) return { accepted: false, error: err };
      if (err instanceof BroadcastUncertainError) {
        return {
          accepted: false,
          error: new TaskExecutionError("backend-unavailable", { detail: err.message, retryable: true }),
        };
      }
      throw err;
    }

    await ports.observe.recordSubmission({
      taskDigest,
      submissionDigest,
      submissionBytes,
      submission,
      outcome,
    });

    return { accepted: true, submission: submission.submission as SubmissionUri, digest: submissionDigest };
  }

  async function observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot> {
    return ports.observe.observe(ref);
  }

  async function recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport> {
    return ports.observe.recover(ref);
  }

  async function deliveries(attempt: AttemptUri): Promise<DeliveryRef[]> {
    return ports.observe.deliveries(attempt);
  }

  async function fetchDelivery(ref: DeliveryRef): Promise<Uint8Array> {
    return ports.observe.fetchDelivery(ref);
  }

  async function drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void> {
    return ports.observe.drive(attempt, observations);
  }

  async function recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void> {
    return ports.observe.recordDelivery(attempt, deliveryBytes);
  }

  function simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void {
    ports.observe.simulateReconciliation(ref, outcome);
  }

  async function cancel(
    attempt: AttemptUri,
    reason: string,
  ): Promise<CancelAck> {
    const lifecycle = ports.lifecycle;
    if (lifecycle === undefined) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: "marketplace lifecycle ports are not configured",
      });
    }
    const snapshot = await ports.observe.observe(attempt);
    if (snapshot.descriptor.derived.terminal) {
      return {
        requested: false,
        terminalState: snapshot.descriptor.derived.state,
      };
    }
    const target = await lifecycle.resolveAttempt(attempt);
    await signalCancel(attempt, target.taskId, target.attemptIndex, reason, {
      requestCancel: lifecycle.requestCancel,
    });
    return { requested: true };
  }

  async function closeSubmission(taskId: bigint): Promise<void> {
    const lifecycle = ports.lifecycle;
    if (lifecycle === undefined) {
      throw new TaskExecutionError("backend-unavailable", {
        detail: "marketplace lifecycle ports are not configured",
      });
    }
    await closeMarketplaceSubmission(taskId, config, lifecycle);
  }

  return {
    capabilities,
    submit,
    observe,
    recover,
    deliveries,
    fetchDelivery,
    drive,
    recordDelivery,
    simulateReconciliation,
    ...(ports.lifecycle === undefined
      ? {}
      : {
          cancel,
          closeSubmission,
        }),
  };
}

export type { PreflightReport, PreflightRequest, CancelAck };
