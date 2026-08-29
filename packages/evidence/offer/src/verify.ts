// SPDX-License-Identifier: Apache-2.0

import { verifyEnvelopeBinding } from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseChainVerifier,
  PolicyCheckInput,
  ResolvedBinding,
  Sha256Digest,
  VerificationFailureReason,
  WitnessVerifier,
} from "@jinn-network/trust-core";

import { OFFER_TRUST_SCOPE } from "./identifiers.js";
import { parseOfferEnvelope } from "./seal.js";
import type { OfferRecord } from "./schema.js";

export interface VerifyOfferInput {
  readonly envelopeBytes: Uint8Array;
  /** The `did:key` claiming to have signed the envelope. */
  readonly key: string;
  /** The Agent IRI the offer claims to be signed on behalf of — the holder. */
  readonly holder: string;
  /** The offer's effective time; binding resolution and the validity window apply at it. */
  readonly atTime: string;
}

/**
 * The ports stay injected because this package is I/O-free: resolving a key binding walks
 * announcement chains and anchors, and checking a DSSE signature is multicodec-aware
 * `did:key` work that trust-core defers to a port everywhere in this tree.
 */
export interface VerifyOfferDeps {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  readonly policy?: PolicyCheckInput;
}

export type OfferVerificationFailureReason =
  | "envelope-invalid"
  | VerificationFailureReason;

export type OfferVerification =
  | {
      readonly ok: true;
      readonly offer: OfferRecord;
      readonly digest: Sha256Digest;
      readonly holder: string;
      readonly resolvedBinding: ResolvedBinding;
    }
  | {
      readonly ok: false;
      readonly reason: OfferVerificationFailureReason;
      readonly detail: string;
      /** Present when the envelope parsed and only the holder leg failed. */
      readonly offer?: OfferRecord;
      readonly digest?: Sha256Digest;
      /**
       * Present whenever a binding resolved but a later leg refused it — a scope violation is
       * far easier to act on when the caller can see which scopes the binding actually carried.
       */
      readonly resolvedBinding?: ResolvedBinding;
    };

/**
 * Verifies that these bytes are a well-formed sealed offer AND that the holder actually
 * offered it: the envelope signature resolves, through key-binding records, to the claimed
 * holder identity, at the offer's effective time, within the offers trust scope.
 *
 * Both halves are required. A structurally valid offer proves only that someone wrote a
 * price down; it is the binding resolution that makes "only the holder can offer" true.
 */
export async function verifyOffer(
  input: VerifyOfferInput,
  deps: VerifyOfferDeps,
): Promise<OfferVerification> {
  let parsed;
  try {
    parsed = parseOfferEnvelope(input.envelopeBytes);
  } catch (cause) {
    return {
      ok: false,
      reason: "envelope-invalid",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const outcome = await verifyEnvelopeBinding(
    {
      envelopeBytes: input.envelopeBytes,
      key: input.key,
      agent: input.holder,
      family: OFFER_TRUST_SCOPE,
      atTime: input.atTime,
    },
    {
      bindingResolver: deps.bindingResolver,
      witnessVerifier: deps.witnessVerifier,
      dsseVerifier: deps.dsseVerifier,
      ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    },
  );

  if (!outcome.ok || outcome.resolvedBinding === undefined) {
    return {
      ok: false,
      reason: outcome.reason ?? "binding-not-resolved",
      detail: outcome.detail ?? "the offer signature did not resolve to the claimed holder",
      offer: parsed.offer,
      digest: parsed.digest,
      ...(outcome.resolvedBinding === undefined
        ? {}
        : { resolvedBinding: outcome.resolvedBinding }),
    };
  }

  return {
    ok: true,
    offer: parsed.offer,
    digest: parsed.digest,
    holder: input.holder,
    resolvedBinding: outcome.resolvedBinding,
  };
}
