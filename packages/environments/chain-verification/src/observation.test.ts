// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  CanonicalChainObservationSchema,
  buildCanonicalChainObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
  chainObservationsEqual,
} from "./observation.js";

const RAW = {
  schema: CHAIN_OBSERVATION_SCHEMA_ID,
  probes: [
    {
      id: "transfer-happy-path",
      transactionDigest: `sha256:${"1".repeat(64)}`,
      receiptStatus: "success",
      gasUsed: "51234",
      logs: [{
        address: "0x00000000000000000000000000000000000000aa",
        topics: [`0x${"2".repeat(64)}`],
        data: "0x00",
      }],
      returnData: "0x",
    },
    {
      id: "out-of-slice-read-is-empty",
      receiptStatus: "not-executed",
      gasUsed: "0",
      logs: [],
      returnData: "0x",
      expectedErrorClass: "empty-account",
      observedErrorClass: "empty-account",
    },
  ],
  touchedState: [
    {
      address: "0x00000000000000000000000000000000000000bb",
      nonce: "1",
      balance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      codeHash: `0x${"3".repeat(64)}`,
      storage: [
        { slot: `0x${"0".repeat(63)}2`, value: `0x${"0".repeat(63)}9` },
        { slot: `0x${"0".repeat(63)}1`, value: `0x${"0".repeat(63)}7` },
      ],
    },
    {
      address: "0x00000000000000000000000000000000000000aa",
      nonce: "0",
      balance: "0",
      codeHash: `0x${"4".repeat(64)}`,
      storage: [],
    },
  ],
  stateReads: [],
  traceProjectionDigest: `sha256:${"5".repeat(64)}`,
  finalStateCommitment: `0x${"6".repeat(64)}`,
  blocks: [{
    number: "17",
    hash: `0x${"7".repeat(64)}`,
    stateRoot: `0x${"8".repeat(64)}`,
    timestamp: "1900000000",
  }],
} as const;

describe("canonical chain observation", () => {
  it("accepts the reference observation", () => {
    expect(CanonicalChainObservationSchema.safeParse(RAW).success).toBe(true);
  });

  it("sorts touched state and storage, and leaves probes in declared order", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonical.touchedState.map((entry) => entry.address)).toEqual([
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
    ]);
    const bb = canonical.touchedState[1]!;
    expect(bb.storage.map((slot) => slot.slot)).toEqual([
      `0x${"0".repeat(63)}1`,
      `0x${"0".repeat(63)}2`,
    ]);
    // Probe order is semantic: the suite declares it, so canonicalization must not reorder.
    expect(canonical.probes.map((probe) => probe.id)).toEqual([
      "transfer-happy-path",
      "out-of-slice-read-is-empty",
    ]);
  });

  it("hashes the canonical form, so a permuted input digests identically", () => {
    const permuted = {
      ...RAW,
      touchedState: [RAW.touchedState[1], RAW.touchedState[0]],
    };
    expect(chainObservationDigest(buildCanonicalChainObservation(permuted)))
      .toBe(chainObservationDigest(buildCanonicalChainObservation(RAW)));
    expect(chainObservationsEqual(
      buildCanonicalChainObservation(permuted),
      buildCanonicalChainObservation(RAW),
    )).toBe(true);
  });

  it("digests the RFC 8785 bytes of the canonical form and nothing else", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonicalChainObservationBytes(canonical))
      .toEqual(canonicalJsonBytes(canonical));
    expect(chainObservationDigest(canonical))
      .toBe(recordDigest(canonicalJsonBytes(canonical)));
  });

  it("carries large quantities as strings so precision cannot be lost", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonical.touchedState[1]!.balance)
      .toBe("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    expect(() => buildCanonicalChainObservation({
      ...RAW,
      touchedState: [{ ...RAW.touchedState[0], balance: 1 }],
    })).toThrow(ChainVerificationError);
  });

  it("rejects uppercase hex, bare quantities, and unknown keys", () => {
    for (const mutation of [
      { touchedState: [{ ...RAW.touchedState[0], address: "0x00000000000000000000000000000000000000AA" }] },
      { touchedState: [{ ...RAW.touchedState[0], nonce: "0x1" }] },
      { traceProjectionDigest: "5".repeat(64) },
      { unexpected: true },
    ]) {
      expect(CanonicalChainObservationSchema.safeParse({ ...RAW, ...mutation }).success)
        .toBe(false);
    }
  });

  it("detects divergence in any covered dimension", () => {
    const base = buildCanonicalChainObservation(RAW);
    for (const mutation of [
      { finalStateCommitment: `0x${"0".repeat(64)}` },
      { traceProjectionDigest: `sha256:${"0".repeat(64)}` },
      { blocks: [{ ...RAW.blocks[0], timestamp: "1900000001" }] },
      { probes: [{ ...RAW.probes[0], gasUsed: "51235" }, RAW.probes[1]] },
    ]) {
      const other = buildCanonicalChainObservation({ ...RAW, ...mutation });
      expect(chainObservationsEqual(base, other)).toBe(false);
    }
  });
});
