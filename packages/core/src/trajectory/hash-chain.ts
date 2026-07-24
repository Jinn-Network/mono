/**
 * In-run per-span hash chain.
 *
 * Scope: §3.1 trajectory-signing-granularity row — "each span carries
 * jinn.prevSpanHash linking to the previous span's hash; first span
 * links to a run-start genesis value derived from envelope task CID."
 *
 * Motivation: a crashed run that failed to upload the signed trajectory
 * blob still produces a verifiable-as-prefix trace if spans are recovered
 * elsewhere (enclave memory dump, challenger capture). Partial authenticity
 * is not zero.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import canonicalize from 'canonicalize';
import type { Span } from './schema.js';

export type Hex = `0x${string}`;

function coerceNonFinite(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(coerceNonFinite);
  if (value !== null && typeof value === 'object') {
    const toJson = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === 'function') return coerceNonFinite(toJson.call(value));
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = coerceNonFinite(entry);
    }
    return output;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const result = canonicalize(coerceNonFinite(value));
  return result ?? 'null';
}

function keccakUtf8(value: string): Hex {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(value)))}`;
}

/** Genesis value for the chain — keccak256(JCS({runStart: taskCid})). */
export function computeGenesisHash(taskCid: string): Hex {
  return keccakUtf8(canonicalJson({ runStart: taskCid }));
}

/** Hash of a finalized span, to be set as jinn.prevSpanHash on the next one. */
export function computePrevSpanHash(span: Span): Hex {
  return keccakUtf8(canonicalJson(span));
}
