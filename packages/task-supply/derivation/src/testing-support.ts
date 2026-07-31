// SPDX-License-Identifier: Apache-2.0

import type { EnvironmentRecord } from "@jinn-network/environment-record";
import type { Candidate } from "./candidate.js";
import { documentDigest } from "./digest.js";

const IMAGE_MANIFEST = `sha256:${"1".repeat(64)}`;
const PARSER_DIGEST = `sha256:${"2".repeat(64)}`;

/**
 * One fixture environment (design §4.2). Kept in code rather than JSON so a C1 schema
 * change breaks this at typecheck instead of at fixture-parse time.
 */
export function buildFixtureEnvironmentRecordBody(): EnvironmentRecord {
  return {
    kind: "https://jinn.network/records/environment/1.0",
    source: {
      repo: "acme/widget",
      repoUrl: "https://github.com/acme/widget",
      commit: "3".repeat(40),
    },
    image: {
      manifestDigest: IMAGE_MANIFEST,
      platform: "linux/amd64",
      reference: `registry.example/acme/widget@${IMAGE_MANIFEST}`,
    },
    workspace: "/testbed",
    invocations: {
      test: [{ bin: "python", args: ["-m", "pytest", "-q"], cwd: "/testbed" }],
    },
    parser: {
      id: "pytest",
      version: "1",
      digest: PARSER_DIGEST,
      uri: "https://example.invalid/parsers/pytest",
    },
    build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
    rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
    lineage: {
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        keys: ["acme__widget-1234"],
      },
    },
  } satisfies EnvironmentRecord;
}

const MATERIAL_BYTES = new TextEncoder().encode(
  "--- a/tests/test_widget.py\n+++ b/tests/test_widget.py\n@@\n+def test_zero(): ...\n",
);
const GOLD_BYTES = new TextEncoder().encode(
  "--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n",
);

/** One well-formed imported candidate against the fixture environment. */
export function buildFixtureCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "acme__widget-1234",
    statement: "Widget.resize() raises on zero width.\n",
    language: "python",
    testMaterial: [
      {
        name: "test-patch",
        mediaType: "text/x-diff",
        content: Buffer.from(MATERIAL_BYTES).toString("base64"),
        digest: documentDigest(MATERIAL_BYTES),
      },
    ],
    transitions: { failToPass: ["tests/test_widget.py::test_zero"], passToPass: [] },
    timeout: 900,
    goldPatch: GOLD_BYTES,
    provenance: {
      kind: "mined",
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: "acme__widget-1234",
      },
    },
    rights: { sourceLicense: "Apache-2.0" },
    ...overrides,
  };
}
