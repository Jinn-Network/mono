import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  prefixedDigest,
  sealCandidateManifest,
  tupleDigest,
} from "@jinn-network/policy-identity";
import { checkSeedAgreement, parseExactCampaign, sealCampaign, validateCampaign } from "./campaign.js";
import { PolicyOptimizationError } from "./errors.js";
import { CAMPAIGN_FORMAT_TOKEN } from "./tokens.js";
import type { CampaignDocument, SeedResolution } from "./types.js";
import {
  campaignWith,
  digestOf,
  SEED_TUPLE,
  SEED_TUPLE_DIGEST,
  tupleWith,
} from "./testing/campaign-fixtures.js";

const seedResolutions: SeedResolution[] = [
  { kind: "tuple", digest: SEED_TUPLE_DIGEST, tuple: SEED_TUPLE },
];

function codes(document: unknown): string[] {
  const result = validateCampaign(document);
  return result.ok ? [] : result.errors.map((entry) => `${entry.code}@${entry.path}`);
}

describe("validateCampaign — structure (product §5.1)", () => {
  it("accepts the golden document", () => {
    expect(validateCampaign(campaignWith()).ok).toBe(true);
  });

  it("refuses a non-object and a wrong format token", () => {
    expect(validateCampaign([]).ok).toBe(false);
    expect(codes(campaignWith({ formatToken: "network.jinn.policy-optimization.campaign/2.0" })))
      .toContain("invalid-document@formatToken");
  });

  it("requires every top-level field the design's table lists", () => {
    for (const field of [
      "target", "seeds", "mutationSurface", "frozenAxes",
      "objective", "budgets", "allocation", "stoppingRule",
    ]) {
      const document = { ...campaignWith() } as Record<string, unknown>;
      delete document[field];
      expect(codes(document).some((code) => code.endsWith(`@${field}`))).toBe(true);
    }
  });

  it("refuses an unrecognized non-namespaced top-level field and preserves a namespaced one", () => {
    expect(codes({ ...campaignWith(), score: 0.9 })).toContain("invalid-document@score");
    const extended = { ...campaignWith(), "com.example.note": "kept" };
    const result = validateCampaign(extended);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value["com.example.note"]).toBe("kept");
  });
});

describe("validateCampaign — the target (product §5.1, §6.3)", () => {
  it("requires both Benchmark digests in sha256 form", () => {
    expect(codes(campaignWith({
      target: { taskProfile: "p", developmentBenchmark: "abc", promotionBenchmark: digestOf("e") },
    }))).toContain("invalid-document@target.developmentBenchmark");
  });

  it("refuses a campaign whose promotion gate is its own development slate", () => {
    // §6.3: the promotion Benchmark is a held-out boundary. Reusing the development slate
    // contaminates it by construction — every dev wave has already revealed the promotion items.
    expect(codes(campaignWith({
      target: { taskProfile: "p", developmentBenchmark: digestOf("d"), promotionBenchmark: digestOf("d") },
    }))).toContain("invalid-document@target.promotionBenchmark");
  });

  it("accepts an optional trainingEvidence reference and refuses a malformed one", () => {
    expect(validateCampaign(campaignWith({
      target: {
        taskProfile: "p",
        developmentBenchmark: digestOf("d"),
        promotionBenchmark: digestOf("e"),
        trainingEvidence: { savedQueryDigest: digestOf("a") },
      },
    })).ok).toBe(true);
    expect(codes(campaignWith({
      target: {
        taskProfile: "p",
        developmentBenchmark: digestOf("d"),
        promotionBenchmark: digestOf("e"),
        trainingEvidence: { savedQueryDigest: "nope" },
      },
    })).length).toBeGreaterThan(0);
  });
});

describe("validateCampaign — seeds", () => {
  it("requires at least one typed seed reference", () => {
    expect(codes(campaignWith({ seeds: [] }))).toContain("invalid-document@seeds");
  });

  it("refuses an untyped or malformed seed reference", () => {
    expect(codes(campaignWith({ seeds: [{ kind: "policy", digest: digestOf("1") } as never] }))
      .some((code) => code.startsWith("invalid-document@seeds.0"))).toBe(true);
  });

  it("refuses a repeated seed reference", () => {
    const ref = { kind: "tuple", digest: SEED_TUPLE_DIGEST } as const;
    expect(codes(campaignWith({ seeds: [ref, ref] }))).toContain("invalid-document@seeds.1");
  });
});

describe("validateCampaign — mutation surface and frozen axes (product §5.1)", () => {
  it("pins the v0 mutation surface to exactly [loadout]", () => {
    expect(codes(campaignWith({ mutationSurface: ["loadout", "model"] })))
      .toContain("mutation-surface@mutationSurface");
    expect(codes(campaignWith({ mutationSurface: [] }))).toContain("mutation-surface@mutationSurface");
  });

  it("refuses an axis that is both frozen and mutable", () => {
    expect(codes(campaignWith({
      frozenAxes: {
        harness: { id: "claude-code", version: "2.1.34" },
        model: { id: "anthropic/claude-haiku-4-5" },
        isolationPolicy: "unrestricted",
        loadout: { kind: "jinn.skill.v1", name: "x", digest: digestOf("1") },
      },
    }))).toContain("mutation-surface@frozenAxes.loadout");
  });

  it("requires every core axis to be either frozen or mutable", () => {
    expect(codes(campaignWith({
      frozenAxes: {
        harness: { id: "claude-code", version: "2.1.34" },
        model: { id: "anthropic/claude-haiku-4-5" },
      },
    }))).toContain("invalid-document@frozenAxes.isolationPolicy");
  });

  it("refuses a constraint-shaped frozen value", () => {
    expect(codes(campaignWith({
      frozenAxes: {
        harness: { id: "claude-code", version: "2.1.34" },
        model: { provider: "anthropic" },
        isolationPolicy: "unrestricted",
      },
    }))).toContain("constraint-shaped-pin@frozenAxes.model");
  });

  it("refuses formatToken as an axis key — it is document metadata, never an axis", () => {
    expect(codes(campaignWith({
      frozenAxes: {
        harness: { id: "claude-code", version: "2.1.34" },
        model: { id: "anthropic/claude-haiku-4-5" },
        isolationPolicy: "unrestricted",
        formatToken: "x",
      },
    }))).toContain("invalid-document@frozenAxes.formatToken");
  });
});

describe("validateCampaign — objective, budgets, allocation, stopping rule", () => {
  it("requires at least one registry method reference", () => {
    expect(codes(campaignWith({ objective: { methods: [], constraints: [] } })))
      .toContain("invalid-document@objective.methods");
  });

  it("refuses a repeated (id, version) method reference", () => {
    const method = { id: "m", version: "1.0.0", parameters: {} };
    expect(codes(campaignWith({ objective: { methods: [method, method], constraints: [] } })))
      .toContain("invalid-document@objective.methods.1");
  });

  it("accepts a non-regression constraint over a registry method", () => {
    expect(validateCampaign(campaignWith({
      objective: {
        methods: [{ id: "m", version: "1.0.0", parameters: {} }],
        constraints: [{
          method: { id: "cost", version: "1.0.0", parameters: {} },
          relation: "must-not-increase",
        }],
      },
    })).ok).toBe(true);
  });

  it("refuses budgets that are not positive integers, and a hard cap under the evaluation budget", () => {
    expect(codes(campaignWith({
      budgets: { proposal: { maxProposals: 1 }, evaluation: { maxCells: 1.5 }, hardCap: { maxCells: 10 } },
    })).length).toBeGreaterThan(0);
    expect(codes(campaignWith({
      budgets: { proposal: { maxProposals: 1 }, evaluation: { maxCells: 100 }, hardCap: { maxCells: 10 } },
    }))).toContain("invalid-document@budgets.hardCap.maxCells");
  });

  it("refuses a zero budget on any of the three — a campaign that can only stop is not a campaign", () => {
    for (const budgets of [
      { proposal: { maxProposals: 0 }, evaluation: { maxCells: 10 }, hardCap: { maxCells: 10 } },
      { proposal: { maxProposals: 1 }, evaluation: { maxCells: 0 }, hardCap: { maxCells: 10 } },
      { proposal: { maxProposals: 1 }, evaluation: { maxCells: 10 }, hardCap: { maxCells: 0 } },
    ]) {
      expect(codes(campaignWith({ budgets }))).not.toEqual([]);
    }
  });

  it("requires an allocation policy and a stopping rule — exploration cannot run open-ended", () => {
    expect(codes(campaignWith({ allocation: { policyRef: "", parameters: {} } })))
      .toContain("invalid-document@allocation.policyRef");
    expect(codes(campaignWith({ stoppingRule: { ruleRef: "", parameters: {} } })))
      .toContain("invalid-document@stoppingRule.ruleRef");
  });
});

describe("sealCampaign — the sealing-time seed check (product §5.1)", () => {
  it("seals a document whose seeds byte-share every frozen axis", () => {
    const sealed = sealCampaign(campaignWith(), seedResolutions);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sealed.bytes).toEqual(canonicalJsonBytes(campaignWith()));
    expect(sealed.digest).toBe(prefixedDigest(sealed.bytes));
  });

  it("is key-order invariant — the digest names the value, not the literal", () => {
    const reordered = {
      stoppingRule: campaignWith().stoppingRule,
      formatToken: CAMPAIGN_FORMAT_TOKEN,
      seeds: campaignWith().seeds,
      allocation: campaignWith().allocation,
      budgets: campaignWith().budgets,
      objective: campaignWith().objective,
      frozenAxes: campaignWith().frozenAxes,
      mutationSurface: campaignWith().mutationSurface,
      target: campaignWith().target,
    } as unknown as CampaignDocument;
    expect(sealCampaign(reordered, seedResolutions).digest)
      .toBe(sealCampaign(campaignWith(), seedResolutions).digest);
  });

  it("refuses a seed whose tuple disagrees with a frozen axis", () => {
    const rogue = tupleWith({ model: { id: "openai/gpt-5" } });
    try {
      sealCampaign(
        campaignWith({ seeds: [{ kind: "tuple", digest: tupleDigest(rogue) }] }),
        [{ kind: "tuple", digest: tupleDigest(rogue), tuple: rogue }],
      );
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PolicyOptimizationError).category).toBe("frozen-axis-disagreement");
      expect((error as PolicyOptimizationError).errors[0]?.path).toBe("seeds.0.model");
    }
  });

  it("refuses a seed that omits a frozen axis entirely", () => {
    const rogue = { ...tupleWith() } as Record<string, unknown>;
    rogue["isolationPolicy"] = null;
    const digest = tupleDigest(rogue as never);
    expect(() => sealCampaign(
      campaignWith({ seeds: [{ kind: "tuple", digest }] }),
      [{ kind: "tuple", digest, tuple: rogue as never }],
    )).toThrowError(/isolationPolicy/);
  });

  it("refuses a seed whose mutable axis is constraint-shaped", () => {
    // The mutable axis is the search dimension; a family there means the arms are not comparable.
    const mutableCampaign = campaignWith({
      mutationSurface: ["loadout"],
    });
    const rogue = tupleWith({ loadout: null });
    expect(() => sealCampaign(
      { ...mutableCampaign, seeds: [{ kind: "tuple", digest: tupleDigest(rogue) }] } as CampaignDocument,
      [{ kind: "tuple", digest: tupleDigest(rogue), tuple: rogue }],
    )).toThrowError(/loadout/);
  });

  it("verifies the seed referent against its digest rather than trusting the label", () => {
    expect(() => sealCampaign(
      campaignWith(),
      [{ kind: "tuple", digest: SEED_TUPLE_DIGEST, tuple: tupleWith({ model: { id: "openai/gpt-5" } }) }],
    )).toThrowError(/digest/);
  });

  it("requires exactly one resolution per seed, and refuses an unmatched extra", () => {
    expect(() => sealCampaign(campaignWith(), [])).toThrowError(/seeds\.0/);
    expect(() => sealCampaign(campaignWith(), [
      ...seedResolutions,
      { kind: "tuple", digest: digestOf("9"), tuple: SEED_TUPLE },
    ])).toThrowError(/resolution/);
  });

  it("resolves a candidate seed through its sealed manifest bytes", () => {
    const manifest = {
      formatToken: "network.jinn.policy.candidate/1.0",
      policy: SEED_TUPLE,
      parents: [],
      proposer: "did:example:proposer",
      evidenceProvenance: {
        savedQueryDigest: digestOf("a"),
        recordListDigest: digestOf("b"),
        snapshotReceipt: {
          savedQueryDigest: digestOf("a"),
          sourceSet: { id: "set", version: "1" },
          sources: [],
          evaluatedAt: "2026-08-03T00:00:00Z",
          reproducibility: "replayable",
        },
      },
      declaredChanges: { summary: "seed", touchedComponents: [] },
    } as never;
    const sealedManifest = sealCandidateManifest(manifest);
    const campaign = campaignWith({ seeds: [{ kind: "candidate", digest: sealedManifest.digest }] });
    expect(sealCampaign(campaign, [
      { kind: "candidate", digest: sealedManifest.digest, manifestBytes: sealedManifest.bytes },
    ]).digest).toMatch(/^sha256:/);
  });
});

describe("sealCampaign — unclassified seed axes (BLOCKER-1, product §5.1)", () => {
  // A `repository-work/1.0` tuple carries `effort` beside the four core axes (substrate §4.1
  // step 2 admits every profile-declared requirementKey present in the effective requirements).
  // An axis the campaign neither freezes nor mutates is checked by nothing.
  const low = tupleWith({ effort: "low" });
  const high = tupleWith({ effort: "high" });
  const seedRefs = [
    { kind: "tuple", digest: tupleDigest(low) },
    { kind: "tuple", digest: tupleDigest(high) },
  ] as const;
  const resolved: SeedResolution[] = [
    { kind: "tuple", digest: tupleDigest(low), tuple: low },
    { kind: "tuple", digest: tupleDigest(high), tuple: high },
  ];

  it("refuses two seeds that differ only on a profile-declared axis the campaign never classified", () => {
    const result = checkSeedAgreement(campaignWith({ seeds: [...seedRefs] }), resolved);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((entry) => `${entry.code}@${entry.path}`)).toEqual([
        "unclassified-axis@seeds.0.effort",
        "unclassified-axis@seeds.1.effort",
      ]);
    }
    expect(() => sealCampaign(campaignWith({ seeds: [...seedRefs] }), resolved))
      .toThrowError(/effort/);
  });

  it("refuses an extension axis carried by one seed and not the other", () => {
    const bare = tupleWith();
    const extended = tupleWith({ "com.example.axis": "x" });
    const result = checkSeedAgreement(
      campaignWith({
        seeds: [
          { kind: "tuple", digest: tupleDigest(bare) },
          { kind: "tuple", digest: tupleDigest(extended) },
        ],
      }),
      [
        { kind: "tuple", digest: tupleDigest(bare), tuple: bare },
        { kind: "tuple", digest: tupleDigest(extended), tuple: extended },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((entry) => `${entry.code}@${entry.path}`))
        .toEqual(["unclassified-axis@seeds.1.com.example.axis"]);
    }
  });

  it("seals once the declared axis is frozen and the seeds agree on it", () => {
    // §5.1 says frozenAxes carries "every non-mutable axis", not every non-mutable CORE axis, so
    // the schema must accept a profile-declared axis there. This is that positive control.
    const campaign = campaignWith({
      seeds: [{ kind: "tuple", digest: tupleDigest(low) }],
      frozenAxes: { ...campaignWith().frozenAxes, effort: "low" },
    });
    expect(validateCampaign(campaign).ok).toBe(true);
    expect(sealCampaign(campaign, [{ kind: "tuple", digest: tupleDigest(low), tuple: low }]).digest)
      .toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses seeds that disagree on a frozen declared axis", () => {
    const campaign = campaignWith({
      seeds: [...seedRefs],
      frozenAxes: { ...campaignWith().frozenAxes, effort: "low" },
    });
    const result = checkSeedAgreement(campaign, resolved);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((entry) => `${entry.code}@${entry.path}`))
        .toEqual(["frozen-axis-disagreement@seeds.1.effort"]);
    }
  });

  it("names moving the axis into the mutation surface as the other resolution", () => {
    // v0 pins the mutation surface to `["loadout"]`, so freezing is the only route available today
    // for a declared axis — but the refusal message must offer both, because the rule is about
    // classification and a later v0+ campaign will legitimately take the other one.
    const result = checkSeedAgreement(campaignWith({ seeds: [...seedRefs] }), resolved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/frozenAxes or to mutationSurface/);
  });
});

describe("parseExactCampaign", () => {
  it("round-trips the sealed bytes", () => {
    const sealed = sealCampaign(campaignWith(), seedResolutions);
    expect(parseExactCampaign(sealed.bytes)).toEqual(campaignWith());
  });

  it("refuses bytes that are not the canonical sealed form of the document they carry", () => {
    const sealed = sealCampaign(campaignWith(), seedResolutions);
    const padded = new TextEncoder().encode(` ${new TextDecoder().decode(sealed.bytes)}`);
    expect(() => parseExactCampaign(padded)).toThrowError(/canonical/);
  });
});

describe("checkSeedAgreement is re-runnable by a reader who holds the seeds", () => {
  it("passes for the golden document and fails for a rogue seed", () => {
    const campaign = campaignWith();
    expect(checkSeedAgreement(campaign, seedResolutions).ok).toBe(true);
    const rogue = tupleWith({ harness: { id: "codex", version: "1" } });
    const result = checkSeedAgreement(
      campaignWith({ seeds: [{ kind: "tuple", digest: tupleDigest(rogue) }] }),
      [{ kind: "tuple", digest: tupleDigest(rogue), tuple: rogue }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("frozen-axis-disagreement");
  });
});
