// SPDX-License-Identifier: Apache-2.0

/**
 * Role-binding authoring (spec §3.2). One sealed `KeyBinding` per (role key, agent): vouched by the
 * ceremony EOA, self-signed by the role key itself, scoped from `NATIVE_ROLE_IDENTITY_REQUIREMENTS`,
 * anchored on-chain.
 *
 * Every §6 law that can be checked at authoring time IS checked here rather than deferred to a boot
 * refusal: `validFrom` must be the verbatim anchor time and must equal the ceremony's `issuedAt`;
 * the ceremony's declared resources must name this exact agent and key; and the §2.3b resource
 * cardinality (three for settlement-scoped bindings, two otherwise) is enforced, so PR2's
 * settlement-authority check has the third resource waiting for it.
 */
import {
  ceremonyEvidenceDigest,
  didPkh,
  recordDigest,
  sealKeyBinding,
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
  const expectedResourceCount = isSettlementRole(input.role) ? 3 : 2;
  if (resources.length !== expectedResourceCount) {
    throw new TrustAuthoringError(
      `role "${input.role}" binding requires exactly ${expectedResourceCount} ceremony resources `
        + `(§2.3b), got ${resources.length}`,
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
    relationship: "controls",
    scope: [...scopeForRole(input.role)],
    validFrom: input.validFrom,
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
