// SPDX-License-Identifier: Apache-2.0

/**
 * Role-binding authoring (spec §3.2). One sealed `KeyBinding` per (role key, agent): vouched by the
 * ceremony EOA, self-signed by the role key itself, scoped from `NATIVE_ROLE_IDENTITY_REQUIREMENTS`,
 * anchored on-chain.
 *
 * Every §6 law that can be checked at authoring time IS checked here rather than deferred to a boot
 * refusal: `validFrom` must be the verbatim anchor time and must equal the ceremony's `issuedAt`;
 * the ceremony's declared resources must name this exact agent and key; the resource cardinality
 * (four for settlement-scoped bindings with the Safe ahead of the commitment, three otherwise) is
 * enforced; and the final resource must commit to the binding's exact terms (ceremony currency §2,
 * §3).
 */
import {
  bindingTermsCommitment,
  ceremonyCurrencyFailure,
  ceremonyEvidenceDigest,
  didPkh,
  recordDigest,
  sealKeyBinding,
  type BindingTerms,
  type EoaCeremonyEvidence,
  type KeyBinding,
} from "@jinn-network/trust-core";

import { NATIVE_ANCHOR_CHAIN_ID } from "./anchor.js";
import { TrustAuthoringError } from "./errors.js";
import {
  isSettlementRole,
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  type NativeRoleIdentityRole,
} from "./roles.js";
import type { RoleSigner } from "./signers.js";

export const KEY_BINDING_PROTOCOL = "https://spec.jinn.network/trust/key-binding/v1" as const;

/** A sealed binding plus the fields the catalog writer and the join path need to group by. */
export interface SealedBindingEntry {
  readonly digest: `sha256:${string}`;
  readonly envelopeBytes: Uint8Array;
  readonly ceremony: EoaCeremonyEvidence;
  readonly agent: string;
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly validFrom: string;
  readonly anchorDigest: `sha256:${string}`;
}

/** Union of every trust-core family the role must be able to sign. */
export function scopeForRole(role: NativeRoleIdentityRole): readonly string[] {
  return [...new Set(NATIVE_ROLE_IDENTITY_REQUIREMENTS[role])];
}

/** The binding terms `authorRoleBinding` seals for `role` at `validFrom` (ceremony currency §2). */
export function roleBindingTerms(role: NativeRoleIdentityRole, validFrom: string): BindingTerms {
  return {
    relationship: "controls",
    scope: scopeForRole(role),
    validFrom,
  };
}

export async function authorRoleBinding(input: {
  readonly role: NativeRoleIdentityRole;
  /** The role's own custody — the binding is SELF-signed, which is what ties store to catalog. */
  readonly signer: RoleSigner;
  readonly agent: string;
  /** The EOA that performed the ceremony; becomes the binding's `did:pkh` voucher. */
  readonly ceremonyAccount: `0x${string}`;
  readonly ceremony: EoaCeremonyEvidence;
  /** MUST be the verbatim string `submitAnchor` returned (§6 law 2). */
  readonly validFrom: string;
  readonly anchorDigest: `sha256:${string}`;
}): Promise<SealedBindingEntry> {
  if (input.signer.role !== input.role) {
    throw new TrustAuthoringError(
      `binding for role "${input.role}" was handed the "${input.signer.role}" signer`,
    );
  }
  const resources = input.ceremony.message.resources;
  const expectedResourceCount = isSettlementRole(input.role) ? 4 : 3;
  if (resources.length !== expectedResourceCount) {
    throw new TrustAuthoringError(
      `role "${input.role}" binding requires exactly ${expectedResourceCount} ceremony resources `
        + `(§2.3b, ceremony currency §2), got ${resources.length}`,
    );
  }
  if (resources[0] !== input.agent) {
    throw new TrustAuthoringError(
      `ceremony resources name agent "${resources[0] ?? ""}", not "${input.agent}"`,
    );
  }
  if (resources[1] !== input.signer.keyId) {
    throw new TrustAuthoringError(
      `ceremony resources name key "${resources[1] ?? ""}", not "${input.signer.keyId}"`,
    );
  }
  if (input.ceremony.message.issuedAt !== input.validFrom) {
    throw new TrustAuthoringError(
      `ceremony issuedAt "${input.ceremony.message.issuedAt}" is not the binding validFrom `
        + `"${input.validFrom}" — both must be the verbatim anchor block time (§6 law 2)`,
    );
  }
  const terms = roleBindingTerms(input.role, input.validFrom);
  const expectedCommitment = bindingTermsCommitment(terms);
  const actualCommitment = resources[resources.length - 1];
  if (actualCommitment !== expectedCommitment) {
    throw new TrustAuthoringError(
      `ceremony commits to terms "${actualCommitment ?? ""}", not the binding's "${expectedCommitment}" `
        + "(ceremony currency §2)",
    );
  }
  const currencyFailure = ceremonyCurrencyFailure(input.ceremony.message, terms, {
    profile: { termsCutover: input.validFrom },
    effectiveStart: input.validFrom,
  });
  if (currencyFailure !== undefined) {
    throw new TrustAuthoringError(currencyFailure);
  }

  const binding: KeyBinding = {
    protocol: KEY_BINDING_PROTOCOL,
    agent: input.agent,
    key: {
      publicKey: input.signer.keyId,
      keyid: input.signer.keyId,
      algorithm: "Ed25519",
      didKey: input.signer.keyId,
    },
    voucher: {
      kind: "account",
      did: didPkh(NATIVE_ANCHOR_CHAIN_ID, input.ceremonyAccount),
      contractAccount: false,
    },
    relationship: terms.relationship,
    scope: [...terms.scope],
    validFrom: terms.validFrom,
    ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(input.ceremony) },
    strength: "strong",
    anchors: [{ digest: input.anchorDigest }],
  };
  const sealed = await sealKeyBinding(binding, input.signer.dsseSigner);
  return {
    digest: recordDigest(sealed.envelopeBytes),
    envelopeBytes: sealed.envelopeBytes,
    ceremony: input.ceremony,
    agent: input.agent,
    role: input.role,
    keyId: input.signer.keyId,
    validFrom: input.validFrom,
    anchorDigest: input.anchorDigest,
  };
}
