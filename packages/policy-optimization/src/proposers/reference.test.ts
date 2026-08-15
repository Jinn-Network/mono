// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  hashTreeLearnerPublicV1,
  parseExactCandidateManifest,
  validateCandidateManifest,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import {
  createReferenceProposer,
  enumerateReferenceCandidates,
  enumerateRemovalSets,
  REFERENCE_PROPOSER_ID,
  skillNames,
} from "./reference.js";
import type { PolicyProposalRequest } from "./contract.js";
import {
  cleanBundle,
  digestOf,
  PARENT_TREE,
  PARENT_TREE_DIGEST,
  PARENT_TUPLE,
} from "../testing/admission-fixtures.js";

const bundle = cleanBundle();

function requestWith(overrides: Partial<PolicyProposalRequest> = {}): PolicyProposalRequest {
  return {
    parents: [{ kind: "tuple", digest: digestOf("2") }],
    evidence: { digest: bundle.digest, provenance: bundle.provenance },
    objective: { methods: [], constraints: [] },
    mutationSurface: ["loadout"],
    budget: { maxProposals: 8 },
    ...overrides,
  };
}

const input = {
  parentTree: PARENT_TREE,
  parentTuple: PARENT_TUPLE,
  proposerAgentIri: "did:jinn:reference-proposer",
};

describe("skillNames", () => {
  it("names the skill directories, sorted by code unit", () => {
    expect(skillNames(PARENT_TREE)).toEqual(["debugging", "refactoring", "testing"]);
  });

  it("ignores a loose file directly under skills/", () => {
    const withLoose: TreeEntry[] = [...PARENT_TREE, { path: "skills/README.md", kind: "file", content: "x" }];
    expect(skillNames(withLoose)).toEqual(["debugging", "refactoring", "testing"]);
  });

  it("returns nothing for a tree with no skills", () => {
    expect(skillNames([{ path: "policy.json", kind: "file", content: "{}" }])).toEqual([]);
  });
});

describe("enumerateRemovalSets", () => {
  it("emits every single ablation first, then every pair, in index order", () => {
    expect(enumerateRemovalSets(["a", "b", "c"])).toEqual([
      ["a"], ["b"], ["c"],
      ["a", "b"], ["a", "c"], ["b", "c"],
    ]);
  });

  it("emits one ablation and no pair for a single skill", () => {
    expect(enumerateRemovalSets(["a"])).toEqual([["a"]]);
  });

  it("emits nothing for no skills", () => {
    expect(enumerateRemovalSets([])).toEqual([]);
  });
});

describe("the reference proposer", () => {
  it("enumerates ablations then recombinations, deterministically", () => {
    const proposals = enumerateReferenceCandidates(input, requestWith());
    expect(proposals.map((p) => p.removed)).toEqual([
      ["debugging"], ["refactoring"], ["testing"],
      ["debugging", "refactoring"], ["debugging", "testing"], ["refactoring", "testing"],
    ]);
  });

  it("is a pure function of its inputs: two runs are byte-identical", () => {
    const first = enumerateReferenceCandidates(input, requestWith());
    const second = enumerateReferenceCandidates(input, requestWith());
    expect(second.map((p) => p.sealed.digest)).toEqual(first.map((p) => p.sealed.digest));
  });

  it("seals manifests that validate and round-trip through their own bytes", () => {
    for (const proposal of enumerateReferenceCandidates(input, requestWith())) {
      expect(validateCandidateManifest(proposal.manifest).ok).toBe(true);
      expect(parseExactCandidateManifest(proposal.sealed.bytes)).toEqual(proposal.manifest);
    }
  });

  it("repins the loadout to the variant tree's own digest and touches no other axis", () => {
    for (const proposal of enumerateReferenceCandidates(input, requestWith())) {
      const loadout = proposal.manifest.policy.loadout as Record<string, string>;
      expect(loadout.digest).toBe(`sha256:${hashTreeLearnerPublicV1(proposal.tree)}`);
      expect(loadout.digest).not.toBe(`sha256:${PARENT_TREE_DIGEST}`);
      expect(proposal.manifest.policy.harness).toEqual(PARENT_TUPLE.harness);
      expect(proposal.manifest.policy.model).toEqual(PARENT_TUPLE.model);
      expect(proposal.manifest.policy.isolationPolicy).toEqual(PARENT_TUPLE.isolationPolicy);
    }
  });

  it("removes exactly the named skills and leaves everything else byte-identical", () => {
    const [first] = enumerateReferenceCandidates(input, requestWith());
    expect(first!.tree.map((entry) => entry.path)).toEqual([
      "policy.json",
      "skills/refactoring/SKILL.md",
      "skills/testing/SKILL.md",
      "strategies/default.md",
      "notes/2026-08-01.md",
    ]);
  });

  it("carries the campaign's parents and the bundle's provenance verbatim", () => {
    const request = requestWith();
    for (const proposal of enumerateReferenceCandidates(input, request)) {
      expect(proposal.manifest.parents).toEqual(request.parents);
      expect(proposal.manifest.evidenceProvenance).toEqual(bundle.provenance);
    }
  });

  it("declares what it removed", () => {
    const proposals = enumerateReferenceCandidates(input, requestWith());
    expect(proposals[0]!.manifest.declaredChanges).toEqual({
      summary: "Ablated skill debugging from the parent loadout.",
      touchedComponents: ["skills/debugging"],
    });
    expect(proposals[3]!.manifest.declaredChanges.touchedComponents)
      .toEqual(["skills/debugging", "skills/refactoring"]);
  });

  it("truncates at the proposal budget, keeping the ablations", () => {
    const proposals = enumerateReferenceCandidates(input, requestWith({ budget: { maxProposals: 2 } }));
    expect(proposals.map((p) => p.removed)).toEqual([["debugging"], ["refactoring"]]);
  });

  it("proposes nothing on a zero budget", () => {
    expect(enumerateReferenceCandidates(input, requestWith({ budget: { maxProposals: 0 } }))).toEqual([]);
  });

  it("refuses a nonsensical budget rather than guessing", () => {
    expect(() => enumerateReferenceCandidates(input, requestWith({ budget: { maxProposals: -1 } })))
      .toThrow(/maxProposals must be a non-negative integer/);
  });

  it("proposes nothing when the campaign does not permit varying the loadout", () => {
    expect(enumerateReferenceCandidates(input, requestWith({ mutationSurface: ["model"] }))).toEqual([]);
  });

  it("proposes nothing for a parent with no skills — a falsifier with nothing to ablate", () => {
    const bare: TreeEntry[] = [{ path: "policy.json", kind: "file", content: "{}" }];
    expect(enumerateReferenceCandidates({ ...input, parentTree: bare }, requestWith())).toEqual([]);
  });

  it("emits only one candidate for a single-skill parent: the pair family is empty", () => {
    const single = PARENT_TREE.filter((entry) => !entry.path.startsWith("skills/refactoring/")
      && !entry.path.startsWith("skills/testing/"));
    const proposals = enumerateReferenceCandidates({ ...input, parentTree: single }, requestWith());
    expect(proposals.map((p) => p.removed)).toEqual([["debugging"]]);
  });

  it("never emits two variants with the same tree digest", () => {
    const digests = enumerateReferenceCandidates(input, requestWith()).map((p) => p.tupleDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("makes no model call, no clock read, and no filesystem access (source-level)", async () => {
    const source = await import("node:fs/promises")
      .then(({ readFile }) => readFile(new URL("./reference.ts", import.meta.url), "utf8"));
    const executable = source.split("\n").filter((line) => !line.trimStart().startsWith("*")
      && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("/*"));
    for (const banned of ["Date.now", "Math.random", "node:fs", "fetch("]) {
      expect(executable.join("\n")).not.toContain(banned);
    }
  });
});

describe("createReferenceProposer — the PolicyProposer contract", () => {
  it("exposes an id for attribution", () => {
    expect(createReferenceProposer(input).id).toBe(REFERENCE_PROPOSER_ID);
  });

  it("returns manifests from propose and the full proposals from enumerate", async () => {
    const proposer = createReferenceProposer(input);
    const manifests = await proposer.propose(requestWith());
    expect(manifests).toEqual(proposer.enumerate(requestWith()).map((p) => p.manifest));
  });
});
