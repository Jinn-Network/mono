// Cross-tree equivalence leg (program §7.1/§7.14): `records`' own raw-JCS serializer must be
// byte-identical to `task-execution-protocol`'s for any shared logical input — both trees share
// the stack-wide "raw RFC 8785 JCS under I-JSON" sealing rule (program §7.15), and this fixture
// proves it rather than assuming it.
import { describe, expect, test } from "vitest";
import { serializeCanonicalJson as protocolSerializeCanonicalJson } from "@jinn-network/task-execution-protocol";
import { serializeCanonicalJson as recordsSerializeCanonicalJson } from "./canonical.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("cross-tree canonical-byte equivalence (records vs task-execution-protocol)", () => {
  test("byte-identical for a simple shared logical object", () => {
    const value = { name: "swe-bench-lite", version: "1.0.0", items: [1, 2, 3] };
    expect(decode(recordsSerializeCanonicalJson(value))).toBe(decode(protocolSerializeCanonicalJson(value)));
  });

  test("byte-identical regardless of source key order (object-key-order-sensitive record)", () => {
    const orderedA = { protocol: "p", name: "n", version: "1.0.0", items: [{ task: { digest: { sha256: "ab" } } }] };
    const orderedB = { items: [{ task: { digest: { sha256: "ab" } } }] as unknown, version: "1.0.0", protocol: "p", name: "n" };
    const recordsBytesA = decode(recordsSerializeCanonicalJson(orderedA as never));
    const recordsBytesB = decode(recordsSerializeCanonicalJson(orderedB as never));
    const protocolBytesA = decode(protocolSerializeCanonicalJson(orderedA as never));
    const protocolBytesB = decode(protocolSerializeCanonicalJson(orderedB as never));
    expect(recordsBytesA).toBe(recordsBytesB);
    expect(protocolBytesA).toBe(protocolBytesB);
    expect(recordsBytesA).toBe(protocolBytesA);
  });

  test("byte-identical for the integer-like-key case (code-unit order, not numeric)", () => {
    const value = { "10": 1, "2": 2 };
    expect(decode(recordsSerializeCanonicalJson(value))).toBe(decode(protocolSerializeCanonicalJson(value)));
  });
});
