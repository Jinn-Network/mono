/**
 * The requester-side delivery-adoption leg (one-swap M5f, umbrella #2461, DR-2026-08-05 decision 1;
 * cutover stage-3 posting-flow plan Tasks 10-11 `delivery.ts`/`adoption.ts`, landed here as one
 * module on the work-client seam). It closes the last leg of the fleet G-loop: a task this operator
 * POSTED (M5e write path) and a SECOND operator claimed, solved and DELIVERED can now be ADOPTED by
 * the requester — observe the delivery, VERIFY it against the posted Submission, and RECORD a
 * durable adoption decision.
 *
 * Adoption is a READ + RECORD operation — it never broadcasts. The today generation
 * (`BASE_SEPOLIA_TODAY`) has no on-chain "accept delivery" call: the marketplace escrow is
 * first-delivery-wins and gated by the coordinator, not by a requester acknowledgment. So this
 * module opens no wallet and drives no broadcaster; it reads the venue observation surface and hands
 * an {@link AdoptionDecision} to an injected {@link AdoptionReceiptSink}. The sink is a port because
 * the only receipt machinery in the tree is product-specific (Autopilot's GitHub adoption receipt);
 * a product-shaped receipt must never enter this module.
 *
 * Fail-closed integrity crux (the reason this leg is not "read the bytes and trust them"). A
 * malicious or buggy solver — or a venue/projector that ingested a corrupted delivery — must never
 * get its garbage adopted. Every delivery is refused unless ALL of the following hold, each a typed
 * {@link RequesterError} throw (never a silent skip, never an adoption):
 *
 *   1. byte/digest — the fetched delivery bytes hash to the DeliveryRef's claimed `sha256:` digest
 *      (`delivery/digest-mismatch`). This is the tamper gate: alter one byte in transit and the
 *      recomputed digest diverges.
 *   2. canonical form — the bytes parse as a `DeliveryRecord` AND re-seal byte-for-byte
 *      (`delivery/invalid-delivery`), so a well-formed-looking but non-canonical payload is refused.
 *   3. correspondence to the posted Submission — the venue's Attempt observation names THIS
 *      requester's `submissionUri` and `taskDigest`, the delivery's own `task`/`attempt` references
 *      bind to the same Attempt, and the canonical observation log actually recorded this delivery
 *      digest (`adoption/*-divergence`, `adoption/delivery-not-recorded`). A delivery for a
 *      different task, or one the log never corroborated, is never adopted.
 *
 * This file is part of the extractable `native-requester/work-client/` seam; it imports nothing
 * outside the module except the allowed binding/protocol/backend packages (see
 * test/architecture/native-requester-work-client-boundary.test.ts). Enumerating THIS operator's own
 * posted tasks and deriving the receipt-sink durability is the host's job
 * (`daemon/native-fleet-requester-write.ts`), which passes the facts and ports in.
 */
import {
  DeliveryRecordSchema,
  documentDigest,
  sealDelivery,
  type DeliveryRecord,
} from '@jinn-network/task-execution-protocol';
import {
  TaskExecutionError,
  type AttemptUri,
  type DeliveryRef,
  type ObservationSnapshot,
  type SubmissionUri,
} from '@jinn-network/task-execution-backend';
import { RequesterError } from './errors.js';

export type DeliveryDigest = `sha256:${string}`;

/**
 * The narrow observe surface adoption drives — a structural subset of the venue's
 * `MarketplaceObservePort` (`composition.venue.observe`). The host injects the SAME instance the
 * M5e write path uses; adoption opens no second observe consumer.
 */
export interface DeliveryObservePort {
  observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot>;
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;
}

/** A delivery observed on an Attempt, byte-verified against its claimed digest and canonically parsed. */
export interface ObservedDelivery {
  readonly attempt: AttemptUri;
  readonly deliveryBytes: Uint8Array;
  readonly delivery: DeliveryRecord;
  readonly digest: DeliveryDigest;
}

/**
 * The posted task's canonical facts the requester holds in its durable `NativeRequesterAssociation`.
 * Adoption verifies the delivery corresponds to exactly this Submission.
 */
export interface AdoptedTaskFacts {
  readonly taskId: bigint;
  readonly taskDigest: DeliveryDigest;
  readonly submissionUri: SubmissionUri;
}

/**
 * The durable adoption receipt. `deliveryDigest` is the evidence handle — a verifiable,
 * content-addressed pointer to the exact delivered bytes the requester adopted.
 */
export interface AdoptionDecision {
  readonly attempt: AttemptUri;
  /** Decimal task id (JSON-safe; the association's `taskId` is a bigint). */
  readonly taskId: string;
  /** Only `accepted` is ever recorded — a non-corresponding or tampered delivery throws (loud skip). */
  readonly disposition: 'accepted';
  readonly deliveryDigest: DeliveryDigest;
  /** ISO-8601 decision time. */
  readonly decidedAt: string;
}

/** The durable receipt sink. A product-specific sink (Autopilot GitHub) stays host-side. */
export interface AdoptionReceiptSink {
  publish(decision: AdoptionDecision): Promise<void>;
}

/** Parses delivery bytes as a canonical `DeliveryRecord`; returns undefined unless it re-seals exactly. */
function parseCanonicalDelivery(bytes: Uint8Array): DeliveryRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = DeliveryRecordSchema.safeParse(value);
  if (!parsed.success) return undefined;
  let sealed: Uint8Array;
  try {
    sealed = sealDelivery(parsed.data);
  } catch {
    return undefined;
  }
  return bytesEqual(sealed, bytes) ? parsed.data : undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

/**
 * Fetches and byte-verifies one delivery ref. Fail-closed on tamper (bytes do not hash to the
 * claimed digest) and on a non-canonical `DeliveryRecord`. This is the integrity gate a fabricated
 * delivery cannot pass.
 */
export async function verifyDeliveryRef(
  ref: DeliveryRef,
  attempt: AttemptUri,
  port: Pick<DeliveryObservePort, 'fetchDelivery'>,
): Promise<ObservedDelivery> {
  if (ref.attempt !== attempt) {
    throw new RequesterError(
      'delivery',
      'attempt-mismatch',
      `delivery ref names attempt ${ref.attempt} but was enumerated for ${attempt}`,
    );
  }
  const deliveryBytes = await port.fetchDelivery(ref);
  const digest = documentDigest(deliveryBytes);
  if (digest !== ref.digest) {
    throw new RequesterError(
      'delivery',
      'digest-mismatch',
      `delivery bytes hash to ${digest} but the ref claims ${ref.digest} — refusing tampered delivery`,
    );
  }
  const delivery = parseCanonicalDelivery(deliveryBytes);
  if (delivery === undefined) {
    throw new RequesterError(
      'delivery',
      'invalid-delivery',
      `delivery ${ref.digest} bytes are not a canonical DeliveryRecord`,
    );
  }
  return { attempt, deliveryBytes, delivery, digest };
}

/**
 * Reads every delivery recorded on one Attempt and byte-verifies each. Returns [] when none exist
 * yet (the second operator has not delivered). A single tampered or non-canonical delivery throws
 * (fail-closed) rather than being silently dropped.
 */
export async function observeDeliveries(
  attempt: AttemptUri,
  port: Pick<DeliveryObservePort, 'deliveries' | 'fetchDelivery'>,
): Promise<readonly ObservedDelivery[]> {
  const refs = await port.deliveries(attempt);
  const observed: ObservedDelivery[] = [];
  for (const ref of refs) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential; a small, bounded set.
    observed.push(await verifyDeliveryRef(ref, attempt, port));
  }
  return observed;
}

/**
 * Adopts the delivery for one posted task, if one exists. READ + RECORD: observes the Attempt for
 * this operator's own posted Submission, verifies correspondence and byte-integrity fail-closed,
 * and records a durable {@link AdoptionDecision} through the injected sink. Returns the decision, or
 * `null` when the task has not been claimed/delivered yet (a quiet, expected steady state — NOT an
 * error, so a reconcile tick does not log-spam a still-open task).
 *
 * The observe port resolves the posted `submissionUri` to its Attempt itself (the production
 * projector port and the reference store both map Submission → engaged Attempt), so this leg needs
 * no Attempt-index guess: whatever index the winning claim took, `observe(submissionUri)` finds it.
 */
export async function adoptPostedTask(
  input: { readonly facts: AdoptedTaskFacts; readonly now?: () => Date },
  port: DeliveryObservePort & { readonly receipts: AdoptionReceiptSink },
): Promise<AdoptionDecision | null> {
  const { facts } = input;

  let snapshot: ObservationSnapshot;
  try {
    snapshot = await port.observe(facts.submissionUri);
  } catch (err) {
    // The Submission has no engaged Attempt yet — nobody has claimed. Expected, not a failure.
    if (err instanceof TaskExecutionError && err.category === 'attempt-not-found') return null;
    throw err;
  }
  const descriptor = snapshot.descriptor;

  // Correspondence to the posted Submission: the Attempt the venue engaged must be THIS requester's
  // exact Submission + Task. A delivery on an Attempt that names a different Submission/Task is not
  // ours to adopt.
  if (descriptor.submission !== facts.submissionUri) {
    throw new RequesterError(
      'adoption',
      'submission-uri-divergence',
      `observed Attempt names submission ${descriptor.submission}, expected ${facts.submissionUri}`,
    );
  }
  if (descriptor.task !== facts.taskDigest) {
    throw new RequesterError(
      'adoption',
      'task-digest-divergence',
      `observed Attempt names task ${descriptor.task}, expected ${facts.taskDigest}`,
    );
  }
  if (descriptor.derived.contradictory) {
    throw new RequesterError(
      'adoption',
      'attempt-contradictory',
      `Attempt ${descriptor.attempt} is in a contradictory terminal state; refusing to adopt`,
    );
  }

  const attempt = descriptor.attempt;
  const observed = await observeDeliveries(attempt, port);
  if (observed.length === 0) return null;

  // Adopt the first recorded delivery. Its own references must bind to this Attempt + Task, and the
  // canonical observation log must corroborate the delivery digest — a delivery present in the bytes
  // store but absent from the log is refused until the projector agrees (adopt next tick).
  const first = observed[0]!;
  if (first.delivery.task !== facts.taskDigest) {
    throw new RequesterError(
      'adoption',
      'delivery-task-divergence',
      `delivery ${first.digest} names task ${first.delivery.task}, expected ${facts.taskDigest}`,
    );
  }
  if (first.delivery.attempt !== attempt) {
    throw new RequesterError(
      'adoption',
      'delivery-attempt-divergence',
      `delivery ${first.digest} names attempt ${first.delivery.attempt}, expected ${attempt}`,
    );
  }
  if (!descriptor.derived.deliveries.some((entry) => entry.digest === first.digest)) {
    throw new RequesterError(
      'adoption',
      'delivery-not-recorded',
      `delivery ${first.digest} is not in the canonical observation log for Attempt ${attempt}`,
    );
  }

  const decidedAt = (input.now?.() ?? new Date()).toISOString();
  const decision: AdoptionDecision = {
    attempt,
    taskId: facts.taskId.toString(10),
    disposition: 'accepted',
    deliveryDigest: first.digest,
    decidedAt,
  };
  await port.receipts.publish(decision);
  return decision;
}
