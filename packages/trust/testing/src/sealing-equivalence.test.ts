// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as evidenceProtocol from "@jinn-network/evidence-protocol";
import * as discoveryProtocol from "@jinn-network/record-discovery-protocol";
import * as taskExecutionProfiles from "@jinn-network/task-execution-profiles";
import * as taskExecutionProtocol from "@jinn-network/task-execution-protocol";
import type { JsonValue } from "@jinn-network/task-execution-protocol";
import * as trustCore from "@jinn-network/trust-core";

import { assertCanonicalByteEquivalence, assertSealingEquivalence } from "./sealing-equivalence.js";
import type { CanonicalByteEquivalenceCase, SealingEquivalenceCase } from "./sealing-equivalence.js";

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/equivalence-v1/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

// task-execution-protocol's canonical serializer is typed over its own
// `JsonValue` union rather than `unknown`; fixture values are always
// JSON.parse output (structurally JsonValue-compatible), so this narrow
// cast at the test boundary is safe.
function tepCanonicalJsonBytes(value: unknown): Uint8Array {
  return taskExecutionProtocol.serializeCanonicalJson(value as JsonValue);
}

const rawJcsImplementations = [
  { name: "trust", canonicalJsonBytes: trustCore.canonicalJsonBytes },
  { name: "task-execution protocol", canonicalJsonBytes: tepCanonicalJsonBytes },
  { name: "task-execution profiles", canonicalJsonBytes: taskExecutionProfiles.canonicalJsonBytes },
  {
    name: "record discovery",
    canonicalJsonBytes: (value: unknown) => discoveryProtocol.sealJson(value).bytes,
  },
] as const;

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

describe("canonical-byte equivalence vs task-execution-protocol (Task T17; program ruling §7.1/§7.15)", () => {
  test("trust-core's canonicalJsonBytes and task-execution-protocol's serializeCanonicalJson produce byte-identical output over the shared fixture set", () => {
    const extraCases = loadFixture("task-execution-canonical-cases.json") as ReadonlyArray<{
      readonly name: string;
      readonly value: unknown;
    }>;
    // The key-order-sensitive record (nested unsorted keys AND integer-like
    // keys "10"/"2") is carried forward from the T10 fixture set for this
    // leg, per the plan's explicit direction -- it is the object-key-order-
    // sensitive AND integer-like-key record this leg requires.
    const keyOrderSensitiveInput = loadFixture("key-order-sensitive.json");
    const cases: CanonicalByteEquivalenceCase[] = [
      ...extraCases,
      { name: "key-order-sensitive", value: keyOrderSensitiveInput },
    ];

    // §7.1 (program ruling): both trust-core and task-execution-protocol
    // emit raw RFC 8785 JCS -- no indent, no trailing newline. This is the
    // genuine cross-impl canonical-byte equivalence leg the T10 evidence
    // leg could not assert (evidence-protocol exports no canonical
    // serializer, §7.15). This fixture VERIFIES the fixed convention; it
    // does not negotiate one. Any divergence is a bug against §7.1 in one
    // implementation -- surface it, never retune either serializer to make
    // this pass.
    assertCanonicalByteEquivalence(
      { canonicalJsonBytes: trustCore.canonicalJsonBytes },
      { canonicalJsonBytes: tepCanonicalJsonBytes },
      cases,
    );
  });

  test("trust-core's recordDigest and task-execution-protocol's documentDigest agree on the same already-serialized bytes (digest algorithm identity)", () => {
    const raw = loadFixture("shared-payload-bytes.json") as ReadonlyArray<{
      readonly name: string;
      readonly payloadUtf8: string;
    }>;
    for (const entry of raw) {
      const bytes = new TextEncoder().encode(entry.payloadUtf8);
      expect(taskExecutionProtocol.documentDigest(bytes)).toBe(trustCore.recordDigest(bytes));
    }
  });

  // Ground-truth finding (mirrors §7.15's evidence-protocol finding, this
  // time in the other direction): task-execution-protocol implements no
  // DSSE envelope handling at all -- it exports sealing (canonical bytes +
  // digest) but never a pre-authentication-encoding primitive. A signed TEP
  // document is DSSE-wrapped by a *consumer* (e.g. trust-core's own
  // dssePreAuthEncoding, already proven byte-identical to evidence-
  // protocol's in the T10 leg above), not by task-execution-protocol
  // itself. The plan text's "plus PAE + recordDigest agreement" for T17
  // therefore only has a recordDigest half against this package; the PAE
  // half is asserted (and was already asserted) against evidence-protocol
  // in T10. This is a surfaced finding, not a silently patched fixture.
  test("task-execution-protocol exports no DSSE pre-authentication-encoding primitive (documents why the T17 PAE leg is not assertable here)", () => {
    expect((taskExecutionProtocol as Record<string, unknown>)["dssePreAuthEncoding"]).toBeUndefined();
  });

  test("the cross-impl canonical-byte oracle digest for the key-order-sensitive record is pinned", () => {
    const keyOrderSensitiveInput = loadFixture("key-order-sensitive.json");
    const trustCoreBytes = trustCore.canonicalJsonBytes(keyOrderSensitiveInput);
    const tepBytes = tepCanonicalJsonBytes(keyOrderSensitiveInput);
    const trustCoreDigest = trustCore.recordDigest(trustCoreBytes);
    const tepDigest = taskExecutionProtocol.documentDigest(tepBytes);

    // Since the bytes are asserted byte-identical above, both digests must
    // already agree -- restated here as its own assertion for a sharper
    // failure signal if only the digest (not the canonical bytes) drifts.
    expect(tepDigest).toBe(trustCoreDigest);

    const expectedDigests = loadFixture("task-execution-oracle-digests.json") as Record<string, string>;
    const expected = expectedDigests["key-order-sensitive"];
    if (expected === undefined) {
      throw new Error(
        `No pinned oracle digest for "key-order-sensitive" yet -- actual digest: ${trustCoreDigest}\n`
          + "Paste this into fixtures/equivalence-v1/task-execution-oracle-digests.json and re-run.",
      );
    }
    expect(trustCoreDigest).toBe(expected);
  });
});

describe("stack-wide raw-JCS conformance (program rulings §7.1/§7.14/§7.24)", () => {
  test("all public canonical-byte APIs emit identical bytes for valid fixtures", () => {
    const cases: CanonicalByteEquivalenceCase[] = [
      {
        name: "nested-key-order-and-integer-like-keys",
        value: { zeta: { "2": 2, "10": 1 }, alpha: [true, null, 0] },
      },
      {
        name: "valid-supplementary-plane-unicode",
        value: { ["😀"]: "supplementary 😀", text: "𠜎" },
      },
    ];

    for (const implementation of rawJcsImplementations.slice(1)) {
      assertCanonicalByteEquivalence(
        rawJcsImplementations[0],
        implementation,
        cases,
      );
    }

    expect(
      new TextDecoder().decode(
        rawJcsImplementations[0].canonicalJsonBytes(cases[0]!.value),
      ),
    ).toBe('{"alpha":[true,null,0],"zeta":{"10":1,"2":2}}');
    expect(
      new TextDecoder().decode(
        rawJcsImplementations[0].canonicalJsonBytes(cases[1]!.value),
      ),
    ).toBe('{"text":"𠜎","😀":"supplementary 😀"}');
  });

  test("all public canonical-byte APIs reject the same hostile fixtures", () => {
    const symbolKeyed = { [Symbol("unsupported-key")]: "value" };
    const inherited = Object.assign(Object.create({ inherited: true }), { own: true });
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    const nonEnumerable = Object.defineProperty({}, "value", {
      enumerable: false,
      value: 1,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const hostileCases: ReadonlyArray<CanonicalByteEquivalenceCase> = [
      { name: "sparse-array", value: Array(2) },
      { name: "nested-sparse-array", value: { nested: [Array(1)] } },
      { name: "unsafe-integer", value: { value: Number.MAX_SAFE_INTEGER + 1 } },
      { name: "undefined-root", value: undefined },
      { name: "undefined-object-member", value: { value: undefined } },
      { name: "undefined-array-element", value: [undefined] },
      { name: "unpaired-high-surrogate-value", value: { value: "\ud800" } },
      { name: "unpaired-low-surrogate-value", value: { value: "\udc00" } },
      { name: "unpaired-high-surrogate-key", value: { ["\ud800"]: "value" } },
      { name: "unpaired-low-surrogate-key", value: { ["\udc00"]: "value" } },
      { name: "function-root", value: () => undefined },
      { name: "function-member", value: { value: () => undefined } },
      { name: "symbol-root", value: Symbol("unsupported") },
      { name: "symbol-member", value: { value: Symbol("unsupported") } },
      { name: "symbol-key", value: symbolKeyed },
      { name: "bigint-root", value: 1n },
      { name: "inherited-object-prototype", value: inherited },
      { name: "accessor-property", value: accessor },
      { name: "non-enumerable-property", value: nonEnumerable },
      { name: "cyclic-value", value: cyclic },
    ];

    for (const hostileCase of hostileCases) {
      for (const implementation of rawJcsImplementations) {
        expect(
          () => implementation.canonicalJsonBytes(hostileCase.value),
          `${implementation.name} accepted ${hostileCase.name}`,
        ).toThrow();
      }
    }
  });
});
