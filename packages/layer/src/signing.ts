import { hexToBytes, keccak256, toHex } from 'viem';
import { sign } from 'viem/accounts';
import { canonicalJson } from '@jinn-network/core';

export interface SignedCanonical {
  canonicalJson: string;
  hash: `0x${string}`;
  sig: `0x${string}`;
  signer: `0x${string}`;
}

/** Sign canonical JSON with raw secp256k1 ECDSA (no EIP-191 prefix). */
export async function signCanonical(
  value: unknown,
  privateKey: `0x${string}`,
  signerAddress: `0x${string}`,
): Promise<SignedCanonical> {
  const canonical = canonicalJson(value);
  const hash = keccak256(new TextEncoder().encode(canonical));
  const signature = await sign({ hash, privateKey });
  const recoveryByte =
    signature.yParity ?? (signature.v === 28n ? 1 : 0);
  const sig = toHex(
    new Uint8Array([
      ...hexToBytes(signature.r),
      ...hexToBytes(signature.s),
      recoveryByte,
    ]),
  );
  return {
    canonicalJson: canonical,
    hash,
    sig,
    signer: signerAddress,
  };
}
