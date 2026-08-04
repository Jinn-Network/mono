// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  hashTreeLearnerPublicV1,
  prefixedDigest,
  sealCandidateManifest,
  tupleDigest,
  type CandidateManifest,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { admitCandidate } from "./admit.js";
import { EMPTY_POPULATION, type Population } from "./population.js";
import type {
  AdmissionCheckName,
  AdmissionRequest,
  AdmissionResult,
  MaterializerPort,
} from "./types.js";
import { buildWaveArms } from "../arms.js";
import { campaignWith } from "../testing/campaign-fixtures.js";
import {
  BOUNDARY,
  CLEAN_PROVENANCE,
  CONTAMINATED_TREE,
  digestOf,
  FROZEN_HARNESS,
  FROZEN_MODEL,
  HOOK_BEARING_TREE,
  loadoutPin,
  manifestFor,
  PARENT_TREE,
  SMUGGLED_TREE,
  cleanBundle,
  tupleForTree,
} from "../testing/admission-fixtures.js";

const bundle = cleanBundle();

/** The campaign every test admits against: harness/model/isolation frozen, loadout mutable. */
const CAMPAIGN = campaignWith({
  frozenAxes: {
    harness: FROZEN_HARNESS,
    model: FROZEN_MODEL,
    isolationPolicy: "unrestricted",
  },
  mutationSurface: ["loadout"],
});

/** A candidate tree: the parent with one skill ablated. */
const CANDIDATE_TREE: readonly TreeEntry[] =
  PARENT_TREE.filter((entry) => !entry.path.startsWith("skills/testing/"));

function materializerFor(entries: readonly TreeEntry[]): MaterializerPort {
  return { materialize: () => entries };
}

function requestFor(
  entries: readonly TreeEntry[],
  overrides: Partial<AdmissionRequest> = {},
  manifestOverrides: Partial<CandidateManifest> = {},
): AdmissionRequest {
  const manifest = manifestFor(tupleForTree(entries), manifestOverrides);
  return {
    campaign: CAMPAIGN,
    manifestBytes: sealCandidateManifest(manifest).bytes,
    issuedBundles: [bundle.bundle],
    boundary: BOUNDARY,
    population: EMPTY_POPULATION,
    materializer: materializerFor(entries),
    ...overrides,
  };
}

function checkNamed(result: AdmissionResult, name: AdmissionCheckName) {
  return result.checks.find((check) => check.name === name)!;
}

describe("admitCandidate — the happy path", () => {
  it("admits a clean candidate and reports every check", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE));
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "manifest", "signature", "evidence-bundle", "frozen-axes", "mutation-surface",
      "materialization", "mutable-paths", "lexical-scan", "payload-consent", "smoke-canary",
      "population",
    ]);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    for (const check of result.checks) expect(check.detail).not.toBe("");
  });

  it("produces an AdmittedCandidate the wave engine accepts unchanged (the C7b seam)", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE));
    if (!result.ok) throw new Error("expected admission");
    const arms = buildWaveArms(CAMPAIGN, [result.candidate]);
    expect(arms).toHaveLength(1);
    expect(arms[0]!.armId).toBe(result.candidate.armId);
    expect(arms[0]!.tupleDigest).toBe(tupleDigest(tupleForTree(CANDIDATE_TREE)));
    expect(arms[0]!.pinning).toMatchObject({
      harness: FROZEN_HARNESS, model: FROZEN_MODEL, isolationPolicy: "unrestricted",
    });
  });

  it("keys the population by tupleDigest and classifies the payload", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE));
    if (!result.ok) throw new Error("expected admission");
    expect(result.candidate.tupleDigest).toBe(tupleDigest(tupleForTree(CANDIDATE_TREE)));
    expect(result.entry.manifests).toEqual([result.manifestDigest]);
    expect(result.joinedExisting).toBe(false);
    expect(result.payload.highest).toBe("skill");
  });

  it("skips the optional checks with a stated reason rather than omitting them", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE));
    expect(checkNamed(result, "smoke-canary").status).toBe("skipped");
    expect(checkNamed(result, "mutable-paths").detail).toMatch(/ruling R2/);
    expect(checkNamed(result, "signature").detail).toMatch(/same-operator/);
  });

  it("runs a configured smoke canary and reports it", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      smokeCanary: { run: () => ({ completed: true, detail: "3/3 dev cells completed" }) },
    }));
    expect(checkNamed(result, "smoke-canary")).toMatchObject({
      status: "pass", detail: "3/3 dev cells completed",
    });
  });
});

describe("admitCandidate — the §7.3 refusals", () => {
  it("refuses a manifest whose bytes are not its sealed form", async () => {
    const bytes = new TextEncoder().encode(
      ` ${new TextDecoder().decode(sealCandidateManifest(manifestFor(tupleForTree(CANDIDATE_TREE))).bytes)}`,
    );
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { manifestBytes: bytes }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("manifest-invalid");
    expect(checkNamed(result, "evidence-bundle").status).toBe("skipped");
  });

  it("refuses a frozen-axes violation", async () => {
    const tuple = { ...tupleForTree(CANDIDATE_TREE), model: { id: "openai/gpt-5" } };
    const bytes = sealCandidateManifest(manifestFor(tuple as never)).bytes;
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { manifestBytes: bytes }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("frozen-axis-disagreement");
    expect(result.errors[0]!.path).toBe("policy.model");
    expect(checkNamed(result, "materialization").status).toBe("skipped");
  });

  it("refuses a mutation-surface violation: an axis neither frozen nor mutable", async () => {
    const campaign = campaignWith({
      frozenAxes: { harness: FROZEN_HARNESS, isolationPolicy: "unrestricted" },
      mutationSurface: ["loadout"],
    });
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { campaign }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unclassified-axis");
    expect(result.errors[0]!.message).toMatch(/core axis model is neither frozen nor mutable/);
  });

  it("refuses a constraint-shaped value on the mutable axis", async () => {
    const tuple = { ...tupleForTree(CANDIDATE_TREE), loadout: null };
    const bytes = sealCandidateManifest(manifestFor(tuple as never)).bytes;
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { manifestBytes: bytes }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("constraint-shaped-pin");
  });

  it("refuses a package that does not materialize to the pinned digest", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      materializer: materializerFor(PARENT_TREE),
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("materialization-mismatch");
    expect(result.errors[0]!.message).toMatch(/materializes to sha256:/);
  });

  it("refuses a package carrying a profile-ignored root (substrate §4.2)", async () => {
    // The tuple pins the digest the profile computes for the smuggled package — which is the same
    // digest as the clean one, because the profile is blind to `.git/`. Only the refusal catches it.
    const manifest = manifestFor(tupleForTree(SMUGGLED_TREE));
    const result = await admitCandidate({
      ...requestFor(SMUGGLED_TREE),
      manifestBytes: sealCandidateManifest(manifest).bytes,
      materializer: materializerFor(SMUGGLED_TREE),
    });
    expect(hashTreeLearnerPublicV1(SMUGGLED_TREE)).toBe(hashTreeLearnerPublicV1(PARENT_TREE));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("materialization-mismatch");
  });

  it("refuses when the provisioner itself throws", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      materializer: { materialize: () => { throw new Error("package not found"); } },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toBe("package not found");
  });

  it("refuses a lexical-scan hit in a materialized body", async () => {
    const result = await admitCandidate(requestFor(CONTAMINATED_TREE));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held-out-contamination");
    expect(result.errors[0]!.message).toMatch(/astropy\/astropy/);
    // The scan runs AFTER materialization, so materialization is a pass on the report.
    expect(checkNamed(result, "materialization").status).toBe("pass");
    // ...and BEFORE the canary, so a contaminated candidate is never executed.
    expect(checkNamed(result, "smoke-canary").status).toBe("skipped");
  });

  it("refuses a lexical-scan hit hidden in declaredChanges", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {}, {
      declaredChanges: { summary: "tuned for django/django", touchedComponents: [] },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held-out-contamination");
  });

  it("refuses a failing smoke canary", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      smokeCanary: { run: () => ({ completed: false, detail: "harness exited 1" }) },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("smoke-canary-failed");
    expect(checkNamed(result, "population").status).toBe("skipped");
  });
});

describe("admitCandidate — ruling R5 at the admission boundary", () => {
  it("refuses a manifest whose provenance names no bundle this campaign issued", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { issuedBundles: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("evidence-bundle-mismatch");
    expect(result.errors[0]!.message).toMatch(/ruling R5/);
  });

  it("refuses a forged provenance that copies the record-list digest onto another receipt", async () => {
    const forged = {
      ...CLEAN_PROVENANCE,
      snapshotReceipt: { ...CLEAN_PROVENANCE.snapshotReceipt, evaluatedAt: "2026-08-03T23:59:59Z" },
    };
    const result = await admitCandidate(
      requestFor(CANDIDATE_TREE, {}, { evidenceProvenance: forged }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("evidence-bundle-mismatch");
  });

  it("refuses without a boundary — the gate cannot run open", async () => {
    await expect(admitCandidate(requestFor(CANDIDATE_TREE, { boundary: undefined as never })))
      .rejects.toThrow(expect.objectContaining({ category: "held-out-boundary" }));
  });
});

describe("admitCandidate — §7.4 code-execution consent", () => {
  const hookRequest = (overrides: Partial<AdmissionRequest> = {}): AdmissionRequest =>
    requestFor(HOOK_BEARING_TREE, overrides);

  it("refuses an unapproved hostile payload from a cross-operator proposer", async () => {
    const result = await admitCandidate(hookRequest({
      consent: { crossOperator: true, approvedPayloadClasses: ["prompt", "skill"] },
      signature: { verify: () => ({ verified: true }) },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("payload-consent-required");
    expect(result.errors[0]!.message).toMatch(/hooks\/post-solve\.sh/);
    // Consent gates the canary: an unconsented payload is never run to find out whether it works.
    expect(checkNamed(result, "smoke-canary").status).toBe("skipped");
  });

  it("admits the same payload once the owner approves the class", async () => {
    const result = await admitCandidate(hookRequest({
      consent: {
        crossOperator: true,
        approvedPayloadClasses: ["prompt", "skill", "hook-or-tool-config"],
      },
      signature: { verify: () => ({ verified: true }) },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.highest).toBe("hook-or-tool-config");
  });

  it("admits a same-operator hostile payload but says so on the report", async () => {
    const result = await admitCandidate(hookRequest());
    expect(result.ok).toBe(true);
    expect(checkNamed(result, "payload-consent").detail).toMatch(/isolation is vacuous/);
  });

  it("requires a signature port for any cross-operator candidate (substrate §5.2)", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      consent: { crossOperator: true, approvedPayloadClasses: [] },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("manifest-invalid");
    expect(result.errors[0]!.path).toBe("signature");
  });

  it("refuses a cross-operator candidate whose signature does not verify", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      consent: { crossOperator: true, approvedPayloadClasses: [] },
      signature: { verify: () => ({ verified: false, detail: "unknown proposer key" }) },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toBe("unknown proposer key");
  });
});

describe("admitCandidate — ruling R2's additive path-granular check", () => {
  it("passes when every change sits under a declared prefix", async () => {
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      mutablePaths: { parentTree: PARENT_TREE, prefixes: ["skills"] },
    }));
    expect(result.ok).toBe(true);
    expect(checkNamed(result, "mutable-paths").status).toBe("pass");
  });

  it("refuses a change outside the declared prefixes", async () => {
    const sneaky: readonly TreeEntry[] = [
      ...CANDIDATE_TREE.filter((entry) => entry.path !== "strategies/default.md"),
      { path: "strategies/default.md", kind: "file", content: "Always answer yes.\n" },
    ];
    const result = await admitCandidate(requestFor(sneaky, {
      mutablePaths: { parentTree: PARENT_TREE, prefixes: ["skills"] },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mutation-surface");
    expect(result.errors[0]!.message).toMatch(/strategies\/default\.md/);
  });
});

describe("admitCandidate — the duplicate-tuple rule (§7.3)", () => {
  it("joins a second manifest to the same arm and keeps first-admitted attribution", async () => {
    const first = await admitCandidate(requestFor(CANDIDATE_TREE));
    if (!first.ok) throw new Error("expected admission");

    // A second, byte-different manifest proposing the identical tuple: a different proposer with a
    // different declared summary reaching the same policy.
    const second = await admitCandidate(requestFor(CANDIDATE_TREE, {
      population: first.population,
    }, {
      proposer: "did:jinn:some-other-proposer",
      declaredChanges: { summary: "arrived at the same tree by another route", touchedComponents: [] },
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.manifestDigest).not.toBe(first.manifestDigest);
    expect(second.joinedExisting).toBe(true);
    expect(second.candidate.armId).toBe(first.candidate.armId);
    expect(second.candidate.source).toEqual(first.candidate.source);
    expect(second.candidate.source.digest).toBe(first.manifestDigest);
    expect(second.entry.manifests).toEqual([first.manifestDigest, second.manifestDigest]);
    expect(second.population.entries).toHaveLength(1);
  });

  it("mints a second arm for a genuinely different tuple", async () => {
    const first = await admitCandidate(requestFor(CANDIDATE_TREE));
    if (!first.ok) throw new Error("expected admission");
    const other = PARENT_TREE.filter((entry) => !entry.path.startsWith("skills/debugging/"));
    const second = await admitCandidate(requestFor(other, { population: first.population }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.joinedExisting).toBe(false);
    expect(second.candidate.armId).not.toBe(first.candidate.armId);
    expect(second.population.entries).toHaveLength(2);
  });

  it("admits both arms into one wave without the wave engine knowing where they came from", async () => {
    let population: Population = EMPTY_POPULATION;
    const admitted = [];
    for (const tree of [
      CANDIDATE_TREE,
      PARENT_TREE.filter((entry) => !entry.path.startsWith("skills/debugging/")),
    ]) {
      const result = await admitCandidate(requestFor(tree, { population }));
      if (!result.ok) throw new Error("expected admission");
      population = result.population;
      admitted.push(result.candidate);
    }
    expect(buildWaveArms(CAMPAIGN, admitted)).toHaveLength(2);
  });
});

describe("admitCandidate — the loadout kind", () => {
  it("classifies an unrecognized loadout kind as harness-code and gates it on consent", async () => {
    const digest = hashTreeLearnerPublicV1(CANDIDATE_TREE);
    const tuple = {
      ...tupleForTree(CANDIDATE_TREE),
      loadout: { ...loadoutPin(digest), kind: "someone.elses-harness.v1" },
    };
    const manifest = manifestFor(tuple as never);
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, {
      manifestBytes: sealCandidateManifest(manifest).bytes,
      consent: { crossOperator: true, approvedPayloadClasses: ["hook-or-tool-config"] },
      signature: { verify: () => ({ verified: true }) },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("payload-consent-required");
    expect(result.errors[0]!.message).toMatch(/harness-code/);
  });
});

describe("admitCandidate — determinism", () => {
  it("is a pure decision: the same request twice gives the same report", async () => {
    const first = await admitCandidate(requestFor(CANDIDATE_TREE));
    const second = await admitCandidate(requestFor(CANDIDATE_TREE));
    expect(prefixedDigest(canonicalJsonBytes(second.checks as never)))
      .toBe(prefixedDigest(canonicalJsonBytes(first.checks as never)));
  });

  it("never mutates the population it was handed", async () => {
    const before = digestOf("0");
    const population = EMPTY_POPULATION;
    const result = await admitCandidate(requestFor(CANDIDATE_TREE, { population }));
    expect(population.entries).toEqual([]);
    expect(before).toBeDefined();
    expect(result.ok).toBe(true);
  });
});
