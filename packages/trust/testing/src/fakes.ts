// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope } from "@jinn-network/trust-core";
import type {
  AnchorObservation,
  AnchorResolver,
  BindingResolver,
  DsseChainVerificationResult,
  DsseChainVerifier,
  ResolvedBinding,
  Sha256Digest,
  WitnessResult,
  WitnessVerifier,
} from "@jinn-network/trust-core";

// ---------------------------------------------------------------------------
// In-memory implementations of the three trust-core interfaces
// (`BindingResolver`/`AnchorResolver`/`WitnessVerifier`) plus a fake
// `DsseChainVerifier`, so the conformance battery, adversarial set, and
// walkthroughs run without RPC (design §16; a downstream consumer can pass
// `trust-resolve`'s real implementations to the same
// `describeTrustVerificationContract`, Task T14's plan text).
//
// Finding: the `dsseVerifier` fake trusts every `keyid` an envelope
// declares as a valid signer -- it does not check cryptographic
// signatures. This is consistent with the T7 finding recorded on
// `trust-core`'s `policy.ts`/`verify.ts`: real DSSE-signature
// verification is multicodec-aware `did:key` decode work deferred
// everywhere in this tree. Adversarial cases that need "envelope accepted
// on signature alone MUST fail" (§16) exercise it by constructing an
// envelope whose declared keyid does NOT match the claimed signer, not by
// forging cryptographic bytes.
// ---------------------------------------------------------------------------

export interface RegisteredBinding {
  readonly key: string;
  readonly agent: string;
  readonly resolved: ResolvedBinding;
  /** Inclusive lower bound on `atTime` for which this registration
   * resolves. */
  readonly validFrom: string;
  /** Exclusive upper bound. Omit for "still current" -- e.g. a rotation
   * scenario registers the old key/binding with a `validTo` at the new
   * binding's `validFrom`. */
  readonly validTo?: string;
}

export interface FakeTrustResolvers {
  readonly bindingResolver: BindingResolver;
  readonly anchorResolver: AnchorResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  registerBinding(entry: RegisteredBinding): void;
  registerAnchor(digest: Sha256Digest, observation: AnchorObservation): void;
  /** Defaults every witness lookup to `{ verified: true }` until a
   * verifier IRI is registered with an explicit result (adversarial
   * fixtures register `{ verified: false, reason }`). */
  registerWitnessResult(verifier: string, result: WitnessResult): void;
  reset(): void;
}

function fakeDsseVerifier(envelopeBytes: Uint8Array): DsseChainVerificationResult {
  const { signatures } = parseDsseEnvelope(envelopeBytes);
  return {
    validSignerKeyids: signatures
      .map((signature) => signature.keyid)
      .filter((keyid): keyid is string => keyid !== undefined),
  };
}

export function createFakeResolvers(): FakeTrustResolvers {
  let bindings: RegisteredBinding[] = [];
  let anchors = new Map<Sha256Digest, AnchorObservation>();
  let witnessResults = new Map<string, WitnessResult>();

  return {
    bindingResolver: {
      async resolveBinding(query, atTime) {
        const matches = bindings.filter(
          (entry) => entry.key === query.key
            && entry.agent === query.agent
            && atTime >= entry.validFrom
            && (entry.validTo === undefined || atTime < entry.validTo),
        );
        return matches.length > 0 ? matches[matches.length - 1]!.resolved : null;
      },
    },
    anchorResolver: {
      async lookupAnchor(digest) {
        return anchors.get(digest) ?? null;
      },
    },
    witnessVerifier: {
      async verify1271Witness(witness) {
        return witnessResults.get(witness.verifier) ?? { verified: true };
      },
    },
    dsseVerifier: fakeDsseVerifier,
    registerBinding(entry) {
      bindings.push(entry);
    },
    registerAnchor(digest, observation) {
      anchors.set(digest, observation);
    },
    registerWitnessResult(verifier, result) {
      witnessResults.set(verifier, result);
    },
    reset() {
      bindings = [];
      anchors = new Map();
      witnessResults = new Map();
    },
  };
}
