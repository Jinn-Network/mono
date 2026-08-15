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
  didPkh,
  serializeCeremonyMessage,
  toChecksumAddress,
  type EoaCeremonyEvidence,
  type SiweCeremonyMessage,
} from "@jinn-network/trust-core";

import { TrustAuthoringError } from "./errors.js";

/** The one admitted anchor/ceremony chain — `base-sepolia-calldata-v1`, not a parameter (§3.3). */
export const CEREMONY_CHAIN_ID = 84532 as const;
export const CEREMONY_DOMAIN = "trust.jinn.network" as const;
export const CEREMONY_URI = "https://trust.jinn.network/ceremony/key-binding" as const;

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
 * Builds and EOA-signs the profiled SIWE ceremony. `resources` is `[agentIri, didKey]`, plus — when
 * `settlementSafe` is supplied — `did:pkh:eip155:84532:<EIP-55 Safe>` as the third entry (§2.3b).
 * The third resource rides inside the EIP-191-signed bytes, so it cannot be swapped after the fact:
 * `matchCeremonyContent` re-serializes the structured message and byte-compares before trusting any
 * field, and that comparison already covers resources beyond the first two.
 */
export async function performEoaCeremony(input: {
  readonly signer: CeremonySigner;
  readonly agent: string;
  readonly didKey: string;
  /** `= validFrom =` the anchor's block time, verbatim (§6 law 2). */
  readonly issuedAt: string;
  /** Defaults to the §7 scheme; supply one only to make a ceremony reproducible in a test. */
  readonly nonce?: string;
  readonly settlementSafe?: `0x${string}`;
}): Promise<EoaCeremonyEvidence> {
  if (input.agent.length === 0) throw new TrustAuthoringError("ceremony requires an Agent IRI");
  if (!input.didKey.startsWith("did:key:z")) {
    throw new TrustAuthoringError(`ceremony subject "${input.didKey}" is not a did:key`);
  }
  const resources = [input.agent, input.didKey];
  if (input.settlementSafe !== undefined) {
    resources.push(didPkh(CEREMONY_CHAIN_ID, input.settlementSafe));
  }
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
