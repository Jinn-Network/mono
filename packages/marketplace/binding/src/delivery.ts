// SPDX-License-Identifier: MIT

import type { Hex } from "viem";
import { uploadRawCodecCid, type IpfsPinPort } from "./venue/ipfs.js";
import { keccakEvidenceHash, rejectZeroEvidenceHash } from "./venue/digest.js";

export interface ConvergedDelivery { readonly cid: string; readonly sha256Digest: `sha256:${string}`; readonly keccakEvidenceHash: Hex; }
/** The envelope already is the TEP Delivery: this uploads exact sealed bytes and never wraps/re-seals it. */
export async function convergeDelivery(sealedDeliveryBytes: Uint8Array, ipfs: IpfsPinPort): Promise<ConvergedDelivery> {
  const keccak = keccakEvidenceHash(sealedDeliveryBytes);
  rejectZeroEvidenceHash(keccak);
  return { ...(await uploadRawCodecCid(sealedDeliveryBytes, ipfs)), keccakEvidenceHash: keccak };
}

export type DeliveryCorrespondence = { ok: true } | { ok: false; kind: "digest-divergence"; asserted: { sha256Digest: `sha256:${string}`; keccakEvidenceHash: Hex }; onChain: { sha256CidDigest: `sha256:${string}`; keccak: Hex } };
/** Mandatory today-mode decision-grade digest join; revised mode keeps sha256 only. */
export function checkDeliveryCorrespondence(input: { sha256Digest: `sha256:${string}`; keccakEvidenceHash: Hex; onChainSha256CidDigest: `sha256:${string}`; onChainKeccak: Hex }): DeliveryCorrespondence {
  if (input.sha256Digest === input.onChainSha256CidDigest && input.keccakEvidenceHash === input.onChainKeccak) return { ok: true };
  return { ok: false, kind: "digest-divergence", asserted: { sha256Digest: input.sha256Digest, keccakEvidenceHash: input.keccakEvidenceHash }, onChain: { sha256CidDigest: input.onChainSha256CidDigest, keccak: input.onChainKeccak } };
}
