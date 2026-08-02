// Cross-package seal-equivalence leg (program §4 contract 3). This package re-implements
// sealing locally and never imports shared runtime sealing code; equivalence is proven here,
// in a test file, against three independent oracles:
//   1. `@jinn-network/environment-record` — the SWE sibling whose primitives this package
//      materialized, so a future edit to either copy is caught immediately;
//   2. `@jinn-network/evidence-protocol`'s `recordDigest` — the evidence tree's digest spelling;
//   3. `canonicalize` — an independent RFC 8785 JCS implementation.
// The source-boundary guard forbids all three imports from production source.
import { serializeCanonicalJson as sweSerialize } from "@jinn-network/environment-record";
import { recordDigest as evidenceRecordDigest } from "@jinn-network/evidence-protocol";
import canonicalize from "canonicalize";
import { describe, expect, test } from "vitest";

import { serializeCanonicalJson } from "./canonical.js";
import { sealedRecordDigest } from "./hashing.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const shared = {
  kind: "https://jinn.network/records/chain-environment/1.0",
  runtime: {
    family: "anvil",
    version: "1.3.7",
    image: { manifestDigest: `sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
  },
  determinismControls: { miningMode: "manual", initialBlockNumber: 21000000 },
};

const permuted = {
  determinismControls: {
    initialBlockNumber: shared.determinismControls.initialBlockNumber,
    miningMode: shared.determinismControls.miningMode,
  },
  runtime: {
    image: { platform: shared.runtime.image.platform, manifestDigest: shared.runtime.image.manifestDigest },
    version: shared.runtime.version,
    family: shared.runtime.family,
  },
  kind: shared.kind,
};

describe("cross-package seal equivalence", () => {
  test("our JCS bytes equal the RFC 8785 reference implementation's, whatever the key order", () => {
    expect(decode(serializeCanonicalJson(shared))).toBe(canonicalize(shared));
    expect(decode(serializeCanonicalJson(permuted))).toBe(canonicalize(shared));
  });

  test("our JCS bytes equal the SWE sibling's over identical input", () => {
    expect(decode(serializeCanonicalJson(shared))).toBe(decode(sweSerialize(shared)));
    expect(decode(serializeCanonicalJson(permuted))).toBe(decode(sweSerialize(shared)));
  });

  test("our digest spelling equals the evidence tree's over identical bytes", () => {
    const bytes = serializeCanonicalJson(shared);
    expect(sealedRecordDigest(bytes)).toBe(evidenceRecordDigest(bytes));
  });

  test("the digest is over the sealed bytes, not over a re-serialization", () => {
    const bytes = serializeCanonicalJson(shared);
    const pretty = new TextEncoder().encode(JSON.stringify(shared, null, 2));
    expect(sealedRecordDigest(pretty)).not.toBe(sealedRecordDigest(bytes));
  });
});
