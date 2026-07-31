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
 * SCOPE NOTE: the ruling's write scope is this file plus its test only -- `composition-root.ts`'s
 * own (still fail-closed) `buildVerifySettlementGrade` is deliberately left untouched. A follow-up
 * task must delete that local function and wire `venue.settlement.verifySettlementGrade` /
 * `pipelinePorts.settlement.verifySettlementGrade` to `buildVerifySettlementGrade` from this file
 * instead.
 *
 * WHAT EACH CHECK PROVES, AND WHAT IT DOES NOT (read before wiring):
 *
 *  1. `executorBinding` -- DSSE-structural verification (`@jinn-network/trust-core`'s
 *     `parseDsseEnvelope`/`dssePreAuthEncoding`) plus a genuine asymmetric-signature check (Node's
 *     built-in `crypto.verify`, Ed25519). The signed payload is `deliveryBytes` with the
 *     executor-binding extension key itself removed, re-sealed via `sealDelivery` -- an embedded
 *     signature cannot cover its own field (self-reference), so, exactly as a detached signature
 *     would, it binds everything else the settling `deliveryBytes` actually carry: outputs,
 *     outcome, evidenceRecords, and the exact digest of the Task it responds to. Tampering with
 *     any of those fields after signing changes the re-sealed bytes and invalidates the signature.
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
 *     A second, narrower gap applies to the envelope itself: nothing produces this envelope yet.
 *     `LocalTaskExecutionBackendConfig.deliveryExtensions` (the hook that would attach it to a
 *     real Delivery) is still `() => ({})` per composition-root gap 3 / plan task C7 (needs a
 *     synchronous signer port; the operator's only signer today is an async viem `WalletClient`).
 *     Until C7 lands, `executorBinding` will legitimately report `"missing"` against every real
 *     delivery this daemon produces -- correctly, not as a hardcoded stub, because there is
 *     genuinely nothing to verify yet.
 *
 *  2. `dispatchBinding` -- proves this operator's own local engagement ledger
 *     (`./engagement-ledger.ts`) recorded a claim for this exact settlement identity: chain,
 *     task coordinator, and (for revised-generation attempts) attempt index all match, the row's
 *     outcome is an engaged one (`claimed`/`delivered`/`settled`), and a claim transaction hash was
 *     recorded. The ledger is a local, single-operator SQLite table nothing else writes to, so a
 *     matching row is itself the proof "this operator's Safe is the party the venue engaged" --
 *     no additional on-chain read is needed.
 *
 *     Gap: `EngagementLedger`'s schema (`ENGAGEMENT_LEDGER_SCHEMA`, `./engagement-ledger.ts`) keys
 *     rows by `taskId`, which today-generation `SettlementAttempt`s do not carry (only
 *     `requestId` -- see `packages/marketplace/binding/src/settlement.ts`'s `SettlementAttempt`
 *     union). No requestId<->taskId correlation is persisted anywhere in the write scope of this
 *     task. `checkDispatchBinding` below therefore accepts an `EngagementLedgerReader` with an
 *     OPTIONAL `getByRequestId`; the real `EngagementLedger` class does not implement it, so
 *     today-generation dispatchBinding will report `"missing"` (never a fabricated `"verified"`)
 *     until a follow-up task adds that correlation (e.g. `work-loop.ts` already computes both
 *     `taskId` and `requestId` together at claim time -- `claimAttempt`'s return value -- and could
 *     persist the pair). This file's tests prove the logic is correct once that correlation
 *     exists, using a fake resolver.
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
import { z } from 'zod';
import { dssePreAuthEncoding, parseDsseEnvelope } from '@jinn-network/trust-core';
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
import { sealDelivery, type DeliveryRecord } from '@jinn-network/task-execution-protocol';
import type { ProfileStore } from '@jinn-network/task-execution-profiles';
import type { EngagementOutcome, EngagementRow } from './engagement-ledger.js';

/**
 * The namespaced Delivery extension (TEP §21.3) the executor-binding envelope is carried under,
 * once a future task's synchronous signer port populates
 * `LocalTaskExecutionBackendConfig.deliveryExtensions` (composition-root gap 3 / plan C7). Value
 * shape: `{ envelope: <base64 sealed DSSE envelope bytes> }`, whose payload is required (below) to
 * equal the delivery's own canonical bytes with this extension key removed (an embedded signature
 * cannot cover its own field).
 */
export const EXECUTOR_BINDING_EXTENSION_URI =
  'https://jinn.network/marketplace/extensions/executor-binding/1.0' as const;

/** The DSSE envelope's required `payloadType`, matching the convention `named-checks.ts` already
 * uses for its own vendor media types (`SUBMISSION_DSSE_PAYLOAD_TYPE`, `VERDICT_DSSE_PAYLOAD_TYPE`). */
export const EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE =
  'application/vnd.jinn.marketplace.executor-binding.v1+json' as const;

const ExecutorBindingExtensionSchema = z.object({
  envelope: z.string().min(1),
});

/**
 * Minimal reader surface `checkDispatchBinding` needs. `EngagementLedger` (`./engagement-ledger.
 * ts`) satisfies this structurally via its real `get()` -- `getByRequestId` is optional and, on
 * the real ledger, absent (see file header gap 2) until a follow-up task adds a requestId
 * correlation for today-generation attempts.
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
  readonly executorKeyId: string;
  /** The public-key counterpart of the operator's own delivery-signing key (Ed25519). */
  readonly executorPublicKey: KeyObject;
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
  delivery: DeliveryRecord,
  input: Pick<BuildVerifySettlementGradeInput, 'executorKeyId' | 'executorPublicKey'>,
): ExecutorBindingCheck {
  const raw = (delivery as Record<string, unknown>)[EXECUTOR_BINDING_EXTENSION_URI];
  if (raw === undefined) {
    return {
      status: 'missing',
      detail: `Delivery carries no "${EXECUTOR_BINDING_EXTENSION_URI}" extension`,
    };
  }
  const parsed = ExecutorBindingExtensionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'invalid',
      detail: `executor-binding extension failed schema validation: ${parsed.error.message}`,
    };
  }

  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try {
    envelope = parseDsseEnvelope(decodeBase64(parsed.data.envelope));
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

  // An embedded signature cannot cover its own field, so the signed payload is deliveryBytes
  // minus this extension, re-sealed -- everything else the settling delivery actually carries.
  const { [EXECUTOR_BINDING_EXTENSION_URI]: _own, ...deliveryWithoutExtension } =
    delivery as Record<string, unknown>;
  let unsignedDeliveryBytes: Uint8Array;
  try {
    unsignedDeliveryBytes = sealDelivery(deliveryWithoutExtension);
  } catch (cause) {
    return {
      status: 'invalid',
      detail: `Delivery minus its executor-binding extension does not re-seal cleanly: ${String(cause)}`,
    };
  }
  if (!bytesEqual(envelope.payloadBytes, unsignedDeliveryBytes)) {
    return {
      status: 'invalid',
      detail: 'executor-binding envelope payload is not the exact delivery bytes (minus this extension)',
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
            + 'settlement identity (see settlement-grade.ts file header gap 2)'
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
 * delivery genuinely carrying a validly-signed executor-binding extension) it reports `"verified"`
 * for the right reason: it inspected exactly that evidence and it held up. Given the same inputs
 * this composition wires today (empty ledger correlation for today-mode, no
 * `deliveryExtensions`-populated envelope yet), it reports `"missing"` -- also for the right
 * reason: the evidence genuinely is not there yet.
 */
export function buildVerifySettlementGrade(
  input: BuildVerifySettlementGradeInput,
): SettlementPorts['verifySettlementGrade'] {
  return async (
    verificationInput: SettlementGradeVerificationInput,
  ): Promise<SettlementGradeVerification> => ({
    executorBinding: checkExecutorBinding(verificationInput.delivery, input),
    dispatchBinding: checkDispatchBinding(verificationInput.attempt, verificationInput.config, input.engagementLedger),
    evaluationSpecification: checkEvaluationSpecification(verificationInput.attempt, input.profileStore),
  });
}
