// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as evidenceProtocol from "@jinn-network/evidence-protocol";
import * as trustCore from "@jinn-network/trust-core";

import { assertSealingEquivalence } from "./sealing-equivalence.js";
import type { SealingEquivalenceCase } from "./sealing-equivalence.js";

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/equivalence-v1/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("sealing algorithm-equivalence vs evidence-protocol (§16, program ruling §7.15)", () => {
  test("trust-core and evidence-protocol agree on DSSE PAE and recordDigest for the same already-serialized bytes", () => {
    const raw = loadFixture("shared-payload-bytes.json") as ReadonlyArray<{
      readonly name: string;
      readonly payloadType: string;
      readonly payloadUtf8: string;
    }>;
    const cases: SealingEquivalenceCase[] = raw.map((entry) => ({
      name: entry.name,
      payloadType: entry.payloadType,
      payloadBytes: new TextEncoder().encode(entry.payloadUtf8),
    }));

    // Only algorithm identity is asserted here (program ruling §7.15):
    // evidence-protocol exports no canonical-JSON serializer, so this leg
    // cannot assert canonical-byte equivalence -- see the dedicated test
    // below and Task T17's genuine canonical-byte leg against
    // task-execution-protocol.
    assertSealingEquivalence(
      { dssePreAuthEncoding: trustCore.dssePreAuthEncoding, recordDigest: trustCore.recordDigest },
      { dssePreAuthEncoding: evidenceProtocol.dssePreAuthEncoding, recordDigest: evidenceProtocol.recordDigest },
      cases,
    );
  });

  test("evidence-protocol exports no canonical-JSON serializer (documents why the evidence leg is algorithm-identity-only, §7.15)", () => {
    expect((evidenceProtocol as Record<string, unknown>)["canonicalJsonBytes"]).toBeUndefined();
  });

  test("trust-core's own canonicalization of a key-order-sensitive record matches its pinned self-consistency digest", () => {
    const keyOrderSensitiveInput = loadFixture("key-order-sensitive.json");
    const digest = trustCore.recordDigest(trustCore.canonicalJsonBytes(keyOrderSensitiveInput));

    const expectedDigests = loadFixture("trust-core-digests.json") as Record<string, string>;
    const expected = expectedDigests["key-order-sensitive"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "key-order-sensitive" yet -- actual digest: ${digest}\n`
          + "Paste this into fixtures/equivalence-v1/trust-core-digests.json and re-run.",
      );
    }
    expect(digest).toBe(expected);
  });

  test("the key-order-sensitive fixture's canonical bytes sort integer-like keys by code unit, not numerically (§7.14)", () => {
    const keyOrderSensitiveInput = loadFixture("key-order-sensitive.json");
    const bytes = trustCore.canonicalJsonBytes(keyOrderSensitiveInput);
    const text = new TextDecoder().decode(bytes);
    // '"10"' sorts after '"2"' by UTF-16 code unit ('1' < '2'), the
    // opposite of numeric order -- proving explicit sorted-key iteration.
    expect(text.indexOf('"10"')).toBeLessThan(text.indexOf('"2"'));
  });
});
