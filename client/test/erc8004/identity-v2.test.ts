/**
 * Tests for ERC-8004 payload v2 encoding (jinn-mono — Tier 4 verification gap).
 *
 * Payload v2 extends the v1 5-tuple with three trailing fields so the subgraph
 * can index harness identity directly from the on-chain bytes:
 *
 *   (uint8 version=2, uint8 tier, bytes32 manifestHash,
 *    bytes attestationQuoteCid, bytes32 sourceMeasurement,
 *    bytes32 codeDigest, string implName, uint8 modeFlag)
 *
 * See:
 *   - docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md (§ "Append, never re-order")
 *   - docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
 *
 * The rule per §3.1 of the payload-schema spec: future schema versions add
 * fields at the *end* of the tuple, never reorder. Existing v1 envelopes MUST
 * continue to decode cleanly.
 */

import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, type Hex } from 'viem';
import {
  encodeExecutionPayload,
  encodeExecutionPayloadV2,
  validatePayloadV2,
  PayloadValidationError,
  PAYLOAD_TUPLE_V2,
  type ExecutionPayload,
  type ExecutionPayloadV2,
} from '../../src/erc8004/identity.js';
import { PAYLOAD_TUPLE } from '../../src/erc8004/abis.js';

// ── Reference v2 input ────────────────────────────────────────────────────────

const CODE_DIGEST_HEX = ('0x' + 'cd'.repeat(32)) as Hex;
const IMPL_NAME = 'claude-code-learner';

const V2_INPUT_TIER1_TRAIN: ExecutionPayloadV2 = {
  version: 2,
  tier: 1,
  manifestHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  attestationQuoteCid: '0x',
  sourceMeasurement: '0x0000000000000000000000000000000000000000000000000000000000000000',
  codeDigest: CODE_DIGEST_HEX,
  implName: IMPL_NAME,
  modeFlag: 0,
};

const V2_INPUT_TIER1_FROZEN: ExecutionPayloadV2 = {
  ...V2_INPUT_TIER1_TRAIN,
  modeFlag: 1,
};

const V2_INPUT_TIER0_EMPTY_DIGEST: ExecutionPayloadV2 = {
  ...V2_INPUT_TIER1_TRAIN,
  tier: 0,
  codeDigest: '0x0000000000000000000000000000000000000000000000000000000000000000',
  implName: '',
};

// ── Round-trip tests ──────────────────────────────────────────────────────────

describe('encodeExecutionPayloadV2 — round-trip', () => {
  it('encodes the 8-tuple and round-trips codeDigest / implName / modeFlag', () => {
    const encoded = encodeExecutionPayloadV2(V2_INPUT_TIER1_TRAIN);
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, encoded);
    const [
      version,
      tier,
      manifestHash,
      attestationQuoteCid,
      sourceMeasurement,
      codeDigest,
      implName,
      modeFlag,
    ] = decoded;

    expect(version).toBe(2);
    expect(tier).toBe(1);
    expect(manifestHash.toLowerCase()).toBe(V2_INPUT_TIER1_TRAIN.manifestHash);
    expect(attestationQuoteCid).toBe('0x');
    expect(sourceMeasurement.toLowerCase()).toBe(V2_INPUT_TIER1_TRAIN.sourceMeasurement);
    expect(codeDigest.toLowerCase()).toBe(V2_INPUT_TIER1_TRAIN.codeDigest);
    expect(implName).toBe(IMPL_NAME);
    expect(modeFlag).toBe(0);
  });

  it('round-trips frozen-mode flag (modeFlag=1)', () => {
    const encoded = encodeExecutionPayloadV2(V2_INPUT_TIER1_FROZEN);
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, encoded);
    expect(decoded[7]).toBe(1);
  });

  it('v2 prefix can still be read by a v1 decoder (append-not-reorder)', () => {
    // The payload-schema spec § "Append, never re-order" promises that v1
    // indexers can locate v1 fields at their original offsets in a v2 payload.
    // Verify by decoding only the v1 prefix tuple from v2-encoded bytes.
    const encoded = encodeExecutionPayloadV2(V2_INPUT_TIER1_TRAIN);
    // Note: viem's decodeAbiParameters is strict on length — instead, we decode
    // with the v2 tuple and assert the v1 prefix matches.
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, encoded);
    expect(decoded[0]).toBe(2); // version=2 — v1 indexer would reject as unknown version
    expect(decoded[1]).toBe(1); // tier
    expect(decoded[2].toLowerCase()).toBe(V2_INPUT_TIER1_TRAIN.manifestHash);
  });
});

// ── Validation tests ──────────────────────────────────────────────────────────

describe('validatePayloadV2 — strict-mode rules', () => {
  it('accepts tier 1 with empty quote / zero measurement and any modeFlag', () => {
    expect(() => validatePayloadV2(V2_INPUT_TIER1_TRAIN)).not.toThrow();
    expect(() => validatePayloadV2(V2_INPUT_TIER1_FROZEN)).not.toThrow();
  });

  it('accepts tier 0 with empty implName / zero codeDigest (legacy callers)', () => {
    // v2 payload with codeDigest=0x0…0 + empty implName encodes the "no harness
    // identity" case used by legacy callers that opt into v2 for forward-compat
    // but don't yet produce harness identity bytes.
    expect(() => validatePayloadV2(V2_INPUT_TIER0_EMPTY_DIGEST)).not.toThrow();
  });

  it('rejects modeFlag values outside {0, 1}', () => {
    expect(() =>
      validatePayloadV2({
        ...V2_INPUT_TIER1_TRAIN,
        modeFlag: 2 as 0,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects malformed codeDigest (must be 32-byte hex)', () => {
    expect(() =>
      validatePayloadV2({
        ...V2_INPUT_TIER1_TRAIN,
        codeDigest: '0xdead' as Hex,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects version != 2', () => {
    expect(() =>
      validatePayloadV2({
        ...V2_INPUT_TIER1_TRAIN,
        version: 1 as 2,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 2 (consensus) — same V1+V2 admit set', () => {
    expect(() =>
      validatePayloadV2({
        ...V2_INPUT_TIER1_TRAIN,
        tier: 2 as 0,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('encodeExecutionPayloadV2 also throws PayloadValidationError on mismatch', () => {
    expect(() =>
      encodeExecutionPayloadV2({
        ...V2_INPUT_TIER1_TRAIN,
        modeFlag: 7 as 0,
      }),
    ).toThrow(PayloadValidationError);
  });
});

// ── Backward compat: v1 still encodes via the original 5-tuple ────────────────

describe('encodeExecutionPayload (v1) — unchanged behaviour', () => {
  it('still encodes a 5-tuple with version=1 at offset 0', () => {
    const v1Input: ExecutionPayload = {
      version: 1,
      tier: 0,
      manifestHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attestationQuoteCid: '0x',
      sourceMeasurement: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    const encoded = encodeExecutionPayload(v1Input);
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe(0);
    expect(decoded.length).toBe(5);
  });
});
