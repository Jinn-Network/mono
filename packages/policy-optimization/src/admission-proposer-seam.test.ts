// SPDX-License-Identifier: MIT

/**
 * The replaceability falsifier, end to end (program §1 C7 acceptance).
 *
 * > **Acceptance (whole C7):** the replaceability falsifier — C7c admits candidates from both the
 * > reference proposer and C6 **without campaign-engine modification**.
 *
 * This file is where that claim is made checkable at C7c's own boundary. It drives the two
 * proposers' outputs through one unmodified `admitCandidate` into one unmodified `buildWaveArms`,
 * and asserts that neither the gate nor the engine can tell which proposer produced which arm.
 *
 * The C6 side is a **shape stand-in, not a mock of the learner**: C6's `emitCandidate` builds its
 * tuple with `buildPolicyTuple` and seals through `sealCandidateManifest`, so what crosses into
 * this package is a sealed `CandidateManifest` and a candidate tree — exactly what is constructed
 * here from the same `@jinn-network/policy-identity` primitives. The product's source boundary
 * denies `operator/`, so importing the learner is not available and would not add anything: the seam
 * is the sealed bytes, and the sealed bytes are what is tested.
 *
 * The fixtures are the JSON ones under `fixtures/admission/`, so the boundary this runs against is
 * a document rather than a literal buried in a test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  hashTreeLearnerPublicV1,
  HARNESS_STATE_LOADOUT_KIND,
  sealCandidateManifest,
  type CandidateManifest,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { admitCandidate } from "./admission/admit.js";
import { EMPTY_POPULATION, type Population } from "./admission/population.js";
import { candidateAdmittedPayload, candidateRejectedPayload } from "./admission/journal.js";
import type { AdmissionRequest, MaterializerPort } from "./admission/types.js";
import { buildWaveArms } from "./arms.js";
import { assembleEvidenceBundle } from "./evidence-bundle/bundle.js";
import { partitionHeldOut, type EvidenceRecordRef, type HeldOutBoundary } from "./evidence-bundle/held-out.js";
import { createReferenceProposer } from "./proposers/reference.js";
import type { PolicyProposalRequest } from "./proposers/contract.js";
import { campaignWith } from "./testing/campaign-fixtures.js";
import {
  digestOf,
  FROZEN_HARNESS,
  FROZEN_MODEL,
  PARENT_TREE,
  PARENT_TUPLE,
  SNAPSHOT_RECEIPT,
  SAVED_QUERY_DIGEST,
} from "./testing/admission-fixtures.js";

const read = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(fileURLToPath(new URL(`../fixtures/admission/${name}`, import.meta.url)), "utf8"),
) as Record<string, unknown>;

const boundary = read("held-out-boundary.json") as unknown as HeldOutBoundary;
const mixed = read("evidence-records-mixed.json");
const supplied = mixed["records"] as EvidenceRecordRef[];
const expected = mixed["expected"] as {
  kept: string[];
  excluded: { record: string; axis: string; value: string }[];
};

const CAMPAIGN = campaignWith({
  frozenAxes: { harness: FROZEN_HARNESS, model: FROZEN_MODEL, isolationPolicy: "unrestricted" },
  mutationSurface: ["loadout"],
});

describe("the R5 filter, against the fixture boundary", () => {
  const partition = partitionHeldOut(supplied, boundary);

  it("keeps exactly the records the fixture declares clean, in the query's order", () => {
    expect(partition.kept.map((record) => record.record)).toEqual(expected.kept);
  });

  it("excludes the rest on the axes the fixture declares", () => {
    expect(partition.excluded).toEqual(expected.excluded);
  });

  it("refuses to assemble the unfiltered list and accepts the filtered one", () => {
    const input = {
      savedQueryDigest: SAVED_QUERY_DIGEST,
      snapshotReceipt: SNAPSHOT_RECEIPT,
      boundary,
    };
    expect(() => assembleEvidenceBundle({ ...input, records: supplied }))
      .toThrow(expect.objectContaining({ category: "held-out-contamination" }));
    expect(assembleEvidenceBundle({ ...input, records: partition.kept }).digest)
      .toMatch(/^sha256:/);
  });
});

// The one bundle both proposers are handed. Assembled from the FILTERED list, which is the whole
// of ruling R5 at this seam: neither proposer can be given a record the boundary excludes.
const bundle = assembleEvidenceBundle({
  savedQueryDigest: SAVED_QUERY_DIGEST,
  snapshotReceipt: SNAPSHOT_RECEIPT,
  records: partitionHeldOut(supplied, boundary).kept,
  boundary,
});

const proposalRequest: PolicyProposalRequest = {
  parents: [{ kind: "tuple", digest: digestOf("2") }],
  evidence: { digest: bundle.digest, provenance: bundle.provenance },
  objective: CAMPAIGN.objective,
  mutationSurface: CAMPAIGN.mutationSurface,
  budget: { maxProposals: 2 },
};

/**
 * The C6-shaped candidate: the learner's Improve phase adding a skill to a candidate workspace,
 * then sealing. Constructed from the same primitives `operator/src/harnesses/impls/learner/candidate.ts`
 * uses, because the seam between the two packages is the sealed manifest and nothing else.
 */
function learnerShapedCandidate(): { manifest: CandidateManifest; tree: readonly TreeEntry[] } {
  const tree: readonly TreeEntry[] = [
    ...PARENT_TREE,
    { path: "skills/bisecting/SKILL.md", kind: "file", content: "# Bisecting\nHalve the search space.\n" },
  ];
  const manifest: CandidateManifest = {
    formatToken: CANDIDATE_MANIFEST_FORMAT_TOKEN,
    policy: {
      ...PARENT_TUPLE,
      loadout: {
        kind: HARNESS_STATE_LOADOUT_KIND,
        name: "harness-state",
        digest: `sha256:${hashTreeLearnerPublicV1(tree)}`,
      },
    },
    parents: proposalRequest.parents,
    proposer: "did:jinn:learner",
    evidenceProvenance: bundle.provenance,
    declaredChanges: {
      summary: "Promoted a bisecting skill from two debrief runs.",
      touchedComponents: ["skills/bisecting"],
    },
  } as CandidateManifest;
  return { manifest, tree };
}

function materializerFor(trees: ReadonlyMap<string, readonly TreeEntry[]>): MaterializerPort {
  return {
    materialize: ({ loadout }) => {
      const entries = trees.get(String((loadout as Record<string, unknown>)["digest"]));
      if (entries === undefined) throw new Error("no package for this loadout pin");
      return entries;
    },
  };
}

describe("the replaceability falsifier", () => {
  const reference = createReferenceProposer({
    parentTree: PARENT_TREE,
    parentTuple: PARENT_TUPLE,
    proposerAgentIri: "did:jinn:reference-proposer",
  });
  const referenceProposals = reference.enumerate(proposalRequest);
  const learner = learnerShapedCandidate();

  const packages = new Map<string, readonly TreeEntry[]>([
    ...referenceProposals.map((proposal) => [
      String((proposal.manifest.policy.loadout as Record<string, unknown>)["digest"]),
      proposal.tree,
    ] as const),
    [
      String((learner.manifest.policy.loadout as Record<string, unknown>)["digest"]),
      learner.tree,
    ],
  ]);

  const request = (manifestBytes: Uint8Array, population: Population): AdmissionRequest => ({
    campaign: CAMPAIGN,
    manifestBytes,
    issuedBundles: [bundle.bundle],
    boundary,
    population,
    materializer: materializerFor(packages),
  });

  it("admits candidates from both proposers through one unmodified gate", async () => {
    let population: Population = EMPTY_POPULATION;
    const admitted = [];
    const sources: string[] = [];

    for (const proposal of referenceProposals) {
      const result = await admitCandidate(request(proposal.sealed.bytes, population));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      population = result.population;
      admitted.push(result.candidate);
      sources.push(reference.id);
    }

    const learnerResult = await admitCandidate(
      request(sealCandidateManifest(learner.manifest).bytes, population),
    );
    expect(learnerResult.ok).toBe(true);
    if (!learnerResult.ok) return;
    population = learnerResult.population;
    admitted.push(learnerResult.candidate);
    sources.push("did:jinn:learner");

    expect(admitted).toHaveLength(3);
    expect(population.entries).toHaveLength(3);

    // The engine seam: three arms, and nothing on any of them names a proposer.
    const arms = buildWaveArms(CAMPAIGN, admitted);
    expect(arms).toHaveLength(3);
    for (const arm of arms) {
      expect(Object.keys(arm).sort()).toEqual(["armId", "pinning", "source", "tupleDigest"]);
      expect(JSON.stringify(arm)).not.toContain("reference");
      expect(JSON.stringify(arm)).not.toContain("learner");
    }
    // Proposer identity survives only in the journal, where attribution belongs.
    expect(new Set(sources).size).toBe(2);
  });

  it("journals an admission with the arm, the attribution, and every check", async () => {
    const result = await admitCandidate(
      request(referenceProposals[0]!.sealed.bytes, EMPTY_POPULATION),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = candidateAdmittedPayload(result, reference.id);
    expect(payload).toMatchObject({
      proposer: reference.id,
      armId: result.candidate.armId,
      joinedExisting: false,
      attribution: result.manifestDigest,
      highestPayloadClass: "skill",
    });
    expect(payload["checks"]).toHaveLength(result.checks.length);
  });

  it("journals a rejection with every check, not only the failing one", async () => {
    const orphan = { ...learner, manifest: { ...learner.manifest, evidenceProvenance: {
      ...bundle.provenance, recordListDigest: digestOf("0"),
    } } } as { manifest: CandidateManifest };
    const sealed = sealCandidateManifest(orphan.manifest);
    const result = await admitCandidate(request(sealed.bytes, EMPTY_POPULATION));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const payload = candidateRejectedPayload(result, "did:jinn:learner", sealed.digest);
    expect(payload).toMatchObject({
      reason: "evidence-bundle-mismatch",
      failedCheck: "evidence-bundle",
    });
    expect(payload["checks"]).toHaveLength(result.checks.length);
  });
});
