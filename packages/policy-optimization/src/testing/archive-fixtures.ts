// SPDX-License-Identifier: MIT

/**
 * Test-only fixture builders for the archive and the CLI. Excluded from `tsconfig.build.json`.
 *
 * Manifests are sealed through `@jinn-network/policy-identity`'s own sealer, so a fixture's digest
 * is the digest a real candidate would carry; nothing here hand-writes canonical bytes.
 */

import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  sealCandidateManifest,
  type CandidateManifest,
  type PolicyParentRef,
} from "@jinn-network/policy-identity";
import { tupleFor } from "./wave-fixtures.js";

export const PROPOSER = "urn:uuid:40000000-0000-5000-8000-000000000001";

function receipt() {
  return {
    savedQueryDigest: `sha256:${"a".repeat(64)}`,
    snapshotReceipt: {
      savedQueryDigest: `sha256:${"a".repeat(64)}`,
      sourceSet: { id: "urn:jinn:sourceset:fixture", version: "1.0.0" },
      sources: [],
      evaluatedAt: "2026-08-01T00:00:00Z",
      reproducibility: "replayable" as const,
    },
    recordListDigest: `sha256:${"b".repeat(64)}`,
  };
}

export interface ManifestFixture {
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly manifest: CandidateManifest;
}

export function manifestFor(input: {
  readonly name: string;
  readonly fill: string;
  readonly parents?: readonly PolicyParentRef[];
  readonly touchedComponents?: readonly string[];
  readonly proposer?: string;
}): ManifestFixture {
  const manifest: CandidateManifest = {
    formatToken: CANDIDATE_MANIFEST_FORMAT_TOKEN,
    policy: tupleFor(input.name, input.fill),
    parents: input.parents ?? [],
    proposer: input.proposer ?? PROPOSER,
    evidenceProvenance: receipt(),
    declaredChanges: {
      summary: `Fixture candidate ${input.name}.`,
      touchedComponents: [...(input.touchedComponents ?? ["skills/repo-work"])],
    },
  };
  const sealed = sealCandidateManifest(manifest);
  return { digest: sealed.digest, bytes: sealed.bytes, manifest };
}

/** A seed and one child naming it as a typed `candidate` parent. */
export function lineagePair(): { readonly seed: ManifestFixture; readonly child: ManifestFixture } {
  const seed = manifestFor({ name: "seed", fill: "1" });
  const child = manifestFor({
    name: "child",
    fill: "2",
    parents: [{ kind: "candidate", digest: seed.digest }],
  });
  return { seed, child };
}
