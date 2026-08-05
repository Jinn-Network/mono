import { describe, expect, test } from "vitest";

import {
  Address,
  Bytes32,
  Caip2ChainId,
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  PrefixedSha256,
  Quantity,
  RecordKindUri,
  ResourceDescriptorSchema,
} from "./primitives.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("record-body primitives", () => {
  test("a record-body digest carries the sha256: prefix and nothing else", () => {
    expect(ok(PrefixedSha256, `sha256:${"a".repeat(64)}`)).toBe(true);
    expect(ok(PrefixedSha256, "a".repeat(64))).toBe(false);
    expect(ok(PrefixedSha256, `sha256:${"A".repeat(64)}`)).toBe(false);
  });

  test("32-byte words are 0x + 64 lowercase hex; mixed case is a second spelling of one value", () => {
    expect(ok(Bytes32, `0x${"b".repeat(64)}`)).toBe(true);
    expect(ok(Bytes32, `0x${"B".repeat(64)}`)).toBe(false);
    expect(ok(Bytes32, "b".repeat(64))).toBe(false);
  });

  test("addresses are lowercase; an EIP-55 checksummed spelling is refused", () => {
    expect(ok(Address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
    expect(ok(Address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(false);
    expect(ok(Address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226")).toBe(false);
  });

  test("wei- and gas-denominated quantities are unsigned decimal STRINGS, not numbers", () => {
    expect(ok(Quantity, "1000000000000000000")).toBe(true);
    expect(ok(Quantity, "0")).toBe(true);
    expect(ok(Quantity, "01")).toBe(false);
    expect(ok(Quantity, "-1")).toBe(false);
    expect(ok(Quantity, 1_000_000)).toBe(false);
  });

  test("CAIP-2 chain ids parse; a bare decimal chain id does not", () => {
    expect(ok(Caip2ChainId, "eip155:1")).toBe(true);
    expect(ok(Caip2ChainId, "eip155:8453")).toBe(true);
    expect(ok(Caip2ChainId, "1")).toBe(false);
  });

  test("counts are non-negative safe integers", () => {
    expect(ok(Count, 0)).toBe(true);
    expect(ok(Count, 12)).toBe(true);
    expect(ok(Count, -1)).toBe(false);
    expect(ok(Count, 1.5)).toBe(false);
  });

  test("a runtime version is exact; ranges and `latest` are refused", () => {
    expect(ok(ExactSemanticVersion, "1.3.7")).toBe(true);
    expect(ok(ExactSemanticVersion, "1.3.7-nightly.20260701")).toBe(true);
    expect(ok(ExactSemanticVersion, "latest")).toBe(false);
    expect(ok(ExactSemanticVersion, "^1.3.7")).toBe(false);
    expect(ok(ExactSemanticVersion, "1.3")).toBe(false);
  });

  test("an origin is scheme + lowercase host + optional port, with no path", () => {
    expect(ok(HttpOrigin, "https://api.llama.fi")).toBe(true);
    expect(ok(HttpOrigin, "http://localhost:8080")).toBe(true);
    expect(ok(HttpOrigin, "https://API.Llama.fi")).toBe(false);
    expect(ok(HttpOrigin, "https://api.llama.fi/")).toBe(false);
    expect(ok(HttpOrigin, "https://api.llama.fi/v2/pools")).toBe(false);
  });
});

describe("ResourceDescriptor", () => {
  test("in-toto DigestSet values are BARE hex — the prefixed spelling is refused", () => {
    expect(ok(ResourceDescriptorSchema, { uri: "x", digest: { sha256: "a".repeat(64) } })).toBe(true);
    expect(ok(ResourceDescriptorSchema, { uri: "x", digest: { sha256: `sha256:${"a".repeat(64)}` } })).toBe(false);
  });

  test("a descriptor needs at least one of uri/digest", () => {
    expect(ok(ResourceDescriptorSchema, { name: "state" })).toBe(false);
  });

  test("unknown members round-trip: in-toto declares the descriptor extensible", () => {
    expect(ok(ResourceDescriptorSchema, { uri: "x", content: "ignored-by-us" })).toBe(true);
  });

  test("a digest-pinned reference requires digest.sha256 — a uri alone is a locator", () => {
    expect(ok(DigestPinnedDescriptorSchema, { uri: "https://example.test/state.tar" })).toBe(false);
    expect(ok(DigestPinnedDescriptorSchema, { digest: { sha256: "c".repeat(64) } })).toBe(true);
  });
});

describe("RecordKindUri (DR-2026-08-04)", () => {
  test("accepts the canonical spec.jinn.network origin with a major-only version", () => {
    expect(ok(RecordKindUri, "https://spec.jinn.network/records/chain-environment/v1")).toBe(true);
    expect(ok(RecordKindUri, "https://spec.jinn.network/records/chain-environment/v2")).toBe(true);
  });

  // The regression test for the C2 narrowing: both spellings below parsed as valid record
  // kinds while the schema dual-accepted, and must not any more.
  test("refuses the retired origin and the retired major.minor version", () => {
    expect(ok(RecordKindUri, "https://jinn.network/records/chain-environment/1.0")).toBe(false);
    expect(ok(RecordKindUri, "https://spec.jinn.network/records/chain-environment/1.0")).toBe(false);
  });

  test("refuses a lookalike origin, v0, and a nested version segment", () => {
    for (const bad of [
      "https://evil.jinn.network/records/chain-environment/v1",
      "https://jinn.network.evil.example/records/chain-environment/v1",
      "https://spec.jinn.network/records/chain-environment/v0",
      "https://spec.jinn.network/records/chain-environment/1",
      "https://spec.jinn.network/records/chain-environment/v1/facts/v1",
      "https://spec.jinn.network/records/Chain-Environment/v1",
    ]) {
      expect(ok(RecordKindUri, bad)).toBe(false);
    }
  });
});
