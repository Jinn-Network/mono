// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  canonicalTupleBytes,
  prefixedDigest,
  type CandidateManifest,
} from "@jinn-network/policy-identity";
import { PolicyOptimizationError } from "../errors.js";
import { lineagePair, manifestFor, PROPOSER } from "../testing/archive-fixtures.js";
import { lineageFromEntries, lineageGraph, lineagePosition } from "./lineage.js";

describe("lineageGraph", () => {
  it("derives each node's digest from the bytes rather than from a label", () => {
    const seed = manifestFor({ name: "seed", fill: "1" });
    const graph = lineageGraph([seed.bytes]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.digest).toBe(prefixedDigest(seed.bytes));
    expect(graph.nodes[0]!.tupleDigest)
      .toBe(prefixedDigest(canonicalTupleBytes(seed.manifest.policy)));
    expect(graph.nodes[0]!.proposer).toBe(PROPOSER);
  });

  it("resolves a typed candidate parent into an edge in both directions", () => {
    const { seed, child } = lineagePair();
    const graph = lineageGraph([child.bytes, seed.bytes]);

    const seedNode = graph.nodes.find((node) => node.digest === seed.digest)!;
    const childNode = graph.nodes.find((node) => node.digest === child.digest)!;
    expect(childNode.resolvedParents).toEqual([seed.digest]);
    expect(childNode.unresolvedParents).toEqual([]);
    expect(seedNode.children).toEqual([child.digest]);
    expect(graph.roots).toEqual([seed.digest]);
    expect(graph.leaves).toEqual([child.digest]);
  });

  it("orders nodes deterministically regardless of input order", () => {
    const { seed, child } = lineagePair();
    expect(lineageGraph([seed.bytes, child.bytes]).nodes.map((node) => node.digest))
      .toEqual(lineageGraph([child.bytes, seed.bytes]).nodes.map((node) => node.digest));
  });

  it("keeps a tuple-kind parent as unresolved rather than treating it as a defect", () => {
    const tupleParent = { kind: "tuple" as const, digest: `sha256:${"c".repeat(64)}` };
    const child = manifestFor({ name: "child", fill: "2", parents: [tupleParent] });
    const [node] = lineageGraph([child.bytes]).nodes;
    expect(node!.resolvedParents).toEqual([]);
    expect(node!.unresolvedParents).toEqual([tupleParent]);
    expect(node!.parents).toEqual([tupleParent]);
  });

  it("keeps a candidate parent this projection does not hold as unresolved", () => {
    const absent = { kind: "candidate" as const, digest: `sha256:${"d".repeat(64)}` };
    const child = manifestFor({ name: "child", fill: "2", parents: [absent] });
    const graph = lineageGraph([child.bytes]);
    expect(graph.nodes[0]!.unresolvedParents).toEqual([absent]);
    expect(graph.roots).toEqual([child.digest]);
  });

  it("refuses the same manifest supplied twice", () => {
    const seed = manifestFor({ name: "seed", fill: "1" });
    expect(() => lineageGraph([seed.bytes, seed.bytes]))
      .toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });

});

// F-C7d-1. C6's MAJOR-3 made a self-parent unrepresentable where a learner emits a candidate.
// Through `lineageGraph` it is unrepresentable a second time, by construction: a manifest carrying
// its own digest is a sha256 fixed point. The forged case can only arrive through the labeled-entry
// surface, so the refusal is asserted exactly there — where the trust boundary actually is.
describe("lineageFromEntries — the labeled-input surface", () => {
  it("refuses an entry naming itself as its own parent", () => {
    const seed = manifestFor({ name: "self", fill: "9" });
    const forged: CandidateManifest = {
      ...seed.manifest,
      parents: [{ kind: "candidate", digest: seed.digest }],
    };
    let thrown: unknown;
    try {
      lineageFromEntries([{ digest: seed.digest, manifest: forged }]);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(PolicyOptimizationError);
    expect((thrown as PolicyOptimizationError).category).toBe("archive-derivation");
    expect((thrown as PolicyOptimizationError).message).toContain("its own parent");
  });

  it("refuses a two-node parent cycle", () => {
    const first = manifestFor({ name: "a", fill: "1" });
    const second = manifestFor({ name: "b", fill: "2" });
    expect(() => lineageFromEntries([
      { digest: first.digest, manifest: { ...first.manifest, parents: [{ kind: "candidate", digest: second.digest }] } },
      { digest: second.digest, manifest: { ...second.manifest, parents: [{ kind: "candidate", digest: first.digest }] } },
    ])).toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });

  it("agrees with lineageGraph on honest input", () => {
    const { seed, child } = lineagePair();
    expect(lineageFromEntries([
      { digest: seed.digest, manifest: seed.manifest },
      { digest: child.digest, manifest: child.manifest },
    ])).toEqual(lineageGraph([seed.bytes, child.bytes]));
  });
});

describe("lineagePosition", () => {
  it("walks ancestors and descendants transitively", () => {
    const seed = manifestFor({ name: "seed", fill: "1" });
    const middle = manifestFor({
      name: "middle", fill: "2", parents: [{ kind: "candidate", digest: seed.digest }],
    });
    const leaf = manifestFor({
      name: "leaf", fill: "3", parents: [{ kind: "candidate", digest: middle.digest }],
    });
    const graph = lineageGraph([seed.bytes, middle.bytes, leaf.bytes]);

    const middlePosition = lineagePosition(graph, middle.digest);
    expect(middlePosition.ancestors).toEqual([seed.digest]);
    expect(middlePosition.descendants).toEqual([leaf.digest]);
    expect([...lineagePosition(graph, leaf.digest).ancestors].sort())
      .toEqual([middle.digest, seed.digest].sort());
    expect([...lineagePosition(graph, seed.digest).descendants].sort())
      .toEqual([leaf.digest, middle.digest].sort());
  });

  // §7.3: population membership is keyed by tupleDigest, so two manifests can share one arm.
  it("names other manifests proposing the same tuple", () => {
    const first = manifestFor({ name: "same", fill: "7", proposer: "urn:uuid:aaaa" });
    const second = manifestFor({ name: "same", fill: "7", proposer: "urn:uuid:bbbb" });
    expect(first.digest).not.toBe(second.digest);
    const graph = lineageGraph([first.bytes, second.bytes]);
    expect(graph.nodes[0]!.tupleDigest).toBe(graph.nodes[1]!.tupleDigest);
    expect(lineagePosition(graph, first.digest).sameTuple).toEqual([second.digest]);
  });

  it("refuses a digest this projection does not hold", () => {
    const graph = lineageGraph([manifestFor({ name: "seed", fill: "1" }).bytes]);
    expect(() => lineagePosition(graph, `sha256:${"f".repeat(64)}`))
      .toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });
});
