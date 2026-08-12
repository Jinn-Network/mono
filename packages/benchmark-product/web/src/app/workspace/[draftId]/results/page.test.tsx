import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const loadResultsViewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/view-models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/view-models")>(),
  loadResultsView: loadResultsViewMock,
}));
vi.mock("@/lib/server/gui-action-registry", () => ({
  GUI_SERVER_ACTIONS: {
    "run.results": vi.fn(),
    "run.report": vi.fn(),
    "run.verify": vi.fn(),
    "run.publish": vi.fn(),
  },
}));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ submitLabel, gated }: { readonly submitLabel: string; readonly gated?: boolean }) => (
    <form>{submitLabel}{gated ? " Requires authority" : ""}</form>
  ),
}));
vi.mock("@/components/verification-form", () => ({
  VerificationForm: () => <form>Verify records</form>,
}));

import ResultsPage from "./page";
import { PRODUCT_BRANDING } from "@/lib/branding";

const matrixSha256 = "a".repeat(64);
const reportSha256 = "b".repeat(64);
const envelopeSha256 = "c".repeat(64);

function reportedView() {
  return {
    ok: true as const,
    draft: { ok: true as const, result: { draft: { state: "reported" } } },
    results: {
      ok: true as const,
      result: {
        draftId: "draft-1",
        benchmarkSha256: "d".repeat(64),
        runSha256: "e".repeat(64),
        matrixSha256,
        closeBoundary: { at: "2026-08-07T00:00:00.000Z" },
        runOutcome: "partial",
        completeness: { expected: 2, judged: 1, floor: "0.5000", runOutcome: "partial" },
        attrition: {
          perArm: {
            baseline: { expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 },
            candidate: { expected: 1, judged: 0, unjudged: 0, unscorable: 0, expired: 1, invalidated: 0, excluded: 0, replacements: 1 },
          },
          asymmetryFlags: ["candidate has more expired cells than baseline"],
        },
        dissentCells: ["baseline:1:task"],
        cells: [
          {
            cellKey: "baseline:1:task",
            armId: "baseline",
            replicate: 1,
            taskSha256: "f".repeat(64),
            outcome: "judged",
            verification: { harness: "match", model: "unverifiable", loadout: "match", isolation: "unverifiable", checksFailed: ["model evidence absent"] },
            integrityTier: "re-derivable",
            verdicts: [
              { sha256: "1".repeat(64), verdict: "pass", evaluator: "urn:agent:evaluator-a", measurements: { quality: true } },
              { sha256: "2".repeat(64), verdict: "fail", evaluator: "urn:agent:evaluator-b", measurements: { quality: false } },
            ],
            validVerdicts: ["1".repeat(64)],
            cost: { value: "0.25", unit: "USD", source: "reported" },
            latencyMs: 1250,
          },
          {
            cellKey: "candidate:1:task",
            armId: "candidate",
            replicate: 1,
            taskSha256: "3".repeat(64),
            outcome: "expired",
            verification: { harness: "unverifiable", model: "unverifiable", loadout: "unverifiable", isolation: "unverifiable", checksFailed: [] },
            integrityTier: "attested-only",
            verdicts: [],
            validVerdicts: [],
            failure: { kind: "failed", blame: "infrastructure", detail: "launcher stopped" },
          },
        ],
        venueHonesty: {
          venue: "self-run",
          preRegistration: "structural-and-append-order-only",
          limits: ["The operator controls execution and evaluation."],
          unverifiableAxisCounts: { harness: 1, model: 2, loadout: 1, isolation: 2 },
        },
        report: {
          reportSha256,
          reportEnvelopeSha256: envelopeSha256,
          verification: { status: "not-run", detail: "Run verification before relying on the signature." },
          record: {
            method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: { verdictRule: "sole" } },
            preregistered: true,
            results: {
              perSubject: [{
                subjectSha256: matrixSha256,
                results: {
                  arms: { baseline: { n: 1, passRate: "0.2500", wilsonInterval: { low: "0.0100", high: "0.7000" } } },
                  conflicted: { count: 1, cellKeys: ["report-only-conflict-" + "x".repeat(96)] },
                },
              }],
            },
            disclosures: { perSubject: [{ independence: 0, evidence: "report-disclosure-" + "y".repeat(256) }] },
            limitations: ["Local self-run venue."],
          },
          claimPackage: {
            claimSchema: "benchmark-product.claim-package/1",
            scope: { draftId: "draft-1", benchmarkSha256: "d".repeat(64), taskCount: 1, arms: [{ armId: "baseline", pinning: { harness: "v1" } }], replicates: 1, venue: "self-run" },
            records: { benchmarkSha256: "d".repeat(64), runSha256: "e".repeat(64), matrixSha256, reportSha256, reportEnvelopeSha256: envelopeSha256 },
            method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: { verdictRule: "sole" }, preregistered: true },
            headline: { baseline: { n: 1, passRate: "1.0000", wilsonInterval: { low: "0.2065", high: "1.0000" } } },
            completeness: { expected: 2, judged: 1, floor: "0.5000", runOutcome: "partial" },
            attrition: { perArm: {}, asymmetryFlags: [] },
            conflicted: { count: 1, cellKeys: ["baseline:1:task"] },
            assurance: { preset: "direct-check", resolved: { independence: "disclosed", minVerdicts: 1, distinctEvaluator: false, verdictRule: "sole" }, disclosure: "Agent-distinctness is not party-independence." },
            disclosures: { perSubject: [{ independence: 0 }], integrityTierCounts: { "re-derivable": 1, "attested-only": 1 }, pinningUnverifiableCounts: { harness: 1, model: 2, loadout: 1, isolation: 2 } },
            limitations: ["Local self-run venue."],
            venueHonesty: { venue: "self-run" },
            verification: { command: "colophon bundle verify --bundle <bundle-dir> --json", checks: ["matrix re-derivation"], trustRoot: "Workspace-local report key." },
            rehearsal: { previewCount: 2, timestamps: ["2026-08-06T00:00:00.000Z", "2026-08-06T00:01:00.000Z"] },
          },
        },
      },
    },
  };
}

interface ComparisonFixture {
  readonly pairs: number;
  readonly delta: string | null;
  readonly interval: { readonly alpha: string; readonly low: string; readonly high: string } | null;
  readonly reasons: readonly string[];
}

/** A paired-delta@1 view (P4b Task 7): swaps the claim package's wilson `headline` for its sibling
 * `comparison`, and gives the stored Report's own `results` the comparison shape too (rather than
 * wilson's `arms`) — the same non-wilson shape a real paired Report seals, which is exactly what
 * exercises the existing "Stored Report results cannot be presented as the shipped wilson@1
 * shape" degradation path in `page.tsx`. */
function pairedComparisonView(comparison: ComparisonFixture) {
  const base = reportedView();
  const pairedMethod = { id: "jinn.benchmarking.method/paired-delta", version: "1", parameters: { verdictRule: "sole", baseline: "baseline", candidate: "candidate", alpha: "0.05" } };
  return {
    ...base,
    results: {
      ...base.results,
      result: {
        ...base.results.result,
        report: {
          ...base.results.result.report,
          record: {
            ...base.results.result.report.record,
            method: pairedMethod,
            results: {
              perSubject: [{
                subjectSha256: matrixSha256,
                results: {
                  pairs: comparison.pairs,
                  delta: comparison.delta,
                  interval: comparison.interval,
                  reasons: comparison.reasons,
                  pairing: { taskDigests: [] },
                  clustering: { basis: "provenance", clusters: comparison.pairs > 0 ? 2 : 0 },
                  excluded: { count: 0, cellKeys: [] },
                  conflicted: { count: 0, cellKeys: [] },
                  bootstrap: {},
                },
              }],
            },
          },
          claimPackage: {
            ...base.results.result.report.claimPackage,
            method: { ...pairedMethod, preregistered: true },
            headline: undefined,
            comparison,
          },
        },
      },
    },
  };
}

const STORED_REPORT_WILSON_SHAPE_ALERT = "Stored Report results cannot be presented as the shipped wilson@1 shape. Run verification.";

describe("paired claim rendering (P4b Task 7)", () => {
  beforeEach(() => loadResultsViewMock.mockReset());

  test("renders a paired claim's comparison block with pairs, delta, and interval bounds when the interval is present", async () => {
    loadResultsViewMock.mockReturnValue(pairedComparisonView({
      pairs: 5,
      delta: "0.1200",
      interval: { alpha: "0.05", low: "0.0200", high: "0.2200" },
      reasons: [],
    }));
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Paired comparison");
    expect(markup).toContain('<dt class="font-medium">Pairs</dt><dd>5</dd>');
    expect(markup).toContain("0.1200");
    expect(markup).toContain("0.0200");
    expect(markup).toContain("0.2200");
    expect(markup).toContain("0.05");
    expect(markup).not.toContain("Interval withheld");
    // No directional sentence: which arm the delta favors, if any, is not stated on this branch.
    expect(markup).not.toMatch(/wins|beats|outperform|superior|better arm/i);
    // The existing stored-Report degradation path still fires for the paired shape.
    expect(markup).toContain(STORED_REPORT_WILSON_SHAPE_ALERT);
    expect(markup).not.toContain("Wilson interval");
  });

  test("renders a paired claim's withheld interval with both reason strings, and still shows the delta", async () => {
    loadResultsViewMock.mockReturnValue(pairedComparisonView({
      pairs: 3,
      delta: "0.1000",
      interval: null,
      reasons: ["fewer than five paired tasks", "fewer than two provenance clusters"],
    }));
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Paired comparison");
    expect(markup).toContain('<dt class="font-medium">Pairs</dt><dd>3</dd>');
    expect(markup).toContain("0.1000");
    expect(markup).toContain("Interval withheld");
    expect(markup).toContain("fewer than five paired tasks");
    expect(markup).toContain("fewer than two provenance clusters");
    expect(markup).toContain(STORED_REPORT_WILSON_SHAPE_ALERT);
  });

  test("renders a paired claim's zero-pairs state with no delta value, no interval bounds, and no crash", async () => {
    loadResultsViewMock.mockReturnValue(pairedComparisonView({
      pairs: 0,
      delta: null,
      interval: null,
      reasons: [],
    }));
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Paired comparison");
    expect(markup).toContain('<dt class="font-medium">Pairs</dt><dd>0</dd>');
    expect(markup).toContain("Interval withheld");
    expect(markup).toContain("No withheld reasons recorded.");
    expect(markup).not.toContain("Interval low");
    expect(markup).not.toContain("0.1200");
    expect(markup).not.toContain("0.1000");
    expect(markup).toContain(STORED_REPORT_WILSON_SHAPE_ALERT);
  });
});

describe("semantic results and report surface", () => {
  beforeEach(() => loadResultsViewMock.mockReset());

  test("renders Matrix, Report, claim, and verification facts without a rich-result JSON dump", async () => {
    loadResultsViewMock.mockReturnValue(reportedView());
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Results and report");
    expect(markup).toContain(matrixSha256);
    expect(markup).toContain("partial");
    expect(markup).toContain("Expected");
    expect(markup).toContain("Judged");
    expect(markup).toContain("Floor");
    expect(markup).toContain("candidate has more expired cells than baseline");
    expect(markup).toContain("Attrition by arm");
    expect(markup).toContain("All sealed Matrix cells");
    expect(markup).toContain("baseline:1:task");
    expect(markup).toContain("pass");
    expect(markup).toContain("fail");
    expect(markup).toContain("Valid verdict reference");
    expect(markup).toContain("Rejected verdict reference");
    expect(markup).toContain("infrastructure");
    expect(markup).toContain("launcher stopped");
    expect(markup).toContain("model evidence absent");
    expect(markup).toContain("The operator controls execution and evaluation.");

    expect(markup).toContain(reportSha256);
    expect(markup).toContain(envelopeSha256);
    expect(markup).toContain("jinn.benchmarking.method/wilson");
    expect(markup).toContain("Preregistered");
    expect(markup).toContain("Claim package");
    expect(markup).toContain("Claim scope arms and pinning");
    expect(markup).toContain("Stored claim completeness");
    expect(markup).toContain("Stored claim attrition");
    expect(markup).toContain("Stored claim per-subject disclosures");
    expect(markup).toContain("Stored claim venue honesty");
    expect(markup).toContain("Stored report per-subject disclosures");
    expect(markup).toContain("Stored Report results");
    expect(markup).toContain("Stored Report headline by arm");
    expect(markup).toContain("Stored Report conflicted cells");
    expect(markup).toContain("0.2500");
    expect(markup).toContain("report-only-conflict-");
    expect(markup).toContain("benchmark-product.claim-package/1");
    expect(markup).toContain("0.2065");
    expect(markup).toContain("1.0000");
    expect(markup).toContain("direct-check");
    expect(markup).toContain("Agent-distinctness is not party-independence.");
    expect(markup).toContain("Preview count");
    expect(markup).toContain("colophon bundle verify");
    expect(markup).toContain("colophon verify --workspace");
    expect(markup).toContain("Workspace-local report key.");
    expect(markup).toContain("Run verification before relying on the signature.");
    expect(markup).toContain("Verify records");
    expect(markup).toContain("Publish public bundle");
    expect(markup).toContain("Requires authority");
    expect(markup).not.toContain("<pre");
  });

  test("contains wide tables locally and places product attribution only in the verification landmark", async () => {
    loadResultsViewMock.mockReturnValue(reportedView());
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).toContain("break-words");
    expect(markup).toContain("w-max min-w-full");
    const verificationStart = markup.indexOf('aria-labelledby="verification-heading"');
    expect(verificationStart).toBeGreaterThan(0);
    expect(markup.slice(verificationStart)).toContain(PRODUCT_BRANDING.attribution);
    expect(markup.slice(0, verificationStart)).not.toContain(PRODUCT_BRANDING.attribution);
  });

  test("persistently renders the published bundle identity, relative path, and named checks after reload", async () => {
    const view = reportedView();
    view.draft.result.draft.state = "published-bundle";
    Object.assign(view.results.result, {
      publication: {
        identity: "9".repeat(64),
        relativePath: `artifacts/draft-1/public-bundles/${"9".repeat(64)}`,
        publishedAt: "2026-08-07T01:00:00.000Z",
        checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      },
    });
    loadResultsViewMock.mockReturnValue(view);
    const markup = renderToStaticMarkup(await ResultsPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("Published public bundle");
    expect(markup).toContain("9".repeat(64));
    expect(markup).toContain(`artifacts/draft-1/public-bundles/${"9".repeat(64)}`);
    expect(markup).toContain("evidence-closure");
    expect(markup).toContain("Verify published bundle");
  });
});
