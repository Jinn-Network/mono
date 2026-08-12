import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { PublicAssetInput } from "./assets.js";
import { buildPublicAssets } from "./assets.js";

const SHA = {
  benchmark: "1".repeat(64),
  run: "2".repeat(64),
  matrix: "3".repeat(64),
  report: "4".repeat(64),
  envelope: "5".repeat(64),
  recordA: "6".repeat(64),
  recordB: "7".repeat(64),
};

function fixture(overrides: {
  readonly outcome?: "complete" | "partial" | "cancelled";
  readonly conflicts?: number;
  readonly asymmetryFlags?: readonly string[];
  readonly hostile?: boolean;
  readonly inconsistentClaimRate?: string;
  readonly inconsistentMirrors?: boolean;
  readonly longArmIds?: boolean;
} = {}): PublicAssetInput {
  const hostile = overrides.hostile === true;
  const baseline = overrides.longArmIds === true
    ? `baseline-${"a".repeat(2_048)}</text><script src="https://evil.invalid/x.js">`
    : hostile ? `baseline</text><script src="https://evil.invalid/x.js">` : "baseline";
  const candidate = overrides.longArmIds === true
    ? `candidate-${"b".repeat(2_048)}\" onload=\"alert(1)`
    : hostile ? `candidate\" onload=\"alert(1)\n[bad](https://evil.invalid)` : "candidate";
  const reportLimitation = hostile
    ? `Limited </style><img src=x onerror=alert(1)>\n[external](https://evil.invalid) & still exact.`
    : overrides.inconsistentMirrors === true ? "REPORT-LIMITATION-STORED" : "Self-run results do not prove honesty against the run owner.";
  const claimLimitation = overrides.inconsistentMirrors === true ? "CLAIM-LIMITATION-STORED" : reportLimitation;
  const outcome = overrides.outcome ?? "complete";
  const conflicts = overrides.conflicts ?? 0;
  const asymmetryFlags = [...(overrides.asymmetryFlags ?? [])];
  const attrition = {
    perArm: {
      [baseline]: { expected: 3, judged: outcome === "complete" ? 3 : 2, unjudged: 0, unscorable: 0, expired: outcome === "complete" ? 0 : 1, invalidated: 0, excluded: 0, replacements: 0 },
      [candidate]: { expected: 3, judged: outcome === "complete" ? 3 : 1, unjudged: outcome === "partial" ? 1 : 0, unscorable: 0, expired: outcome === "complete" ? 0 : (outcome === "cancelled" ? 2 : 1), invalidated: 0, excluded: 0, replacements: 1 },
    },
    asymmetryFlags,
  };
  const completeness = {
    expected: 6,
    judged: outcome === "complete" ? 6 : (outcome === "partial" ? 3 : 2),
    floor: "0.5000",
    runOutcome: outcome,
  };
  const reportCompleteness = overrides.inconsistentMirrors === true
    ? { expected: 91, judged: 81, floor: "0.8100", runOutcome: "partial" as const }
    : completeness;
  const claimCompleteness = overrides.inconsistentMirrors === true
    ? { expected: 71, judged: 61, floor: "0.7100", runOutcome: "cancelled" as const }
    : completeness;
  const reportAttrition = overrides.inconsistentMirrors === true
    ? { perArm: attrition.perArm, asymmetryFlags: ["REPORT-ASYMMETRY-STORED"] }
    : attrition;
  const claimAttrition = overrides.inconsistentMirrors === true
    ? { perArm: attrition.perArm, asymmetryFlags: ["CLAIM-ASYMMETRY-STORED"] }
    : attrition;
  const reportArms = {
    [baseline]: { n: 3, passRate: "0.3333", wilsonInterval: { low: "0.0615", high: "0.7923" } },
    [candidate]: { n: 3, passRate: "0.6667", wilsonInterval: { low: "0.2077", high: "0.9385" } },
  };
  const claimArms = {
    ...reportArms,
    [baseline]: {
      ...reportArms[baseline],
      passRate: overrides.inconsistentClaimRate ?? reportArms[baseline].passRate,
    },
  };
  return {
    reportSha256: SHA.report,
    matrixSha256: SHA.matrix,
    recordSha256s: [SHA.recordA, SHA.recordB],
    dissentCellKeys: conflicts > 0 ? ["cell-z", "cell-a"] : [],
    matrix: {
      completeness,
      attrition,
    },
    report: {
      method: {
        // P4b Task 6: `buildPublicAssets` now dispatches the results-parsing shape on
        // `method.id`, so the id itself must stay a registered method (the distinguishing,
        // never-reconciled marker this test proves moves to `version` instead, which the
        // dispatch never consults).
        id: "jinn.benchmarking.method/wilson",
        version: overrides.inconsistentMirrors === true ? "report-method-stored" : "1",
        parameters: { sourceMarker: overrides.inconsistentMirrors === true ? "REPORT-PARAMETERS-STORED" : "shared" },
      },
      preregistered: overrides.inconsistentMirrors !== true,
      results: {
        perSubject: [{
          subjectSha256: SHA.matrix,
          results: {
            arms: reportArms,
            conflicted: { count: conflicts, cellKeys: conflicts > 0 ? ["cell-a"] : [] },
          },
        }],
      },
      disclosures: {
        perSubject: [{
          subjectSha256: SHA.matrix,
          integrityTiers: { "re-derivable": 5, "attested-only": 1 },
          pinning: {
            harness: { match: 5, mismatch: 0, unverifiable: 1 },
            model: { match: 6, mismatch: 0, unverifiable: 0 },
            loadout: { match: 4, mismatch: 0, unverifiable: 2 },
            isolation: { match: 3, mismatch: 0, unverifiable: 3 },
          },
          completeness: reportCompleteness,
          attrition: reportAttrition,
        }],
      },
      limitations: [reportLimitation],
    },
    claim: {
      claimSchema: "benchmark-product.claim-package/1",
      scope: {
        draftId: "public-comparison",
        benchmarkSha256: SHA.benchmark,
        taskCount: 3,
        arms: [
          { armId: baseline, pinning: { harness: hostile ? `harness\"/><script>` : "harness-a", model: "model-a" } },
          { armId: candidate, pinning: { harness: "harness-b", model: hostile ? "model</style>" : "model-b" } },
        ],
        replicates: 1,
        venue: "self-run",
      },
      records: {
        benchmarkSha256: SHA.benchmark,
        runSha256: SHA.run,
        matrixSha256: SHA.matrix,
        reportSha256: SHA.report,
        reportEnvelopeSha256: SHA.envelope,
      },
      method: {
        // See the matching comment on `report.method` above.
        id: "jinn.benchmarking.method/wilson",
        version: overrides.inconsistentMirrors === true ? "claim-method-stored" : "1",
        parameters: { sourceMarker: overrides.inconsistentMirrors === true ? "CLAIM-PARAMETERS-STORED" : "shared" },
        preregistered: true,
      },
      results: { perSubject: [{ results: { arms: claimArms, conflicted: { count: conflicts, cellKeys: conflicts > 0 ? ["cell-a"] : [] } } }] },
      headline: claimArms,
      completeness: claimCompleteness,
      attrition: claimAttrition,
      conflicted: {
        count: overrides.inconsistentMirrors === true ? 9 : conflicts,
        cellKeys: overrides.inconsistentMirrors === true ? ["CLAIM-CONFLICT-STORED"] : conflicts > 0 ? ["cell-a"] : [],
      },
      assurance: {
        preset: "strict-agreement",
        resolved: { independence: "gating", minVerdicts: 2, distinctEvaluator: true, verdictRule: "unanimous" },
        disclosure: "Distinct evaluator identities prove agent-distinctness, not party-independence.",
      },
      disclosures: {
        perSubject: [{ subjectSha256: SHA.matrix, marker: hostile ? "</pre><script>alert(1)</script>" : overrides.inconsistentMirrors === true ? "CLAIM-DISCLOSURE-STORED" : "stored disclosure" }],
        integrityTierCounts: { "re-derivable": 5, "attested-only": 1 },
        pinningUnverifiableCounts: { harness: 1, model: 0, loadout: 2, isolation: 3 },
      },
      limitations: [claimLimitation],
      venueHonesty: {
        venue: "self-run",
        preregistration: "discipline-not-owner-proof",
        trustBoundary: "workspace-minted public keys; no third-party trust anchor",
      },
      verification: {
        command: "colophon bundle verify --bundle <bundle-dir> --json",
        checks: ["manifest", "matrix-rederivation", "report-verification", "claim-consistency", "asset-projection"],
        trustRoot: "Bundle-carried public keys minted by the self-run workspace.",
      },
      rehearsal: {
        previewCount: 1,
        timestamps: ["2026-08-07T10:00:00.000Z"],
      },
    },
  } as unknown as PublicAssetInput;
}

function text(asset: Uint8Array | undefined): string {
  if (asset === undefined) throw new Error("missing asset");
  return new TextDecoder("utf-8", { fatal: true }).decode(asset);
}

describe("BP-41 public report assets", () => {
  test("adopts the Colophon identity with embedded source mark and OFL fonts", () => {
    const assets = buildPublicAssets(fixture());
    const html = text(assets["index.html"]);
    expect(html).toContain("Colophon report");
    expect(html).toContain("Built on Jinn.");
    expect(html).toContain("Newsreader");
    expect(html).toContain("Public Sans");
    expect(html).toContain("IBM Plex Mono");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toMatch(/https?:\/\//u);
    const readme = text(assets["README.md"]);
    expect(readme.match(/SIL OPEN FONT LICENSE Version 1\.1/gu)).toHaveLength(3);
    expect(readme).toContain("The Newsreader Project Authors");
    expect(readme).toContain("Public Sans Project Authors");
    expect(readme).toContain("IBM Corp");
    for (const path of ["badge.svg", "social-card.svg"] as const) {
      const svg = text(assets[path]);
      expect(svg).toContain("Colophon");
      expect(svg).toContain("data:font/woff2;base64,");
      expect(svg).not.toMatch(/(?:href|src)\s*=\s*["'](?:https?:|\/\/)/iu);
    }
  });

  test.each(["complete", "partial", "cancelled"] as const)(
    "renders the %s outcome and adverse facts without inferring a winner",
    (outcome) => {
      const assets = buildPublicAssets(fixture({
        outcome,
        conflicts: outcome === "complete" ? 0 : 1,
        asymmetryFlags: outcome === "partial" ? ["candidate attrition exceeds baseline"] : [],
      }));
      const html = text(assets["index.html"]);
      expect(html).toContain(`data-run-outcome="${outcome}"`);
      expect(html).toContain(outcome === "complete" ? "Complete comparison" : outcome === "partial" ? "Partial comparison" : "Cancelled comparison");
      expect(html).toContain("No comparative winner is stated");
      expect(html).toContain("0.3333");
      expect(html).toContain("0.6667");
      expect(html).not.toMatch(/candidate (wins|beats|is best)/iu);
      if (outcome !== "complete") expect(html).toContain("Prominent adverse facts");
    },
  );

  test("renders the exact sealed Report, Matrix, claim, scope, assurance, disclosure, and raw-record facts", () => {
    const assets = buildPublicAssets(fixture({ conflicts: 1, asymmetryFlags: ["candidate attrition exceeds baseline"] }));
    const html = text(assets["index.html"]);
    expect(html.match(/<h1\b/gu)).toHaveLength(1);
    expect(html).toMatch(/<header\b[^>]*>[\s\S]*<main\b[^>]*>[\s\S]*<footer\b/iu);
    expect(html).toContain("Sealed Report arm results");
    expect(html).toContain("Sealed Matrix accounting");
    expect(html).toContain("Sealed Report facts");
    expect(html).toContain("Stored Claim facts");
    expect(html).toContain("0.0615");
    expect(html).toContain("0.9385");
    expect(html).toContain("jinn.benchmarking.method/wilson");
    expect(html).toContain("strict-agreement");
    expect(html).toContain("agent-distinctness, not party-independence");
    expect(html).toContain("candidate attrition exceeds baseline");
    expect(html).toContain("Unverifiable axes");
    expect(html).toContain("Rehearsal disclosure");
    expect(html).toContain("Local self-run trust boundary");
    expect(html).toContain(SHA.report);
    expect(html).toContain(SHA.matrix);
    for (const path of ["benchmark.json", "run.json", "matrix.json", "report.json", "report-envelope.json", "claim-package.json", "verification/assembly.jsonl", "trust/public-keys.json"]) {
      expect(html).toContain(`href="${path}"`);
    }
    for (const sha256 of [SHA.recordA, SHA.recordB]) {
      expect(html).toContain(`href="records/${sha256}.bin"`);
      expect(text(assets["README.md"])).toContain(`records/${sha256}.bin`);
    }
    expect(html).toContain("@media print");
    expect(html).toContain(":focus-visible");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toContain("<script");
    const base = fixture();
    expect(() => buildPublicAssets({ ...base, recordSha256s: [SHA.recordB, SHA.recordA] })).toThrow(/canonically sorted/u);
    expect(() => buildPublicAssets({ ...base, recordSha256s: [SHA.recordA, SHA.recordA] })).toThrow(/unique/u);
    expect(() => buildPublicAssets({ ...base, recordSha256s: ["../unsafe"] })).toThrow(/record identities/u);
  });

  test("escapes hostile valid record content without creating active content or external links", () => {
    const input = fixture({ hostile: true, longArmIds: true, outcome: "partial", conflicts: 1, asymmetryFlags: ["<svg onload=alert(1)>"] });
    const assets = buildPublicAssets(input);
    for (const path of ["index.html", "badge.svg", "social-card.svg"] as const) {
      const body = text(assets[path]);
      const actualTags = body.match(/<[^>]+>/gu)?.join("\n") ?? "";
      expect(body).not.toMatch(/<script\b/iu);
      if (path === "index.html") {
        expect(body.match(/<img\b/giu)).toHaveLength(1);
        expect(body).toMatch(/<img[^>]+src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/u);
      } else {
        expect(body).not.toMatch(/<img\b/iu);
      }
      expect(actualTags).not.toMatch(/\son(?:load|error)\s*=/iu);
      expect(body).not.toMatch(/(?:href|src)\s*=\s*["'](?:https?:|\/\/|javascript:)/iu);
      expect(body).not.toMatch(/@import/iu);
      for (const match of body.matchAll(/url\(([^)]+)\)/giu)) {
        expect(match[1]).toMatch(/^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/u);
      }
    }
    const html = text(assets["index.html"]);
    expect(html).toContain("&lt;script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("index.html#limitations");
    expect(html).toContain("index.html#verification");
    const readme = text(assets["README.md"]);
    expect(readme).not.toContain("<script");
    expect(readme).not.toContain("<img");
    expect(readme).not.toContain("](https://evil.invalid)");
    for (const path of ["badge.svg", "social-card.svg"] as const) {
      const svg = text(assets[path]);
      const neutral = svg.indexOf('data-field="neutral-status"');
      const adverse = svg.indexOf('data-field="adverse-status"');
      const config = svg.indexOf('data-field="config-summary"');
      expect(neutral).toBeGreaterThan(-1);
      expect(adverse).toBeGreaterThan(neutral);
      expect(config).toBeGreaterThan(adverse);
      const visibleConfig = /data-field="config-summary"[^>]*>([^<]*)</u.exec(svg)?.[1];
      expect(visibleConfig).toBeDefined();
      expect(visibleConfig!.length).toBeLessThanOrEqual(160);
      expect(svg).toContain(input.claim.scope.arms[0]!.armId.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));
    }
  });

  test("intrinsically contains 2,048-character arm identities at 390px instead of masking document overflow", () => {
    const input = fixture({ hostile: true, longArmIds: true });
    const html = text(buildPublicAssets(input)["index.html"]);
    const stylesheet = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";
    const escapedBaseline = input.claim.scope.arms[0]!.armId
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

    expect(stylesheet).not.toMatch(/(?:html|body)[^{]*\{[^}]*overflow-x\s*:\s*hidden/iu);
    expect(stylesheet).toMatch(/strong,th,td,[^{]*\{[^}]*overflow-wrap\s*:\s*anywhere[^}]*word-break\s*:\s*break-word/iu);
    expect(stylesheet).toMatch(/pre\{[^}]*white-space\s*:\s*pre-wrap/iu);
    expect(stylesheet).toMatch(/table\{[^}]*table-layout\s*:\s*fixed/iu);
    expect(html).toContain(`<strong>${escapedBaseline}</strong>`);
    expect(html.match(new RegExp(`<th scope="row">${escapedBaseline}`, "gu"))).toHaveLength(3);
    expect(html).toContain(`&quot;baseline-${"a".repeat(2_048)}`);
  });

  test("keeps the social-card configuration summary and terminal ellipsis inside its fixed viewBox", () => {
    const input = fixture({ hostile: true, longArmIds: true });
    const svg = text(buildPublicAssets(input)["social-card.svg"]);
    const viewBox = /viewBox="0 0 ([0-9]+) [0-9]+"/u.exec(svg);
    const visual = /<text data-field="config-summary" x="([0-9]+)"[^>]*font-size="([0-9]+)"[^>]*>([^<]*)<\/text>/u.exec(svg);

    expect(viewBox).not.toBeNull();
    expect(visual).not.toBeNull();
    const viewBoxWidth = Number(viewBox![1]);
    const x = Number(visual![1]);
    const fontSize = Number(visual![2]);
    const codePoints = Array.from(visual![3]!);
    const conservativeWidth = codePoints.length * fontSize;
    expect(codePoints.at(-1)).toBe("…");
    expect(conservativeWidth).toBeLessThanOrEqual(viewBoxWidth - x - 100);
  });

  test("keeps every stored Matrix, Report, and Claim mirror distinct rather than reconciling facts", () => {
    const assets = buildPublicAssets(fixture({ inconsistentClaimRate: "0.9999", inconsistentMirrors: true }));
    const html = text(assets["index.html"]);
    const readme = text(assets["README.md"]);
    expect(html).toContain("Sealed Report arm results");
    expect(html).toContain("Stored claim mirror");
    expect(html).toContain("0.3333");
    expect(html).toContain("0.9999");
    for (const expected of [6, 91, 71]) {
      expect(html).toContain(`&quot;expected&quot;:${expected}`);
      expect(readme).toContain(`"expected":${expected}`);
    }
    for (const value of [
      "REPORT-ASYMMETRY-STORED", "CLAIM-ASYMMETRY-STORED",
      "REPORT-LIMITATION-STORED", "CLAIM-LIMITATION-STORED",
      "report-method-stored", "claim-method-stored",
      "REPORT-PARAMETERS-STORED", "CLAIM-PARAMETERS-STORED",
      "CLAIM-CONFLICT-STORED", "CLAIM-DISCLOSURE-STORED",
    ]) {
      expect(html).toContain(value);
      expect(readme).toContain(value);
    }
    expect(html).toContain("Report preregistered</dt><dd>No");
    expect(html).toContain("Claim preregistered</dt><dd>Yes");
  });

  test("all compact assets retain scope, digest attribution, adverse qualifiers, and a direct full-report path", () => {
    const assets = buildPublicAssets(fixture({ outcome: "cancelled", conflicts: 1, asymmetryFlags: ["candidate attrition exceeds baseline"] }));
    for (const path of ["badge.svg", "social-card.svg", "README.md", "share.txt"] as const) {
      const body = text(assets[path]);
      expect(body).toContain("3 tasks");
      expect(body).toContain("2 arms");
      expect(body).toContain("Cancelled comparison");
      expect(body).toContain(SHA.report.slice(0, 12));
      expect(body).toContain("index.html#limitations");
      expect(body).toContain("index.html#verification");
    }
    expect(text(assets["badge.svg"])).toContain(SHA.report);
    expect(text(assets["social-card.svg"])).toContain(SHA.report);
  });
});

/** P4b Task 4 (`docs/superpowers/plans/demo-report-1/2026-08-12-P4b-implementation-plan.md`): a
 * golden byte-equality guard that lands BEFORE any commit touches `assets.ts`, so later tasks that
 * teach this builder to dispatch on method cannot silently drift a single byte of wilson's own
 * output. `materializePublicBundle` (`bundle/materialize.ts`) writes exactly the bytes this
 * builder returns, with no further transformation, so decoding to UTF-8 text and comparing
 * against the committed golden is byte-for-byte equivalent to what production writes. */
function readGolden(name: string): string {
  return readFileSync(new URL(`./__fixtures__/wilson-golden/${name}`, import.meta.url), "utf8");
}

function wilsonGoldenAssetInput(): PublicAssetInput {
  return fixture();
}

const WILSON_GOLDEN_ASSET_NAMES = ["index.html", "badge.svg", "social-card.svg", "README.md", "share.txt"];

describe("Task 4 golden guard: wilson bundle asset byte-equality", () => {
  test("wilson bundle assets serialize byte-identically to the committed goldens", () => {
    const assets = buildPublicAssets(wilsonGoldenAssetInput());
    // Assert the key set itself first: iterating `Object.entries(assets)` alone would silently
    // pass if `buildPublicAssets` ever stopped emitting one of these assets -- a dropped key is
    // simply never visited by the loop below, so the guard must check the set is complete, not
    // just that whatever is present matches.
    expect(Object.keys(assets).sort()).toEqual([...WILSON_GOLDEN_ASSET_NAMES].sort());
    for (const [name, bytes] of Object.entries(assets)) {
      expect(text(bytes), name).toBe(readGolden(name));
    }
  });
});

/**
 * P4b Task 6 (`docs/superpowers/plans/demo-report-1/2026-08-12-P4b-implementation-plan.md`):
 * `buildPublicAssets` must dispatch on the produced method instead of hard-requiring wilson@1's
 * `arms` shape, so a paired-delta@1 bundle materializes too. Structure only -- pairs, delta,
 * interval or the withheld reasons -- with NO directional sentence; the five neutral-copy strings
 * stay byte-identical regardless of which branch produced the facts (proven by the Task 4 golden
 * guard above, which must keep passing unmodified once this dispatch lands).
 *
 * `pairedFixture` swaps only `report.method`/`report.results`/`claim.method`/`claim.results` onto
 * the wilson fixture's scaffolding (matrix, claim scope, disclosures, assurance, etc. are
 * irrelevant to which method produced the results) -- mirrors how `report/claim.test.ts`'s paired
 * fixture stays isolated from the report-production wiring, so a regression here can only be
 * caused by `buildPublicAssets` itself, never by an unrelated path.
 */
interface ComparisonInput {
  readonly pairs: number;
  readonly delta: string | null;
  readonly interval: { readonly alpha: string; readonly low: string; readonly high: string } | null;
  readonly reasons: readonly string[];
}

function pairedFixture(comparison: ComparisonInput): PublicAssetInput {
  const base = fixture();
  const results = {
    pairs: comparison.pairs,
    delta: comparison.delta,
    interval: comparison.interval,
    reasons: [...comparison.reasons],
    pairing: { taskDigests: [] },
    clustering: { basis: "task-provenance-source", clusters: comparison.pairs > 0 ? 1 : 0 },
    excluded: { count: 0, cellKeys: [] },
    conflicted: { count: 0, cellKeys: [] },
    bootstrap: { procedure: "xorshift32-v1", seed: 123456789, resamples: 1000 },
  };
  const wrapped = { perSubject: [{ subjectSha256: SHA.matrix, results }] };
  return {
    ...base,
    report: {
      ...base.report,
      method: {
        id: "jinn.benchmarking.method/paired-delta",
        version: "1",
        parameters: { baseline: "armA", candidate: "armB", seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
      results: wrapped,
    },
    claim: {
      ...base.claim,
      method: { ...base.claim.method, id: "jinn.benchmarking.method/paired-delta" },
      results: wrapped,
    },
  } as unknown as PublicAssetInput;
}

const INTERVAL_PRESENT: ComparisonInput = {
  pairs: 6,
  delta: "0.1667",
  interval: { alpha: "0.05", low: "0.0100", high: "0.3200" },
  reasons: [],
};

const INTERVAL_WITHHELD: ComparisonInput = {
  pairs: 2,
  delta: "0.0000",
  interval: null,
  reasons: [
    "fewer than minN=5 paired tasks (got 2)",
    "fewer than two source clusters (got 1)",
  ],
};

const ZERO_PAIRS: ComparisonInput = {
  pairs: 0,
  delta: null,
  interval: null,
  reasons: [
    "fewer than minN=5 paired tasks (got 0)",
    "fewer than two source clusters (got 0)",
  ],
};

/** README.md renders free text through the module's own `escapeMarkdown`, which backslash-escapes
 * markdown-special characters including parentheses -- the same treatment every other free-text
 * field on this surface already gets (limitations, disclosures, etc.). Mirrors that one behavior
 * so assertions against a withheld-reason string (which legitimately contains parens, e.g. "(got
 * 2)") match what the surface actually renders rather than the raw, un-escaped source string. */
function markdownEscaped(value: string): string {
  return value.replace(/([[\]()*_`|#!])/gu, "\\$1");
}

describe("Task 6: paired-delta@1 bundle asset dispatch", () => {
  test("interval-present: renders pairs, delta, and interval bounds without throwing, with no directional sentence", () => {
    const assets = buildPublicAssets(pairedFixture(INTERVAL_PRESENT));
    const html = text(assets["index.html"]);
    const readme = text(assets["README.md"]);
    for (const surface of [html, readme]) {
      expect(surface).toContain("0.1667");
      expect(surface).toContain("0.0100");
      expect(surface).toContain("0.3200");
      expect(surface).not.toMatch(/candidate (wins|beats|is best)/iu);
    }
    // The five neutral-copy strings are unconditional literals -- still present on the paired
    // branch, per the ratified "no publish-facing surface goes directional" constraint.
    expect(html).toContain("No comparative winner is stated");
  });

  test("interval-withheld: both reason strings surface on the full report and delta still renders", () => {
    const assets = buildPublicAssets(pairedFixture(INTERVAL_WITHHELD));
    const html = text(assets["index.html"]);
    const readme = text(assets["README.md"]);
    for (const surface of [html, readme]) {
      expect(surface).toContain("0.0000");
      expect(surface).not.toMatch(/candidate (wins|beats|is best)/iu);
    }
    for (const reason of INTERVAL_WITHHELD.reasons) {
      expect(html).toContain(reason);
      expect(readme).toContain(markdownEscaped(reason));
    }
  });

  test("interval-withheld: compact surfaces (badge, social-card, share.txt) render non-empty paired facts, not silently truncated to nothing", () => {
    const assets = buildPublicAssets(pairedFixture(INTERVAL_WITHHELD));
    for (const path of ["badge.svg", "social-card.svg"] as const) {
      const svg = text(assets[path]);
      const match = /data-field="paired-status"[^>]*>([^<]+)</u.exec(svg);
      expect(match, path).not.toBeNull();
      expect(match![1]!.trim().length, path).toBeGreaterThan(0);
      expect(match![1]).toContain("Pairs 2");
    }
    const share = text(assets["share.txt"]);
    expect(share).toMatch(/Pairs 2/u);
    expect(share.length).toBeGreaterThan(0);
  });

  test("zero-pairs: no delta, no interval, and no crash", () => {
    const assets = buildPublicAssets(pairedFixture(ZERO_PAIRS));
    const html = text(assets["index.html"]);
    const readme = text(assets["README.md"]);
    for (const surface of [html, readme]) {
      expect(surface).toContain("Pairs");
      expect(surface).not.toContain("0.1667");
    }
    for (const reason of ZERO_PAIRS.reasons) {
      expect(html).toContain(reason);
      expect(readme).toContain(markdownEscaped(reason));
    }
    for (const path of ["badge.svg", "social-card.svg", "share.txt"] as const) {
      expect(() => text(assets[path])).not.toThrow();
    }
  });
});
