/**
 * In-run per-span hash chain.
 *
 * Scope: §3.1 trajectory-signing-granularity row — "each span carries
 * jinn.prevSpanHash linking to the previous span's hash; first span
 * links to a run-start genesis value derived from envelope intent CID."
 *
 * Motivation: a crashed run that failed to upload the signed trajectory
 * blob still produces a verifiable-as-prefix trace if spans are recovered
 * elsewhere (enclave memory dump, challenger capture). Partial authenticity
 * is not zero.
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { canonicalJson } from '../restorer/engine/canonical-json.js';
import type { Span } from './schema.js';

/** Genesis value for the chain — keccak256(JCS({runStart: intentCid})). */
export function computeGenesisHash(intentCid: string): Hex {
  return keccak256(toBytes(canonicalJson({ runStart: intentCid })));
}

/** Hash of a finalized span, to be set as jinn.prevSpanHash on the next one. */
export function computePrevSpanHash(span: Span): Hex {
  return keccak256(toBytes(canonicalJson(span)));
}
