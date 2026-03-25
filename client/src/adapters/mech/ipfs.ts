import type { Hex } from 'viem';
import type { DesiredState, RestorationResult } from '../../types/index.js';
import { IPFS_GATEWAY_PREFIX } from './types.js';

export interface DesiredStatePayload {
  desiredStateId: string;
  description: string;
  context?: Record<string, unknown>;
  type?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;
}

export interface RestorationResultPayload {
  requestId: string;
  data: string;
  artifacts?: string[];
}

export function buildDesiredStatePayload(state: DesiredState): DesiredStatePayload {
  return {
    desiredStateId: state.id,
    description: state.description,
    context: state.context,
    type: state.type,
    attemptId: state.attemptId,
    attemptNumber: state.attemptNumber,
    restorationRequestId: state.restorationRequestId,
  };
}

export function parseDesiredStateFromPayload(payload: Record<string, unknown>): DesiredState {
  return {
    id: (payload.desiredStateId as string) ?? '',
    description: (payload.description as string) ?? '',
    context: payload.context as Record<string, unknown> | undefined,
    type: payload.type as 'restoration' | 'evaluation' | undefined,
    attemptId: payload.attemptId as string | undefined,
    attemptNumber: payload.attemptNumber as number | undefined,
    restorationRequestId: payload.restorationRequestId as string | undefined,
  };
}

export function buildResultPayload(requestId: string, result: RestorationResult): RestorationResultPayload {
  return {
    requestId,
    data: result.data,
    artifacts: result.artifacts,
  };
}

/**
 * Upload JSON to IPFS via the Autonolas registry.
 * Uses pushJsonToIpfs from mech-client-ts — the same function jinn-node uses.
 * Returns [digestHex, cidString].
 */
export async function uploadToIpfs(_registryUrl: string, data: unknown): Promise<string> {
  const { pushJsonToIpfs } = await import('@jinn-network/mech-client-ts/dist/ipfs.js');
  const [, cidString] = await pushJsonToIpfs(data);
  return cidString;
}

export async function fetchFromIpfs(gatewayUrl: string, cid: string): Promise<unknown> {
  const response = await fetch(`${gatewayUrl}/ipfs/${cid}`);
  if (!response.ok) throw new Error(`IPFS fetch failed: ${response.statusText}`);
  return response.json();
}

/**
 * Extract the 32-byte SHA256 digest from a CIDv1 string.
 *
 * CIDv1 structure (base32): multibase + version + codec + multihash
 * Multihash: [0x12 (sha2-256)] [0x20 (32 bytes)] [32 bytes digest]
 *
 * The Mech marketplace uses the raw 32-byte digest as requestData on-chain.
 */
export function cidToDigestHex(cid: string): Hex {
  let bytes: Uint8Array;

  if (cid.startsWith('Qm')) {
    // CIDv0 — base58btc encoded multihash directly
    bytes = base58Decode(cid);
  } else {
    // CIDv1 — decode multibase, skip version byte and codec varint
    const raw = cid.startsWith('b')
      ? base32Decode(cid.slice(1)) // strip 'b' multibase prefix
      : base58Decode(cid.slice(1)); // strip 'z' multibase prefix

    // Skip version (1 byte) and codec (1-2 bytes varint)
    let offset = 1; // skip version
    while (raw[offset] & 0x80) offset++;
    offset++; // skip last byte of varint
    bytes = raw.slice(offset);
  }

  // bytes is now the multihash: [hashFn, length, ...digest]
  if (bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new Error(`Unsupported multihash: fn=0x${bytes[0].toString(16)}, len=${bytes[1]}`);
  }

  const digest = bytes.slice(2, 34);
  return `0x${Buffer.from(digest).toString('hex')}` as Hex;
}

/**
 * Construct an Autonolas IPFS gateway URL from a raw SHA256 digest hex string.
 */
export function digestHexToGatewayUrl(digestHex: string): string {
  const hex = digestHex.startsWith('0x') ? digestHex.slice(2) : digestHex;
  return `${IPFS_GATEWAY_PREFIX}${hex}`;
}

/**
 * Fetch content from IPFS using a raw SHA256 digest hex.
 */
export async function fetchFromDigest(digestHex: string): Promise<unknown> {
  const url = digestHexToGatewayUrl(digestHex);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`IPFS fetch failed: ${response.statusText}`);
  return response.json();
}

// ── Base encoding helpers ────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Decode(str: string): Uint8Array {
  const input = str.toLowerCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}
