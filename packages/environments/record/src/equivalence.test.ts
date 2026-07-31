// Cross-package seal-equivalence leg (program §5 contract 3). This package re-implements
// sealing locally and never imports shared runtime sealing code; equivalence with the
// evidence tree is proven here, in a test file, against two independent oracles:
//   1. `@jinn-network/evidence-protocol`'s `recordDigest` — the evidence tree's own digest
//      spelling over identical bytes;
//   2. `canonicalize` — an independent RFC 8785 JCS implementation.
// The source-boundary guard forbids either import from production source.
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { recordDigest as evidenceRecordDigest } from "@jinn-network/evidence-protocol";

import { serializeCanonicalJson } from "./canonical.js";
import { environmentRecordDigest } from "./hashing.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const shared = {
  kind: "https://jinn.network/records/environment/1.0",
  source: {
    repo: "owner/name",
    repoUrl: "https://github.com/owner/name",
    commit: "0".repeat(40),
  },
  image: {
    manifestDigest: `sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
  },
  workspace: "/testbed",
  invocations: { test: [{ bin: "pytest", args: ["-q"] }] },
};

describe("cross-package seal equivalence", () => {
  test("our JCS bytes equal the RFC 8785 reference implementation's, whatever the key order", () => {
    const permuted = {
      invocations: shared.invocations,
      workspace: shared.workspace,
      image: { platform: shared.image.platform, manifestDigest: shared.image.manifestDigest },
      source: { commit: shared.source.commit, repoUrl: shared.source.repoUrl, repo: shared.source.repo },
      kind: shared.kind,
    };
    expect(decode(serializeCanonicalJson(shared))).toBe(canonicalize(shared));
    expect(decode(serializeCanonicalJson(permuted))).toBe(canonicalize(shared));
  });

  test("our digest spelling equals the evidence tree's over identical bytes", () => {
    const bytes = serializeCanonicalJson(shared);
    expect(environmentRecordDigest(bytes)).toBe(evidenceRecordDigest(bytes));
  });

  test("the digest is over the sealed bytes, not over a re-serialization", () => {
    const bytes = serializeCanonicalJson(shared);
    const pretty = new TextEncoder().encode(JSON.stringify(shared, null, 2));
    expect(environmentRecordDigest(pretty)).not.toBe(environmentRecordDigest(bytes));
    expect(evidenceRecordDigest(pretty)).not.toBe(evidenceRecordDigest(bytes));
  });
});
