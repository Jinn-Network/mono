// SPDX-License-Identifier: Apache-2.0

import { ScenarioError } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";
import type { Sha256Digest } from "./digest.js";

/**
 * Addresses that are permanently ineligible as scenario fixture accounts (design §8).
 *
 * The first ten are the accounts every EVM development toolchain derives from the
 * `test test test test test test test test test test test junk` mnemonic; they are the
 * most-funded "worthless" addresses in existence, and dust reaches them constantly. The
 * zero and burn addresses close the other end. A scenario account that landed on one of
 * these would make every published solution script for that scenario a replayable
 * transaction from an address people actually send value to.
 *
 * Lowercase, sorted by code unit, deduplicated — asserted by the test, so the list cannot
 * silently shrink or acquire a duplicate that hides a removal.
 */
export const WELL_KNOWN_DEV_ADDRESSES: readonly string[] = [
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
].sort(compareCodeUnitStrings);

const BANNED = new Set(WELL_KNOWN_DEV_ADDRESSES);
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/** Case-folding only. This function never derives, checksums, or truncates an address. */
export function normalizeAddress(address: string): string {
  if (!address.startsWith("0x")) {
    throw new ScenarioError("invalid-input", `address ${address} must start with 0x.`);
  }
  const lowered = `0x${address.slice(2).toLowerCase()}`;
  if (!ADDRESS_PATTERN.test(lowered)) {
    throw new ScenarioError("invalid-input", `address ${address} is not a 20-byte hex address.`);
  }
  return lowered;
}

/**
 * Program contract 8's first half: a scenario fixture address may not be an address the
 * world already knows and funds.
 */
export function assertFreshFixtureAddress(address: string, role: string): string {
  const normalized = normalizeAddress(address);
  if (BANNED.has(normalized)) {
    throw new ScenarioError(
      "unsafe-fixture-address",
      `role "${role}" was given ${normalized}, a well-known development address. Fixture keys `
        + "are freshly generated per record (design §8): a published solution script signed by a "
        + "funded address is a replayable mainnet transaction from it.",
    );
  }
  return normalized;
}

export interface FixtureAddressLedger {
  /** Claims `address` for `role` under `environmentRecordDigest`, or throws. */
  claim(environmentRecordDigest: Sha256Digest | string, address: string, role: string): string;
  /** Every address claimed so far, code-unit ordered. Diagnostics only. */
  claimed(): readonly string[];
}

/**
 * Program contract 8's second half: never reused across records. In-memory and per-run —
 * this is a within-run structural invariant, not a global registry, and the doc says so
 * rather than implying a durability this holds none of.
 */
export function createFixtureAddressLedger(): FixtureAddressLedger {
  const owners = new Map<string, string>();
  return {
    claim(environmentRecordDigest, address, role) {
      const normalized = assertFreshFixtureAddress(address, role);
      const owner = owners.get(normalized);
      if (owner !== undefined) {
        throw new ScenarioError(
          "unsafe-fixture-address",
          `address ${normalized} for role "${role}" is already claimed for another environment `
            + `record (${owner}). Fixture keys are freshly generated per record (design §8).`,
        );
      }
      owners.set(normalized, `${String(environmentRecordDigest)}#${role}`);
      return normalized;
    },
    claimed() {
      return [...owners.keys()].sort(compareCodeUnitStrings);
    },
  };
}

export interface ScenarioAccountRequest {
  readonly environmentRecordDigest: Sha256Digest;
  readonly templateId: string;
  readonly role: string;
}

/**
 * What a minted scenario account looks like to this package: an address and a role.
 *
 * There is deliberately no private-key field, and no port shape that could carry one. The
 * signer lives inside the host's sandbox instance and nothing crosses this boundary
 * (program contract 4). If a future port wants to hand CE5 a key, that is a custody-law
 * change and a design question, not an interface tweak.
 */
export interface ScenarioAccount {
  readonly role: string;
  readonly address: string;
}

export type ScenarioAccountPort = (request: ScenarioAccountRequest) => Promise<ScenarioAccount>;
