// Cross-package seal-equivalence leg (program §4 contract 3). This package re-implements
// sealing locally and never imports shared runtime sealing code; equivalence is proven here,
// in a test file, against two independent oracles:
//   1. `@jinn-network/evidence-protocol`'s `recordDigest` — the evidence tree's own digest
//      spelling over identical bytes;
//   2. `canonicalize` — an independent RFC 8785 JCS implementation.
// The source-boundary guard forbids either import from production source.
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { recordDigest as evidenceRecordDigest } from "@jinn-network/evidence-protocol";

import { serializeCanonicalJson } from "./canonical.js";
import { informationWorldRecordDigest } from "./hashing.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const shared = {
  kind: "https://spec.jinn.network/records/information-world/v1",
  requestKeyPolicy: {
    version: "irk1",
    headerSubset: ["accept", "content-type"],
    pathTrailingSlash: "preserve",
    plusInQuery: "literal",
    bodyCanonicalization: "opaque-bytes",
  },
  corpus: {
    origins: ["https://api.example.test"],
    entries: [
      {
        requestKey: `irk1:${"a".repeat(64)}`,
        request: {
          method: "GET",
          origin: "https://api.example.test",
          path: "/pools",
          query: [["chain", "base"]],
          headers: { accept: ["application/json"] },
          body: null,
        },
        response: {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: { digest: `sha256:${"b".repeat(64)}`, sizeBytes: 42 },
        },
      },
    ],
  },
  missPolicy: {
    status: 404,
    headers: [["content-type", "application/json"]],
    body: { inlineUtf8: '{"error":"not in corpus"}', mediaType: "application/json" },
    reason: "uncaptured-request",
  },
  capture: { fidelity: "synthetic", provenanceClass: "declared" },
};

describe("cross-package seal equivalence", () => {
  test("our JCS bytes equal the RFC 8785 reference implementation's, whatever the key order", () => {
    const permuted = {
      capture: shared.capture,
      missPolicy: shared.missPolicy,
      corpus: shared.corpus,
      requestKeyPolicy: {
        bodyCanonicalization: shared.requestKeyPolicy.bodyCanonicalization,
        plusInQuery: shared.requestKeyPolicy.plusInQuery,
        pathTrailingSlash: shared.requestKeyPolicy.pathTrailingSlash,
        headerSubset: shared.requestKeyPolicy.headerSubset,
        version: shared.requestKeyPolicy.version,
      },
      kind: shared.kind,
    };
    expect(decode(serializeCanonicalJson(shared))).toBe(canonicalize(shared));
    expect(decode(serializeCanonicalJson(permuted))).toBe(canonicalize(shared));
  });

  test("our digest spelling equals the evidence tree's over identical bytes", () => {
    const bytes = serializeCanonicalJson(shared);
    expect(informationWorldRecordDigest(bytes)).toBe(evidenceRecordDigest(bytes));
  });

  test("the digest is over the sealed bytes, not over a re-serialization", () => {
    const bytes = serializeCanonicalJson(shared);
    const pretty = new TextEncoder().encode(JSON.stringify(shared, null, 2));
    expect(informationWorldRecordDigest(pretty)).not.toBe(informationWorldRecordDigest(bytes));
    expect(evidenceRecordDigest(pretty)).not.toBe(evidenceRecordDigest(bytes));
  });
});
