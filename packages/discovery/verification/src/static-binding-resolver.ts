// SPDX-License-Identifier: Apache-2.0

import {
  compareCalendarStrictRfc3339Instants,
  compareCodeUnitStrings,
  recordDigest,
  validateKeyBinding,
} from "@jinn-network/trust-core";
import type {
  BindingResolver,
  CeremonyType,
  Eip1271Witness,
  EoaCeremonyEvidence,
  KeyBinding,
  ResolvedBinding,
  Sha256Digest,
} from "@jinn-network/trust-core";

import { createDidKeyDsseVerifier } from "./dsse.js";

/** A sealed key binding, with the evidence its ceremony needs when the ceremony can be run offline. */
export interface StaticKeyBinding {
  readonly envelopeBytes: Uint8Array;
  /** Needed for an `eoa` binding, or `verifyEnvelopeBinding` refuses it at step 3. */
  readonly ceremonyEvidence?: EoaCeremonyEvidence;
  /** Needed for a `safe` binding, together with a witness verifier. */
  readonly witness?: Eip1271Witness;
}

/**
 * `verifyEnvelopeBinding` checks `eoa` and `safe` ceremonies itself. For every other type it takes
 * a resolved binding as proof the resolver ran that ceremony, which a list of bytes cannot do.
 */
const CEREMONIES_CHECKED_OFFLINE: ReadonlySet<CeremonyType> = new Set<CeremonyType>(["eoa", "safe"]);

interface HeldBinding extends StaticKeyBinding {
  readonly binding: KeyBinding;
  readonly bindingDigest: Sha256Digest;
  /** False for a ceremony this cannot run. Such a binding never resolves, and it is still a binding. */
  readonly resolvable: boolean;
}

function hold(entry: Uint8Array | StaticKeyBinding, verifySignature: ReturnType<typeof createDidKeyDsseVerifier>): readonly HeldBinding[] {
  const held = entry instanceof Uint8Array ? { envelopeBytes: entry } : entry;
  const { value: binding, conforms } = validateKeyBinding(held.envelopeBytes);
  if (!conforms || binding === undefined) return [];
  // §7.1: a binding proves possession by being signed with the key it binds.
  if (!verifySignature(held.envelopeBytes).validSignerKeyids.includes(binding.key.didKey)) return [];
  return [{
    ...held,
    binding,
    bindingDigest: recordDigest(held.envelopeBytes),
    resolvable: CEREMONIES_CHECKED_OFFLINE.has(binding.ceremony.type),
  }];
}

/** A comparison of two instants already validated by `KeyBindingSchema`, or by the caller's `atTime`. */
function compareInstants(left: string, right: string): number {
  return compareCalendarStrictRfc3339Instants(left, right) ?? Number.NaN;
}

function isInWindow({ validFrom, expiresAt }: KeyBinding, atTime: string): boolean {
  return compareInstants(atTime, validFrom) >= 0
    && (expiresAt === undefined || compareInstants(atTime, expiresAt) <= 0);
}

function byEffectiveStart(left: HeldBinding, right: HeldBinding): number {
  return compareInstants(left.binding.validFrom, right.binding.validFrom)
    || compareCodeUnitStrings(left.bindingDigest, right.bindingDigest);
}

/**
 * A `BindingResolver` over key bindings the caller already holds, for checking a set offline.
 *
 * It follows `createBindingResolver` in `@jinn-network/trust-resolve`, without the chain: a binding's
 * effective start is its own `validFrom`, because nothing here can observe an anchor, and two
 * bindings of one pair resolve to the earlier.
 *
 * What it gives up, so a caller can decide whether that is acceptable:
 * - No anchors. A backdated `validFrom` is believed. Under an anchor-requiring profile use the chain.
 * - No revocations. Leave a revoked binding out of the list.
 * - No `agentId`, `oidc-machine` or `github-human` bindings: they do not resolve, because trust-core
 *   leaves those ceremonies to the resolver and this one cannot run them. They still count as
 *   earlier bindings of their Agent, so §7.4a's consent rule holds against what comes after them.
 *
 * A binding that does not conform, or that the key it binds did not sign, is not held at all.
 * Holding the bytes is not trusting them: `verifyEnvelopeBinding` still verifies the ceremony.
 * Genesis is the earliest `validFrom` in the list, so a backdated binding becomes the genesis. Pass
 * only bindings you have reason to accept.
 */
export function createStaticBindingResolver(keyBindingEnvelopes: readonly (Uint8Array | StaticKeyBinding)[]): BindingResolver {
  const verifySignature = createDidKeyDsseVerifier();
  const held = keyBindingEnvelopes.flatMap((entry) => hold(entry, verifySignature)).sort(byEffectiveStart);

  return {
    async resolveBinding({ key, agent }, atTime): Promise<ResolvedBinding | null> {
      const forAgent = held.filter(({ binding }) => binding.agent === agent);
      const winner = forAgent.find(({ binding, resolvable }) => resolvable && binding.key.didKey === key && isInWindow(binding, atTime));
      if (winner === undefined) return null;
      // §7.4a: a binding that cannot resolve still came first, so a later one is not the genesis.
      // It cannot stand as the incumbent either, because its ceremony was not run.
      const incumbent = forAgent.find((candidate) =>
        candidate !== winner
        && candidate.resolvable
        && candidate.binding.relationship === "controls"
        && isInWindow(candidate.binding, winner.binding.validFrom));
      return {
        binding: winner.binding,
        envelopeBytes: winner.envelopeBytes,
        bindingDigest: winner.bindingDigest,
        effectiveStart: winner.binding.validFrom,
        isGenesis: forAgent[0] === winner,
        revocations: [],
        ...(winner.ceremonyEvidence === undefined ? {} : { ceremonyEvidence: winner.ceremonyEvidence }),
        ...(winner.witness === undefined ? {} : { witness: winner.witness }),
        ...(incumbent === undefined ? {} : { incumbentControlVoucher: incumbent.binding.voucher }),
      };
    },
  };
}
