// SPDX-License-Identifier: Apache-2.0

/**
 * The profiled EOA key-binding ceremony (spec §2.3a/b, §7).
 *
 * Two invariants are authored in, not checked later:
 *   - `message.address` is ALWAYS the actual EIP-191 signer. A contract account never appears here;
 *     the service Safe rides as a declared resource instead (§2.3b), so every field of the signed
 *     message stays literally true.
 *   - `expirationTime` is absent. Ceremony evidence is verified offline forever, and an expiring
 *     ceremony would reintroduce exactly the retroactive-invalidity problem §2.3d refuses.
 */
import { randomBytes } from "node:crypto";
import {
  bindingTermsCommitment,
  didPkh,
  isCalendarStrictRfc3339,
  serializeCeremonyMessage,
  toChecksumAddress,
  type BindingTerms,
  type EoaCeremonyEvidence,
  type SiweCeremonyMessage,
} from "@jinn-network/trust-core";

import { TrustAuthoringError } from "./errors.js";

/** The one admitted anchor/ceremony chain — `base-sepolia-calldata-v1`, not a parameter (§3.3). */
export const CEREMONY_CHAIN_ID = 84532 as const;
export const CEREMONY_DOMAIN = "trust.jinn.network" as const;
export const CEREMONY_URI = "https://trust.jinn.network/ceremony/key-binding" as const;
const BINDING_TERMS_COMMITMENT_FAMILY = "urn:jinn:trust:binding-terms:";

/** A viem-account-shaped local signer: an address plus raw-message EIP-191 signing. */
export interface CeremonySigner {
  readonly address: `0x${string}`;
  signMessage(input: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`>;
}

/** §7's nonce scheme: 16 random bytes, lowercase hex, fresh per ceremony. */
export function ceremonyNonce(): string {
  return randomBytes(16).toString("hex");
}

function hexToBytes(value: `0x${string}`): Uint8Array {
  const body = value.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(body)) {
    throw new TrustAuthoringError(`ceremony signature "${value}" is not hex`);
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Builds and EOA-signs the profiled SIWE ceremony. `resources` is `[agentIri, didKey]`, plus
 * `did:pkh:eip155:84532:<EIP-55 Safe>` when `settlementSafe` is supplied (§2.3b), followed by
 * `urn:jinn:trust:binding-terms:v1:sha256:<digest>` as the final resource (ceremony currency §2,
 * §3). Both ride inside the EIP-191-signed bytes, so neither the Safe nor the binding's terms can
 * be swapped after the fact: `matchCeremonyContent` re-serializes the structured message and
 * byte-compares before trusting any field.
 */
export async function performEoaCeremony(input: {
  readonly signer: CeremonySigner;
  readonly agent: string;
  readonly didKey: string;
  /** `= validFrom =` the anchor's block time, verbatim (§6 law 2). */
  readonly issuedAt: string;
  /** The binding terms this ceremony commits to (ceremony currency §2). */
  readonly terms: BindingTerms;
  /** Defaults to the §7 scheme; supply one only to make a ceremony reproducible in a test. */
  readonly nonce?: string;
  readonly settlementSafe?: `0x${string}`;
}): Promise<EoaCeremonyEvidence> {
  if (input.agent.length === 0) throw new TrustAuthoringError("ceremony requires an Agent IRI");
  if (input.agent.startsWith(BINDING_TERMS_COMMITMENT_FAMILY)) {
    throw new TrustAuthoringError(
      `ceremony agent "${input.agent}" cannot use the "${BINDING_TERMS_COMMITMENT_FAMILY}" URN family`,
    );
  }
  if (!input.didKey.startsWith("did:key:z")) {
    throw new TrustAuthoringError(`ceremony subject "${input.didKey}" is not a did:key`);
  }
  if (!isCalendarStrictRfc3339(input.issuedAt)) {
    throw new TrustAuthoringError(`ceremony issuedAt "${input.issuedAt}" cannot be read`);
  }
  if (input.terms.relationship !== "controls" && input.terms.relationship !== "signs-for") {
    throw new TrustAuthoringError(`ceremony terms relationship "${String(input.terms.relationship)}" is invalid`);
  }
  if (input.terms.scope.length === 0 || input.terms.scope.some((entry) => entry.length === 0)) {
    throw new TrustAuthoringError("ceremony terms require a non-empty scope");
  }
  if (!isCalendarStrictRfc3339(input.terms.validFrom)) {
    throw new TrustAuthoringError(`ceremony terms validFrom "${input.terms.validFrom}" cannot be read`);
  }
  if (input.terms.expiresAt !== undefined && !isCalendarStrictRfc3339(input.terms.expiresAt)) {
    throw new TrustAuthoringError(`ceremony terms expiresAt "${input.terms.expiresAt}" cannot be read`);
  }
  const resources = [input.agent, input.didKey];
  if (input.settlementSafe !== undefined) {
    resources.push(didPkh(CEREMONY_CHAIN_ID, input.settlementSafe));
  }
  resources.push(bindingTermsCommitment(input.terms));
  const message: SiweCeremonyMessage = {
    domain: CEREMONY_DOMAIN,
    // §2.3a: never a contract account, never any address that did not sign.
    address: toChecksumAddress(input.signer.address),
    uri: CEREMONY_URI,
    version: "1",
    chainId: CEREMONY_CHAIN_ID,
    nonce: input.nonce ?? ceremonyNonce(),
    issuedAt: input.issuedAt,
    resources,
  };
  const messageBytes = serializeCeremonyMessage("eoa", message);
  const signature = hexToBytes(await input.signer.signMessage({ message: { raw: messageBytes } }));
  return { type: "eoa", message, messageBytes, signature };
}
