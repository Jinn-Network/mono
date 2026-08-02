import { describe, expect, test } from "vitest";

import { INFORMATION_WORLD_KIND } from "./identifiers.js";
import { canonicalRequestKeyFromParts } from "./request-key.js";
import type { CanonicalRequestParts } from "./request-key.js";
import type { RequestKeyPolicy } from "./request-key-policy.js";
import { InvalidDocumentError } from "./sealing.js";
import {
  InformationWorldRecordSchema,
  MISS_BODY_MAX_BYTES,
  parseInformationWorldRecord,
  sealInformationWorldRecord,
} from "./schema.js";

const policy: RequestKeyPolicy = {
  version: "irk1",
  headerSubset: ["accept"],
  pathTrailingSlash: "preserve",
  plusInQuery: "literal",
  bodyCanonicalization: "opaque-bytes",
};

const parts = (path: string): CanonicalRequestParts => ({
  method: "GET",
  origin: "https://api.example.test",
  path,
  query: [],
  headers: { accept: ["application/json"] },
  body: null,
});

const entry = (path: string, fill: string) => ({
  requestKey: canonicalRequestKeyFromParts(parts(path), policy),
  request: parts(path),
  response: {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: {
      digest: `sha256:${fill.repeat(64)}`,
      mediaType: "application/json",
      sizeBytes: 17,
    },
  },
});

const sortEntries = <T extends { requestKey: string }>(entries: readonly T[]): T[] => (
  [...entries].sort((left, right) => (
    left.requestKey < right.requestKey ? -1 : left.requestKey > right.requestKey ? 1 : 0
  ))
);

const world = (overrides: Record<string, unknown> = {}) => ({
  kind: INFORMATION_WORLD_KIND,
  requestKeyPolicy: policy,
  corpus: {
    origins: ["https://api.example.test"],
    entries: sortEntries([entry("/pools", "a"), entry("/protocols", "b")]),
  },
  missPolicy: {
    status: 404,
    headers: [["content-type", "application/json"]],
    body: { inlineUtf8: '{"error":"not in corpus"}', mediaType: "application/json" },
    reason: "uncaptured-request",
  },
  capture: { fidelity: "synthetic", provenanceClass: "declared" },
  ...overrides,
});

describe("InformationWorldRecordSchema", () => {
  test("accepts a well-formed synthetic world", () => {
    expect(InformationWorldRecordSchema.safeParse(world()).success).toBe(true);
  });

  test("requires the pinned kind", () => {
    expect(InformationWorldRecordSchema.safeParse(world({ kind: "https://x.test/other" })).success)
      .toBe(false);
  });

  test("admits namespaced extension keys and refuses bare ones", () => {
    expect(InformationWorldRecordSchema.safeParse(world({ "network.jinn.note": "x" })).success)
      .toBe(true);
    expect(InformationWorldRecordSchema.safeParse(world({ note: "x" })).success).toBe(false);
  });

  test("carries no mutable status field", () => {
    for (const key of ["status", "health", "verified", "expiresAt", "lastCheckedAt"]) {
      expect(InformationWorldRecordSchema.safeParse(world({ [key]: 1 })).success, key).toBe(false);
    }
  });
});

describe("the miss policy is required and fail-closed", () => {
  test("a record without a miss policy does not seal", () => {
    const { missPolicy, ...withoutMiss } = world();
    void missPolicy;
    expect(() => sealInformationWorldRecord(withoutMiss)).toThrow(InvalidDocumentError);
  });

  test("a 3xx miss status is refused (finding CF6-7)", () => {
    const record = world();
    expect(() => sealInformationWorldRecord({
      ...record,
      missPolicy: { ...record.missPolicy, status: 302 },
    })).toThrow(InvalidDocumentError);
  });

  test("the inline miss body accepts exactly 4096 UTF-8 bytes and rejects the next character", () => {
    expect(MISS_BODY_MAX_BYTES).toBe(4096);
    const record = world();
    expect(() => sealInformationWorldRecord({
      ...record,
      missPolicy: {
        ...record.missPolicy,
        body: { inlineUtf8: "é".repeat(2048), mediaType: "text/plain" },
      },
    })).not.toThrow();
    expect(() => sealInformationWorldRecord({
      ...record,
      missPolicy: {
        ...record.missPolicy,
        body: { inlineUtf8: "é".repeat(2049), mediaType: "text/plain" },
      },
    })).toThrow(InvalidDocumentError);
  });
});

describe("corpus integrity", () => {
  test("rejects a declared request key that does not match fully canonical stored parts", () => {
    const record = world();
    const entries = [...record.corpus.entries];
    entries[0] = { ...entries[0]!, requestKey: `irk1:${"0".repeat(64)}` };
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: sortEntries(entries) },
    })).toThrow(InvalidDocumentError);
  });

  test("rejects malformed stored request parts before deriving their declared key", () => {
    const record = world();
    const malformed = entry("/pools", "c");
    malformed.request = {
      ...malformed.request,
      path: "/%7Epool",
    };
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: [malformed] },
    })).toThrow(InvalidDocumentError);
  });

  test("rejects two entries colliding on a request key at seal time", () => {
    const record = world();
    const duplicate = entry("/pools", "c");
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: sortEntries([...record.corpus.entries, duplicate]) },
    })).toThrow(InvalidDocumentError);
  });

  test("rejects entries out of ascending request-key order", () => {
    const record = world();
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: [...record.corpus.entries].reverse() },
    })).toThrow(InvalidDocumentError);
  });

  test("rejects undeclared origins, unsorted origins, and headers outside the policy", () => {
    const record = world();
    const foreign = entry("/pools", "d");
    foreign.request = { ...foreign.request, origin: "https://other.example.test" };
    foreign.requestKey = canonicalRequestKeyFromParts(foreign.request, policy);
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: [foreign] },
    })).toThrow(InvalidDocumentError);
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: {
        ...record.corpus,
        origins: ["https://api.example.test", "https://api.example.test"],
      },
    })).toThrow(InvalidDocumentError);
    const wide = entry("/pools", "e");
    wide.request = {
      ...wide.request,
      headers: { accept: ["application/json"], "x-chain": ["base"] },
    };
    expect(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: [wide] },
    })).toThrow(InvalidDocumentError);
  });

  test("validates the sealed request-key policy, including CF6-1 credentials", () => {
    const record = world();
    expect(() => sealInformationWorldRecord({
      ...record,
      requestKeyPolicy: { ...policy, headerSubset: ["authorization"] },
    })).toThrow(InvalidDocumentError);
  });
});

describe("fidelity is a declaration with one exclusive provenance branch (finding CF6-8)", () => {
  const capturedCapture = {
    fidelity: "captured-snapshot",
    provenanceClass: "declared",
    capturedAt: "2026-07-30T11:04:00Z",
    capturer: {
      digest: `sha256:${"9".repeat(64)}`,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    },
    sources: [{ origin: "https://api.example.test", capturedAt: "2026-07-30T11:04:00Z" }],
  };

  test("requires a full digest-pinned declaration for captured snapshots", () => {
    expect(InformationWorldRecordSchema.safeParse(world({ capture: capturedCapture })).success)
      .toBe(true);
    const { capturer, ...withoutCapturer } = capturedCapture;
    void capturer;
    expect(() => sealInformationWorldRecord(world({ capture: withoutCapturer })))
      .toThrow(InvalidDocumentError);
  });

  test("forbids capture provenance on synthetic worlds and fixes the declaration class", () => {
    expect(() => sealInformationWorldRecord(world({
      capture: { ...capturedCapture, fidelity: "synthetic" },
    }))).toThrow(InvalidDocumentError);
    expect(InformationWorldRecordSchema.safeParse(world({
      capture: { ...capturedCapture, provenanceClass: "proven" },
    })).success).toBe(false);
  });
});

describe("sealing", () => {
  test("canonicalizes key order and requires exact bytes when parsing", () => {
    const record = world();
    const permuted = {
      capture: record.capture,
      missPolicy: record.missPolicy,
      corpus: record.corpus,
      requestKeyPolicy: record.requestKeyPolicy,
      kind: record.kind,
    };
    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    expect(decode(sealInformationWorldRecord(record)))
      .toBe(decode(sealInformationWorldRecord(permuted)));
    const pretty = new TextEncoder().encode(JSON.stringify(record, null, 2));
    expect(() => parseInformationWorldRecord(pretty)).toThrow(InvalidDocumentError);
  });

  test("seals identically after an exact parse", () => {
    const once = sealInformationWorldRecord(world());
    const twice = sealInformationWorldRecord(parseInformationWorldRecord(once));
    expect(new TextDecoder().decode(twice)).toBe(new TextDecoder().decode(once));
  });
});
