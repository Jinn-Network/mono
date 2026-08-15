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

function expectInvalidPath(action: () => void, expectedPath: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidDocumentError);
    expect((error as InvalidDocumentError).errors.some(({ path }) => path === expectedPath)).toBe(true);
    return;
  }
  throw new Error(`expected InvalidDocumentError at ${expectedPath}`);
}

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

  test("round-trips a valid namespaced I-JSON extension graph exactly", () => {
    const extension = {
      nullValue: null,
      boolean: true,
      integer: 7,
      text: "fixture",
      list: ["one", { two: 2 }],
    };
    const parsed = parseInformationWorldRecord(sealInformationWorldRecord(world({
      "network.jinn.extension": extension,
    }))) as Record<string, unknown>;
    expect(parsed["network.jinn.extension"]).toEqual(extension);
  });

  test.each<readonly [string, () => unknown, string]>([
    ["an undefined primitive", () => ({ value: undefined }), "network.jinn.extension.value"],
    ["a bigint primitive", () => ({ value: 1n }), "network.jinn.extension.value"],
    ["a symbol primitive", () => ({ value: Symbol("value") }), "network.jinn.extension.value"],
    ["a function primitive", () => ({ value: () => true }), "network.jinn.extension.value"],
    ["a fractional number", () => ({ value: 1.5 }), "network.jinn.extension.value"],
    ["negative zero", () => ({ value: -0 }), "network.jinn.extension.value"],
    ["an unpaired surrogate", () => ({ value: "\ud800" }), "network.jinn.extension.value"],
    ["a sparse array", () => new Array<unknown>(1), "network.jinn.extension.0"],
    ["an array with an unexpected property", () => {
      const value = [true] as unknown as Record<string, unknown>;
      value.extra = true;
      return value;
    }, "network.jinn.extension.extra"],
    ["an array with a symbol property", () => {
      const value = [true] as unknown as Record<symbol, unknown>;
      value[Symbol("hidden")] = true;
      return value;
    }, "network.jinn.extension.[Symbol(hidden)]"],
    ["an array with a non-enumerable property", () => {
      const value = [true];
      Object.defineProperty(value, "hidden", { value: true });
      return value;
    }, "network.jinn.extension.hidden"],
    ["an array with a custom prototype", () => {
      const value = [true];
      Object.setPrototypeOf(value, { inherited: true });
      return value;
    }, "network.jinn.extension"],
    ["an object with a symbol property", () => {
      const value: Record<symbol, unknown> = {};
      value[Symbol("hidden")] = true;
      return value;
    }, "network.jinn.extension.[Symbol(hidden)]"],
    ["an object with a non-enumerable property", () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "hidden", { value: true });
      return value;
    }, "network.jinn.extension.hidden"],
    ["an object with an accessor", () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "computed", { enumerable: true, get: () => true });
      return value;
    }, "network.jinn.extension.computed"],
    ["an object with a custom prototype", () => Object.create({ inherited: true }),
      "network.jinn.extension"],
    ["a nested __proto__ member", () => JSON.parse('{"nested":{"__proto__":{"x":1}}}'),
      "network.jinn.extension.nested.__proto__"],
  ])("refuses extension graphs containing %s before Zod or canonicalization", (_label, makeValue, path) => {
    expectInvalidPath(() => {
      sealInformationWorldRecord(world({ "network.jinn.extension": makeValue() }));
    }, path);
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
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      missPolicy: { ...record.missPolicy, status: 302 },
    }), "missPolicy.status");
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
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      missPolicy: {
        ...record.missPolicy,
        body: { inlineUtf8: "é".repeat(2049), mediaType: "text/plain" },
      },
    }), "missPolicy.body.inlineUtf8");
  });
});

describe("corpus integrity", () => {
  test("rejects a declared request key that does not match fully canonical stored parts", () => {
    const record = world();
    const entries = [...record.corpus.entries];
    entries[0] = { ...entries[0]!, requestKey: `irk1:${"0".repeat(64)}` };
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: sortEntries(entries) },
    }), "corpus.entries.0.requestKey");
  });

  test("rejects malformed stored request parts before deriving their declared key", () => {
    const record = world();
    const malformed = entry("/pools", "c");
    malformed.request = {
      ...malformed.request,
      path: "/%7Epool",
    };
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      corpus: { ...record.corpus, entries: [malformed] },
    }), "corpus.entries.0.request");
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
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      corpus: {
        ...record.corpus,
        origins: ["https://api.example.test", "https://api.example.test"],
      },
    }), "corpus.origins.1");
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
    expectInvalidPath(() => sealInformationWorldRecord({
      ...record,
      requestKeyPolicy: { ...policy, headerSubset: ["authorization"] },
    }), "requestKeyPolicy");
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
    expectInvalidPath(() => sealInformationWorldRecord(world({ capture: withoutCapturer })), "capture");
  });

  test("forbids capture provenance on synthetic worlds and fixes the declaration class", () => {
    expectInvalidPath(() => sealInformationWorldRecord(world({
      capture: { ...capturedCapture, fidelity: "synthetic" },
    })), "capture");
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
