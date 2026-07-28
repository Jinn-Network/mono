// SPDX-License-Identifier: MIT

// A reference in-memory implementation of `MarketplaceObservePort` (backend.ts). This is the
// STUB backing store `makeMarketplaceBackend`'s own unit tests use, and the same stub the
// `marketplace-testing` package's un-parameterized core-kit sanity run (M2.5) wires as its
// "stubbed-chain" configuration -- it lives here (not in `@jinn-network/task-execution-testing`,
// which `binding` may never import, per the source-boundaries guard) precisely so it can be
// exported and reused without crossing that boundary.
//
// Self-claim conformance shape (design §5.3 sanctions self-claim on solve work): on
// `recordSubmission`, this stub immediately synthesizes an `attempt-engaged` observation at
// `attemptIndex 0`, using the SAME deterministic Attempt-URI derivation the real claim leg
// (Milestone M3) will use. This is a property of the STUB ONLY -- it exists so the
// single-party-shaped `describeTaskExecutionBackendContract` kit (which expects an Attempt to
// already be engaged immediately after `submit`) has a subject to observe. A real marketplace
// Submission does NOT engage an attempt until a real, asynchronous operator claim (M3); the real
// production `MarketplaceObservePort` (the projector, M4) never auto-engages.
import type {
  AttemptDescriptor,
  ProtocolObservation,
  ResourceDescriptor,
  SubmissionRecord,
} from "@jinn-network/task-execution-protocol";
import {
  documentDigest,
  foldObservations,
  serializeCanonicalJson,
  sha256Hex,
} from "@jinn-network/task-execution-protocol";
import { TaskExecutionError, type DeliveryRef, type ObservationCursor, type ObservationSnapshot, type ReconciliationReport, type SubmissionUri } from "@jinn-network/task-execution-backend";
import type { MarketplaceChainConfig } from "./addresses.js";
import { deriveMarketplaceAttemptUri } from "./attempt-uri.js";
import type { MarketplaceObservePort, RecordSubmissionInput, SubmissionScopeRecord } from "./backend-ports.js";

type AttemptUri = `urn:uuid:${string}`;

interface AttemptMeta {
  task: `sha256:${string}`;
  submission: SubmissionUri;
  annotations?: Readonly<Record<string, unknown>>;
  effectiveDeadline: string;
}

const SOURCE = "urn:jinn:marketplace:binding:stub-observe-store";
const EXECUTOR = "urn:jinn:agent:marketplace-stub-self-claim";

export interface InMemoryMarketplaceObserveStore extends MarketplaceObservePort {
  /** Test-only introspection: every submission scope recorded, keyed `requester\u001fidempotencyKey`. */
  readonly scopes: ReadonlyMap<string, SubmissionScopeRecord>;
}

/** Builds the reference in-memory `MarketplaceObservePort` (see module doc for the self-claim caveat). */
export function createInMemoryMarketplaceObserveStore(config: MarketplaceChainConfig): InMemoryMarketplaceObserveStore {
  const scopeDelimiter = "\u001f";
  const scopes = new Map<string, SubmissionScopeRecord>();
  const attemptMeta = new Map<AttemptUri, AttemptMeta>();
  const submissionToAttempt = new Map<SubmissionUri, AttemptUri>();
  const logs = new Map<AttemptUri, ProtocolObservation[]>();
  const deliveryBytes = new Map<AttemptUri, Map<`sha256:${string}`, Uint8Array>>();
  const sequenceCounters = new Map<AttemptUri, bigint>();
  const reconciliationOverrides = new Map<string, ReconciliationReport>();
  let nextAttemptIndex = 0;

  function pushObservation(attempt: AttemptUri, type: ProtocolObservation["type"], data: Record<string, unknown>): void {
    const meta = attemptMeta.get(attempt);
    const next = sequenceCounters.get(attempt) ?? 1n;
    sequenceCounters.set(attempt, next + 1n);
    const observation = {
      specversion: "1.0",
      id: `${attempt}:${next}`,
      source: SOURCE,
      subject: attempt,
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      sequence: next.toString().padStart(16, "0"),
      ...(meta !== undefined ? { taskdigest: meta.task } : {}),
      type,
      data,
    } as ProtocolObservation;
    const log = logs.get(attempt) ?? [];
    log.push(observation);
    logs.set(attempt, log);
  }

  function resolveAttempt(ref: SubmissionUri | AttemptUri): AttemptUri {
    if (attemptMeta.has(ref as AttemptUri)) return ref as AttemptUri;
    const viaSubmission = submissionToAttempt.get(ref as SubmissionUri);
    if (viaSubmission !== undefined) return viaSubmission;
    throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt or Submission for ref "${ref}"` });
  }

  return {
    scopes,

    async lookupSubmissionByScope(requester, idempotencyKey) {
      return scopes.get(`${requester}${scopeDelimiter}${idempotencyKey}`);
    },

    async recordSubmission(input: RecordSubmissionInput): Promise<void> {
      const submission = input.submission as SubmissionRecord;
      const submissionUri = submission.submission as SubmissionUri;
      scopes.set(`${submission.requester}${scopeDelimiter}${submission.idempotencyKey}`, {
        submissionUri,
        digest: input.submissionDigest,
        submissionBytes: input.submissionBytes,
      });

      // Self-claim (design §5.3), stub-only -- see module doc.
      const attemptIndex = nextAttemptIndex;
      nextAttemptIndex += 1;
      const attempt = deriveMarketplaceAttemptUri({
        chainId: config.chainId,
        coordinator: config.taskCoordinator,
        taskId: input.outcome.taskId,
        attemptIndex,
      });

      const dispatchContext = {
        taskDigest: input.taskDigest,
        submission: submissionUri,
        nonce: submission.nonce,
        attempt,
      };
      const dispatchContextBytes = serializeCanonicalJson(dispatchContext);
      const dispatchContextDescriptor: ResourceDescriptor = {
        uri: `urn:jinn:marketplace:dispatch-context:${attempt}`,
        digest: { sha256: sha256Hex(dispatchContextBytes) },
      };

      attemptMeta.set(attempt, {
        task: input.taskDigest,
        submission: submissionUri,
        annotations: submission.annotations as Record<string, unknown> | undefined,
        effectiveDeadline: submission.deadline,
      });
      submissionToAttempt.set(submissionUri, attempt);
      logs.set(attempt, []);
      deliveryBytes.set(attempt, new Map());
      sequenceCounters.set(attempt, 1n);

      pushObservation(attempt, "network.jinn.task-execution.attempt-engaged.v1", {
        attempt,
        task: input.taskDigest,
        submission: submissionUri,
        executor: EXECUTOR,
        effectiveDeadline: submission.deadline,
        source: SOURCE,
        dispatchContext: dispatchContextDescriptor,
        ...(submission.annotations !== undefined ? { annotations: submission.annotations } : {}),
      });
    },

    async observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot> {
      const attempt = resolveAttempt(ref);
      const meta = attemptMeta.get(attempt);
      if (meta === undefined) throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt for ref "${ref}"` });
      const observations = logs.get(attempt) ?? [];
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
      const cursor: ObservationCursor = { sequence: observations.at(-1)?.sequence ?? "0000000000000000" };
      return { descriptor, cursor, observations };
    },

    async recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport> {
      const override = reconciliationOverrides.get(ref);
      if (override !== undefined) return override;
      try {
        resolveAttempt(ref);
        return { classification: "matching" };
      } catch {
        return { classification: "absent", detail: `no durable record for ref "${ref}"` };
      }
    },

    async drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void> {
      if (!attemptMeta.has(attempt)) throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
      const log = logs.get(attempt) ?? [];
      log.push(...observations);
      logs.set(attempt, log);
    },

    async recordDelivery(attempt: AttemptUri, deliveryBytesValue: Uint8Array): Promise<void> {
      const meta = attemptMeta.get(attempt);
      if (meta === undefined) throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
      const digest = documentDigest(deliveryBytesValue);
      const byDigest = deliveryBytes.get(attempt) ?? new Map<`sha256:${string}`, Uint8Array>();
      byDigest.set(digest, deliveryBytesValue);
      deliveryBytes.set(attempt, byDigest);
      pushObservation(attempt, "network.jinn.task-execution.delivery-recorded.v1", { digest });
    },

    simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void {
      reconciliationOverrides.set(ref, outcome);
    },

    async deliveries(attempt: AttemptUri): Promise<DeliveryRef[]> {
      const byDigest = deliveryBytes.get(attempt);
      if (byDigest === undefined) throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
      return [...byDigest.keys()].map((digest) => ({ attempt, digest }));
    },

    async fetchDelivery(ref: DeliveryRef): Promise<Uint8Array> {
      const bytes = deliveryBytes.get(ref.attempt)?.get(ref.digest);
      if (bytes === undefined) {
        throw new TaskExecutionError("result-unavailable", {
          detail: `no Delivery "${ref.digest}" recorded for Attempt "${ref.attempt}"`,
        });
      }
      return bytes;
    },
  };
}
