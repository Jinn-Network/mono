import type {
  BackendCapabilities,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  ReconciliationReport,
  RunPinningKeySupport,
  SubmissionAck,
  SubmissionUri,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type {
  AttemptDescriptor,
  ProtocolObservation,
  ResourceDescriptor,
  SubmissionRecord,
} from "@jinn-network/task-execution-protocol";
import {
  documentDigest,
  foldObservations,
  sha256Hex,
  serializeCanonicalJson,
  validateDelivery,
  validateSubmission,
  validateTask,
} from "@jinn-network/task-execution-protocol";

type AttemptUri = `urn:uuid:${string}`;

/**
 * The test-only seam a `TaskExecutionBackend` implementation exposes so the Layer-2 conformance
 * suite (`describeTaskExecutionBackendContract`, Task 3.4) can drive lifecycle facts and force
 * `recover` outcomes without a bespoke, non-conforming verb on the frozen contract itself.
 */
export interface TestableBackend extends TaskExecutionBackend {
  /** Appends already-well-formed observations to an Attempt's durable log. */
  drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void>;
  /**
   * Registers a sealed Delivery's exact bytes against an Attempt (so `deliveries`/`fetchDelivery`
   * have something real to return) and emits the corresponding `delivery-recorded` observation.
   */
  recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void>;
  /** Forces the next `recover(ref)` classification for the given ref (default otherwise: `matching`). */
  simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void;
}

interface StoredSubmission {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
  parsed: SubmissionRecord;
  taskDigest: `sha256:${string}`;
  attempt: AttemptUri;
}

interface AttemptMeta {
  task: `sha256:${string}`;
  submission: SubmissionUri;
  annotations?: Readonly<Record<string, unknown>>;
  effectiveDeadline: string;
}

const DEFAULT_RUN_PINNING: RunPinningKeySupport[] = [
  { key: "harness", inventory: ["fake-harness-v1"], posture: "enforced" },
];

export interface InMemoryBackendOptions {
  /** The authoritative observation-producer source URI for this backend instance (§10.1). */
  source?: string;
  /** The executor IRI attributed to engaged Attempts. */
  executor?: string;
  /** Declared run-pinning support (carried amendment 1, profiles §5.2). */
  runPinning?: RunPinningKeySupport[];
}

function scopeKey(requester: string, idempotencyKey: string): string {
  return `${requester}${idempotencyKey}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * A durable-in-memory reference `TaskExecutionBackend` (§14). This is the conformance kit's
 * reference implementation — proven against `describeTaskExecutionBackendContract` (Task 3.4)
 * *before* any real binding exists (design §26). Single-party minting (§9.2): Attempts get
 * random UUIDs, engaged synchronously at `submit`.
 */
export class InMemoryTaskExecutionBackend implements TestableBackend {
  private readonly source: string;
  private readonly executor: string;
  private readonly runPinning: RunPinningKeySupport[];

  private readonly submissionsByScope = new Map<string, StoredSubmission>();
  private readonly submissionsByUri = new Map<SubmissionUri, StoredSubmission>();
  private readonly attemptMeta = new Map<AttemptUri, AttemptMeta>();
  private readonly logs = new Map<AttemptUri, ProtocolObservation[]>();
  private readonly deliveryBytes = new Map<AttemptUri, Map<`sha256:${string}`, Uint8Array>>();
  private readonly reconciliationOverrides = new Map<string, ReconciliationReport>();
  private readonly sequenceCounters = new Map<AttemptUri, bigint>();

  constructor(options: InMemoryBackendOptions = {}) {
    this.source = options.source ?? "urn:jinn:backend:fake-in-memory";
    this.executor = options.executor ?? "urn:jinn:agent:fake-in-memory-operator";
    this.runPinning = options.runPinning ?? DEFAULT_RUN_PINNING;
  }

  async capabilities(): Promise<BackendCapabilities> {
    return {
      taskProfiles: [],
      inputMediaTypes: [],
      outputMediaTypes: [],
      cancel: true,
      watch: false,
      preflight: false,
      fetchArtifact: false,
      confidentialInputs: false,
      signedObservations: false,
      signedDeliveries: false,
      evidenceCapture: "none",
      deadlineEnforcement: false,
      isolation: ["none"],
      attempts: {},
      runPinning: { keys: this.runPinning },
    };
  }

  async submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck> {
    const taskDoc = decode(taskBytes);
    const taskValidation = validateTask(taskDoc);
    if (!taskValidation.conforms) {
      return {
        accepted: false,
        error: new TaskExecutionError("invalid-document", {
          detail: taskValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        }),
      };
    }

    const submissionDoc = decode(submissionBytes);
    const submissionValidation = validateSubmission(submissionDoc);
    if (!submissionValidation.conforms) {
      return {
        accepted: false,
        error: new TaskExecutionError("invalid-document", {
          detail: submissionValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        }),
      };
    }

    const submission = submissionDoc as SubmissionRecord;
    // Consumer-side rule: the exact received bytes are the digest, never a re-canonicalization.
    const taskDigest = documentDigest(taskBytes);
    const submissionDigest = documentDigest(submissionBytes);

    const scope = scopeKey(submission.requester, submission.idempotencyKey);
    const existing = this.submissionsByScope.get(scope);
    if (existing !== undefined) {
      if (bytesEqual(existing.bytes, submissionBytes)) {
        return { accepted: true, submission: existing.parsed.submission as SubmissionUri, digest: existing.digest };
      }
      return {
        accepted: false,
        error: new TaskExecutionError("submission-conflict", {
          detail: `idempotencyKey "${submission.idempotencyKey}" already used with different Submission bytes in this scope`,
        }),
      };
    }

    const requirements = (submission.requirements ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(requirements)) {
      const support = this.runPinning.find((entry) => entry.key === key);
      if (support === undefined) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `run-pinning key "${key}" is not declared in this backend's capability inventory`,
            annotations: { key },
          }),
        };
      }
      const requestedId = requestedPinningId(requirements[key]);
      if (
        support.inventory.length > 0
        && !support.inventory.includes("*")
        && (requestedId === undefined || !support.inventory.includes(requestedId))
      ) {
        return {
          accepted: false,
          error: new TaskExecutionError("unsupported-requirement", {
            detail: `run-pinning key "${key}" requested a value outside this backend's declared inventory`,
            annotations: { key },
          }),
        };
      }
    }

    const submissionUri = submission.submission as SubmissionUri;
    const attempt: AttemptUri = `urn:uuid:${crypto.randomUUID()}`;
    const effectiveDeadline = submission.deadline;

    const dispatchContext = {
      taskDigest,
      submission: submissionUri,
      nonce: submission.nonce,
      attempt,
    };
    const dispatchContextBytes = serializeCanonicalJson(dispatchContext);
    const dispatchContextDescriptor: ResourceDescriptor = {
      uri: `urn:jinn:fake-backend:dispatch-context:${attempt}`,
      digest: { sha256: sha256Hex(dispatchContextBytes) },
    };

    this.attemptMeta.set(attempt, {
      task: taskDigest,
      submission: submissionUri,
      annotations: submission.annotations as Record<string, unknown> | undefined,
      effectiveDeadline,
    });
    this.logs.set(attempt, []);
    this.deliveryBytes.set(attempt, new Map());
    this.sequenceCounters.set(attempt, 1n);

    this.pushObservation(attempt, "network.jinn.task-execution.attempt-engaged.v1", {
      attempt,
      task: taskDigest,
      submission: submissionUri,
      executor: this.executor,
      effectiveDeadline,
      source: this.source,
      dispatchContext: dispatchContextDescriptor,
      ...(submission.annotations !== undefined ? { annotations: submission.annotations } : {}),
    });

    const stored: StoredSubmission = {
      bytes: submissionBytes,
      digest: submissionDigest,
      parsed: submission,
      taskDigest,
      attempt,
    };
    this.submissionsByScope.set(scope, stored);
    this.submissionsByUri.set(submissionUri, stored);

    return { accepted: true, submission: submissionUri, digest: submissionDigest };
  }

  async observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot> {
    const attempt = this.resolveAttempt(ref);
    const meta = this.attemptMeta.get(attempt);
    if (meta === undefined) {
      throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt for ref "${ref}"` });
    }
    const observations = this.logs.get(attempt) ?? [];
    const derived = foldObservations(observations, {
      now: new Date().toISOString(),
      effectiveDeadline: meta.effectiveDeadline,
    });
    const descriptor: AttemptDescriptor = {
      attempt,
      task: meta.task,
      submission: meta.submission,
      ...(meta.annotations !== undefined ? { annotations: meta.annotations } : {}),
      derived,
    };
    const cursor: ObservationCursor = {
      sequence: observations.at(-1)?.sequence ?? "0000000000000000",
    };
    return { descriptor, cursor, observations };
  }

  async cancel(attempt: AttemptUri, reason: string): Promise<CancelAck> {
    const meta = this.attemptMeta.get(attempt);
    if (meta === undefined) {
      throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
    }
    const observations = this.logs.get(attempt) ?? [];
    const derived = foldObservations(observations, {
      now: new Date().toISOString(),
      effectiveDeadline: meta.effectiveDeadline,
    });
    if (derived.terminal) {
      // Idempotent per §12.1: cancelling an already-terminal Attempt is not an error.
      return { requested: false, terminalState: derived.state };
    }
    this.pushObservation(attempt, "network.jinn.task-execution.cancel-requested.v1", {
      reason,
      requestedBy: "conformance-kit",
    });
    return { requested: true };
  }

  async recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport> {
    const override = this.reconciliationOverrides.get(ref);
    if (override !== undefined) return override;
    // Everything this fake knows is the durable record itself (§12.2): nothing external to
    // compare against, so an in-scope ref is always "matching".
    try {
      this.resolveAttempt(ref);
      return { classification: "matching" };
    } catch {
      return { classification: "absent", detail: `no durable record for ref "${ref}"` };
    }
  }

  async deliveries(attempt: AttemptUri): Promise<DeliveryRef[]> {
    const byDigest = this.deliveryBytes.get(attempt);
    if (byDigest === undefined) {
      throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
    }
    return [...byDigest.keys()].map((digest) => ({ attempt, digest }));
  }

  async fetchDelivery(ref: DeliveryRef): Promise<Uint8Array> {
    const bytes = this.deliveryBytes.get(ref.attempt)?.get(ref.digest);
    if (bytes === undefined) {
      throw new TaskExecutionError("result-unavailable", {
        detail: `no Delivery "${ref.digest}" recorded for Attempt "${ref.attempt}"`,
      });
    }
    return bytes;
  }

  // --- TestableBackend seam (test-only; Task 3.2/3.4) ---

  async drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void> {
    if (!this.attemptMeta.has(attempt)) {
      throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
    }
    const log = this.logs.get(attempt) ?? [];
    log.push(...observations);
    this.logs.set(attempt, log);
  }

  async recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void> {
    const meta = this.attemptMeta.get(attempt);
    if (meta === undefined) {
      throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
    }
    const validation = validateDelivery(decode(deliveryBytes));
    if (!validation.conforms) {
      throw new TaskExecutionError("invalid-document", {
        detail: validation.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      });
    }
    const digest = documentDigest(deliveryBytes);
    const byDigest = this.deliveryBytes.get(attempt) ?? new Map<`sha256:${string}`, Uint8Array>();
    byDigest.set(digest, deliveryBytes);
    this.deliveryBytes.set(attempt, byDigest);
    this.pushObservation(attempt, "network.jinn.task-execution.delivery-recorded.v1", { digest });
  }

  simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void {
    this.reconciliationOverrides.set(ref, outcome);
  }

  // --- internals ---

  private resolveAttempt(ref: SubmissionUri | AttemptUri): AttemptUri {
    if (this.attemptMeta.has(ref as AttemptUri)) return ref as AttemptUri;
    const submission = this.submissionsByUri.get(ref as SubmissionUri);
    if (submission !== undefined) return submission.attempt;
    throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt or Submission for ref "${ref}"` });
  }

  private pushObservation(
    attempt: AttemptUri,
    type: ProtocolObservation["type"],
    data: Record<string, unknown>,
  ): void {
    const meta = this.attemptMeta.get(attempt);
    const next = this.sequenceCounters.get(attempt) ?? 1n;
    this.sequenceCounters.set(attempt, next + 1n);
    const observation = {
      specversion: "1.0",
      id: `${attempt}:${next}`,
      source: this.source,
      subject: attempt,
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      sequence: next.toString().padStart(16, "0"),
      ...(meta !== undefined ? { taskdigest: meta.task } : {}),
      type,
      data,
    } as ProtocolObservation;
    const log = this.logs.get(attempt) ?? [];
    log.push(observation);
    this.logs.set(attempt, log);
  }
}

function requestedPinningId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as { id?: unknown };
    if (typeof record.id === "string") return record.id;
  }
  return undefined;
}

export function createInMemoryBackend(options?: InMemoryBackendOptions): TestableBackend {
  return new InMemoryTaskExecutionBackend(options);
}
