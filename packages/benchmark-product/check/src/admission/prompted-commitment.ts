// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes } from "@jinn-network/task-execution-profiles";
import {
  ScreeningSampleCommitmentSchema,
  type ScreeningSampleCommitment,
} from "./contracts.js";

export interface PromptedScreeningCommitmentView {
  readonly committedAt: string;
  readonly poolIdentityCommitmentSha256: string;
  readonly sampleSeed: string;
  readonly sampleSize: 72;
  readonly registeredIdentitySha256s?: readonly string[];
  readonly samplingScriptSha256?: string;
  readonly sampleItemSha256s?: readonly string[];
  readonly draftId?: string;
  readonly poolSha256?: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Parse the two exact wire encodings. Internal Colophon envelopes use bare canonical JSON;
 * external registration files use the canonical one-record JSONL form with exactly one final LF.
 */
export function parseScreeningSampleCommitmentBytes(bytes: Uint8Array): ScreeningSampleCommitment {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("screening sample commitment is not UTF-8 JSON");
  }
  const parsed = ScreeningSampleCommitmentSchema.safeParse(input);
  if (!parsed.success) throw new TypeError(`screening sample commitment failed its closed schema: ${parsed.error.message}`);
  const canonical = canonicalJsonBytes(parsed.data);
  const expected = "candidateItemDigests" in parsed.data
    ? new Uint8Array([...canonical, 0x0a])
    : canonical;
  if (!sameBytes(bytes, expected)) {
    throw new TypeError("screening sample commitment is not in its exact canonical wire encoding");
  }
  return parsed.data;
}

/** Normalize the original internal envelope and exact external registration shape for replay. */
export function promptedScreeningCommitmentView(
  commitment: ScreeningSampleCommitment,
): PromptedScreeningCommitmentView {
  if (!("candidateItemDigests" in commitment)) {
    return {
      committedAt: commitment.committedAt,
      poolIdentityCommitmentSha256: commitment.poolIdentityCommitmentSha256,
      sampleSeed: commitment.sampleSeed,
      sampleSize: commitment.sampleSize,
      sampleItemSha256s: commitment.sampleItemSha256s,
      draftId: commitment.draftId,
      poolSha256: commitment.poolSha256,
    };
  }
  return {
    committedAt: commitment.committedAt,
    poolIdentityCommitmentSha256: commitment.poolDigest,
    sampleSeed: commitment.sampleSeed,
    sampleSize: commitment.sampleSize,
    registeredIdentitySha256s: commitment.candidateItemDigests,
    samplingScriptSha256: commitment.samplingScriptSha256,
  };
}
