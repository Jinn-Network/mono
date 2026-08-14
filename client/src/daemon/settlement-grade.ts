/**
 * `verifySettlementGrade` for real (cutover stage 1, close-out C6).
 *
 * Task 12's composition root wired `verifySettlementGrade` fail-closed -- every check always
 * reported `"missing"`, on the theory that this was a safe default pending Phase B. The
 * coordinator ruled that wrong (plan `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-
 * flow.md`, "Ruling summary" item 2, close-out addendum C6): `verificationFailure`
 * (`packages/marketplace/binding/src/settlement.ts:233`) rejects a settlement unless
 * `executorBinding` and `dispatchBinding` are `"verified"`, and rejects `evaluationSpecification`
 * on `"missing"`/`"failed"`. A verifier that always reports `"missing"` therefore settles nothing,
 * ever -- not a safe default, a broken one. This module replaces it with three checks that
 * genuinely inspect the settling delivery, each implemented against real data this operator
 * already holds.
 *
 * SCOPE NOTE: `composition-root.ts` now wires this module's real `buildVerifySettlementGrade` for
 * real (cutover stage 1 close-out C8) -- the stale fail-closed local stub this note used to
 * describe is gone.
 *
 * WHAT EACH CHECK PROVES, AND WHAT IT DOES NOT (read before wiring):
 *
 *  1. `executorBinding` -- exact-encoding DSSE verification (`@jinn-network/trust-core`'s
 *     strict `parseExactDsseEnvelope`/`dssePreAuthEncoding`, the same authority-bearing parser
 *     the remote evaluator applies -- defect #34 follow-up) plus a genuine asymmetric-signature check (Node's
 *     built-in `crypto.verify`, Ed25519). The signed payload is `verificationInput.deliveryBytes`
 *     itself -- the settling Delivery's own exact sealed bytes, unmodified (this field's own type
 *     comment already calls this out: "verifier implementations use these as the DSSE payload
 *     identity"). It binds everything the settling `deliveryBytes` actually carry: outputs,
 *     outcome, evidenceRecords, and the exact digest of the Task it responds to. Tampering with
 *     any of those fields after signing changes the digest and invalidates the lookup below.
 *     It proves the delivery was signed by the specific key this operator's composition declares
 *     as its own executor key -- a self-consistency / tamper-evidence bind, not third-party
 *     identity resolution. It deliberately does NOT call
 *     `@jinn-network/trust-core`'s `verifyEnvelopeBinding` (ceremony verification, consent
 *     chains, revocation, policy purposes) -- that machinery needs a real `BindingResolver` over
 *     a `BindingStore`/`AnchorReadClient`, which composition-root's own file header (gap 2) already
 *     documents as not existing anywhere in the repo (Phase B: "B.1 verifiability tier
 *     activation"). Proven not to gate today-mode settlement in this file's tests: the positive
 *     end-to-end test never supplies or touches a `BindingResolver`.
 *
 *     CLOSED (finding E31 close-out): a genuine DSSE envelope is now produced, by
 *     `@jinn-network/task-execution-backend-local`'s `completeAttempt` -- seal the Delivery's
 *     bytes exactly once (unchanged), then DSSE-sign those EXACT sealed bytes (TEP §9.1
 *     seal-once; `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5 "Sealed once,
 *     forever"). The coordinator's ruling on this finding is
 *     explicit that this is a CLEANER shape than an earlier proposal that would have embedded the
 *     signature as a reserved Delivery field (seal minus the field, sign, merge in, re-seal): an
 *     embedded field cannot cover its own bytes without that second seal pass, which IS
 *     re-canonicalization. The envelope therefore never touches the Delivery document -- it is
 *     carried OUTSIDE it, retrieved here via the injected `getDeliverySignature(digest)` port
 *     (backed by `LocalTaskExecutionBackend.getDeliverySignature`), keyed by the Delivery's own
 *     digest -- the only identity `SettlementGradeVerificationInput` carries across this package
 *     boundary (no AttemptUri field exists on it). It legitimately reports `"missing"` for the
 *     explicit legacy composition, which has no native solver-delivery identity, or when this
 *     specific digest was never signed.
 *
 *  2. `dispatchBinding` -- proves this operator's own local engagement ledger
 *     (`./engagement-ledger.ts`) recorded a claim for this exact settlement identity: chain,
 *     task coordinator, and (for revised-generation attempts) attempt index all match, the row's
 *     outcome is an engaged one (`claimed`/`delivered`/`settled`), and a claim transaction hash was
 *     recorded. The ledger is a local, single-operator SQLite table nothing else writes to, so a
 *     matching row is itself the proof "this operator's Safe is the party the venue engaged" --
 *     no additional on-chain read is needed.
 *
 *     CLOSED (cutover stage 1 close-out C1): `EngagementLedger`'s schema
 *     (`ENGAGEMENT_LEDGER_SCHEMA`, `./engagement-ledger.ts`) now carries a `request_id` column
 *     alongside `task_id`, populated at claim time by `work-loop.ts`'s wrapped `claimTask` from
 *     `claimAttempt`'s return value (present for today-generation claims; absent for
 *     revised-generation, which mints no requestId), and the real `EngagementLedger` class
 *     implements `getByRequestId` for real (a plain `request_id` lookup, indexed). Today-
 *     generation dispatchBinding therefore reports `"verified"` once a matching, engaged,
 *     claimed row exists -- no longer permanently `"missing"`. `checkDispatchBinding` below still
 *     accepts an `EngagementLedgerReader` with an OPTIONAL `getByRequestId` (structural, not a
 *     hard dependency on the concrete class) so a fake resolver remains a legal implementation for
 *     tests.
 *
 *     CLOSED (finding E35, ruled -- "seal at claim time; the engagement ledger is the home"): the
 *     matching-row checks above proved this operator claimed *a* attempt for this identity, but
 *     never actually compared `attempt.expectedDispatchContextDigest` (the digest
 *     `pipeline.ts`'s `settleDelivery` call expects the settling delivery to answer for) against
 *     anything -- a stale or wrong dispatch-context could still verify. `checkDispatchBinding` now
 *     resolves the sealed digest `work-loop.ts` recorded on this same row at claim time
 *     (`EngagementRow.dispatchContextDigest`, sealed once: I-JSON, JCS, sha256 -- TEP §9.1;
 *     `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5 "Sealed once, forever")
 *     and requires it to equal `attempt.expectedDispatchContextDigest` byte-for-byte. A row
 *     claimed before this seal existed (digest `null`) reports `"failed"`, not `"verified"` --
 *     absence of the seal is never treated as an implicit pass.
 *
 *  3. `evaluationSpecification` -- presence from the operator's own `ProfileStore`
 *     (`@jinn-network/task-execution-profiles`, already real and already wired into
 *     `composition-root.ts`'s `backendConfig.profileStore`): `attempt.taskEvaluationDigest`
 *     undefined means the solution delivery declares no governing EvaluationSpec, which is exactly
 *     the `"not-applicable"` case `verificationFailure` does not reject. When defined, this checks
 *     the digest resolves in the profile store -- it does not additionally cross-check that the
 *     delivered evidence records' own nested claims name the same digest (a deeper binding,
 *     genuinely out of this file's two-file scope).
 */
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { Hex } from 'viem';
import { dssePreAuthEncoding, parseExactDsseEnvelope } from '@jinn-network/trust-core';
import type {
  DispatchBindingCheck,
  EvaluationSpecificationCheck,
  ExecutorBindingCheck,
  MarketplaceChainConfig,
  SettlementAttempt,
  SettlementGradeVerification,
  SettlementGradeVerificationInput,
  SettlementPorts,
} from '@jinn-network/marketplace-binding';
import type { ProfileStore } from '@jinn-network/task-execution-profiles';
import type { EngagementOutcome, EngagementRow } from './engagement-ledger.js';

/** The DSSE envelope's required `payloadType`, matching the convention `named-checks.ts` already
 * uses for its own vendor media types (`SUBMISSION_DSSE_PAYLOAD_TYPE`, `VERDICT_DSSE_PAYLOAD_TYPE`).
 * Mirrors `@jinn-network/task-execution-backend-local`'s own copy of this literal
 * (`backend.ts`'s `EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE`) -- duplicated, not imported, because that
 * package cannot depend on the client; the two literals must stay byte-identical. */
export const EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE =
  'application/vnd.jinn.marketplace.executor-binding.v1+json' as const;

/**
 * Minimal reader surface `checkDispatchBinding` needs. `EngagementLedger` (`./engagement-ledger.
 * ts`) satisfies this structurally via its real `get()` and (cutover stage 1 close-out C1) its
 * real `getByRequestId()`. The method stays optional on this interface so a fake resolver
 * (without it) remains a legal `EngagementLedgerReader` for tests exercising the revised-
 * generation (`taskId`-keyed) path only.
 */
export interface EngagementLedgerReader {
  get(idempotencyKey: string): EngagementRow | undefined;
  getByRequestId?(requestId: Hex): EngagementRow | undefined;
}

export interface BuildVerifySettlementGradeInput {
  readonly profileStore: ProfileStore;
  readonly engagementLedger: EngagementLedgerReader;
  /**
   * The `keyid` this operator's executor-binding envelopes are expected to sign under (matched
   * against the DSSE envelope's `signatures[].keyid`).
   */
  readonly executorKeyId?: string;
  /** The public-key counterpart of the operator's own delivery-signing key (Ed25519). */
  readonly executorPublicKey?: KeyObject;
  /**
   * Reads a previously-produced DSSE executor-binding envelope back by the settling Delivery's
   * own digest (finding E31 close-out). Backed by `LocalTaskExecutionBackend.getDeliverySignature`
   * -- digest, not AttemptUri, is the only identity `SettlementGradeVerificationInput` carries
   * across the `@jinn-network/marketplace-binding` package boundary. Returns `undefined` when no
   * delivery-signing key was configured, or this digest was never signed.
   */
  readonly getDeliverySignature: (digest: `sha256:${string}`) => Uint8Array | undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

const ENGAGED_OUTCOMES: ReadonlySet<EngagementOutcome> = new Set(['claimed', 'delivered', 'settled']);

function idempotencyKeyFor(config: MarketplaceChainConfig, taskId: bigint): string {
  // Mirrors work-loop.ts's private `idempotencyKeyFor` (not exported, so duplicated here rather
  // than imported) -- `${chainId}:${taskCoordinator}:${taskId}`.
  return `${config.chainId}:${config.taskCoordinator}:${taskId.toString()}`;
}

/** Check 1 -- see file header. */
function checkExecutorBinding(
  deliveryBytes: Uint8Array,
  deliveryDigest: `sha256:${string}`,
  input: Pick<BuildVerifySettlementGradeInput, 'executorKeyId' | 'executorPublicKey' | 'getDeliverySignature'>,
): ExecutorBindingCheck {
  if (input.executorKeyId === undefined || input.executorPublicKey === undefined) {
    return {
      status: 'missing',
      detail: 'native solver-delivery identity is not configured for this composition',
    };
  }
  const envelopeBytes = input.getDeliverySignature(deliveryDigest);
  if (envelopeBytes === undefined) {
    return {
      status: 'missing',
      detail: `no executor-binding envelope recorded for Delivery digest "${deliveryDigest}"`,
    };
  }

  // Defect #34 follow-up: parse with the same authority-bearing STRICT parser the remote
  // evaluator uses (`parseExactDsseEnvelope`, reached there via `verifyNativeDsse`), not the
  // loose structural `parseDsseEnvelope`. The envelope under check is this operator's OWN
  // producer output (`backend.ts`'s `sealExecutorBindingEnvelope`), which emits exactly the
  // canonical encoding the strict parser reconstructs -- so a pass here stays a pass remotely,
  // and any producer encoding drift is caught by the operator's own settlement grade instead of
  // surfacing only as a remote `envelope-signature-invalid` refusal a live round later.
  let envelope: ReturnType<typeof parseExactDsseEnvelope>;
  try {
    envelope = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    return { status: 'invalid', detail: `executor-binding envelope failed DSSE parsing: ${String(cause)}` };
  }
  if (envelope.payloadType !== EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE) {
    return {
      status: 'invalid',
      detail: `executor-binding envelope payloadType "${envelope.payloadType}" is not `
        + `${EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE}`,
    };
  }

  // Seal-once (coordinator ruling, finding E31; TEP §9.1;
  // `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5 "Sealed once, forever"):
  // the signed payload must equal the settling delivery's own exact sealed bytes -- never
  // re-sealed or re-canonicalized, here or in the producer (`backend.ts`'s `completeAttempt`).
  if (!bytesEqual(envelope.payloadBytes, deliveryBytes)) {
    return {
      status: 'invalid',
      detail: 'executor-binding envelope payload is not the exact settling Delivery bytes',
    };
  }

  const signature = envelope.signatures.find((candidate) => candidate.keyid === input.executorKeyId);
  if (signature === undefined) {
    return {
      status: 'invalid',
      detail: `executor-binding envelope carries no signature by expected key "${input.executorKeyId}"`,
    };
  }

  const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  let valid: boolean;
  try {
    valid = cryptoVerify(null, preAuthEncoding, input.executorPublicKey, decodeBase64(signature.sig));
  } catch (cause) {
    return { status: 'invalid', detail: `executor-binding signature verification failed: ${String(cause)}` };
  }
  if (!valid) {
    return { status: 'invalid', detail: 'executor-binding signature does not verify against the expected key' };
  }
  return { status: 'verified' };
}

/** Check 2 -- see file header. */
function checkDispatchBinding(
  attempt: SettlementAttempt,
  config: MarketplaceChainConfig,
  ledger: EngagementLedgerReader,
): DispatchBindingCheck {
  const row =
    attempt.taskId === undefined
      ? ledger.getByRequestId?.(attempt.requestId)
      : ledger.get(idempotencyKeyFor(config, attempt.taskId));

  if (row === undefined) {
    return {
      status: 'missing',
      detail:
        attempt.taskId === undefined
          ? 'engagement ledger carries no requestId correlation for this today-generation '
            + 'settlement identity'
          : `no engagement-ledger row for idempotency key ${idempotencyKeyFor(config, attempt.taskId)}`,
    };
  }

  if (
    row.chainId !== config.chainId
    || row.taskCoordinator.toLowerCase() !== config.taskCoordinator.toLowerCase()
  ) {
    return {
      status: 'failed',
      detail: 'engagement-ledger row chain/coordinator does not match the settling config',
    };
  }
  if (attempt.attemptIndex !== undefined && row.attemptIndex !== attempt.attemptIndex) {
    return {
      status: 'failed',
      detail:
        `engagement-ledger row attemptIndex ${String(row.attemptIndex)} does not match settling `
        + `attemptIndex ${attempt.attemptIndex}`,
    };
  }
  if (!ENGAGED_OUTCOMES.has(row.outcome)) {
    return {
      status: 'failed',
      detail: `engagement-ledger row outcome "${row.outcome}" is not an engaged claim`,
    };
  }
  if (row.claimTxHash === null) {
    return { status: 'failed', detail: 'engagement-ledger row carries no claim transaction hash' };
  }
  // Finding E35 (ruled): resolve the sealed dispatch-context digest back from the ledger row
  // itself -- `work-loop.ts`'s wrapped `claimTask` sealed it once, at claim time, into this same
  // row -- and require it to equal what this settlement expects. A row that predates the seal
  // (`dispatchContextDigest === null`) is not silently treated as a pass.
  if (row.dispatchContextDigest === null) {
    return {
      status: 'failed',
      detail: 'engagement-ledger row carries no sealed dispatch-context digest',
    };
  }
  if (row.dispatchContextDigest !== attempt.expectedDispatchContextDigest) {
    return {
      status: 'failed',
      detail:
        `engagement-ledger row sealed dispatch-context digest ${row.dispatchContextDigest} `
        + `does not match settling expectedDispatchContextDigest ${attempt.expectedDispatchContextDigest}`,
    };
  }
  return { status: 'verified' };
}

/** Check 3 -- see file header. */
function checkEvaluationSpecification(
  attempt: SettlementAttempt,
  profileStore: ProfileStore,
): EvaluationSpecificationCheck {
  if (attempt.taskEvaluationDigest === undefined) return { status: 'not-applicable' };
  const resolved = profileStore.get(attempt.taskEvaluationDigest);
  if (resolved === undefined) {
    return {
      status: 'missing',
      detail: `EvaluationSpec ${attempt.taskEvaluationDigest} is not resolvable in the operator's profile store`,
    };
  }
  return { status: 'verified' };
}

/**
 * Builds the real `verifySettlementGrade` port. Every check above is genuine: given real inputs
 * (a populated engagement ledger, a profile store carrying the referenced EvaluationSpec, and a
 * delivery genuinely signed by a configured delivery-signing key) it reports `"verified"` for the
 * right reason: it inspected exactly that evidence and it held up. Given the same inputs this
 * composition wires by default (empty ledger correlation for today-mode, no
 * `deliverySigningKey` configured), it reports `"missing"` -- also for the right reason: the
 * evidence genuinely is not there yet.
 */
export function buildVerifySettlementGrade(
  input: BuildVerifySettlementGradeInput,
): SettlementPorts['verifySettlementGrade'] {
  return async (
    verificationInput: SettlementGradeVerificationInput,
  ): Promise<SettlementGradeVerification> => ({
    executorBinding: checkExecutorBinding(verificationInput.deliveryBytes, verificationInput.deliveryDigest, input),
    dispatchBinding: checkDispatchBinding(verificationInput.attempt, verificationInput.config, input.engagementLedger),
    evaluationSpecification: checkEvaluationSpecification(verificationInput.attempt, input.profileStore),
  });
}
