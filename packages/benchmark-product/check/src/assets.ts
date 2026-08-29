import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";
import { validateBinaryInstrumentQualificationProjection } from "@jinn-network/benchmarking-aggregate";
import type { MatrixRecord, ReportRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { PRODUCT_BRANDING } from "./profile/branding.js";
import { COLOPHON_MARK_SVG } from "./profile/branding-assets.js";
import type { ClaimPackage } from "./profile/claim.js";
import type { PublicComparisonCell, PublicComparisonView } from "./comparison.js";

export interface PublicAssetInput {
  readonly claim: ClaimPackage;
  readonly matrix: MatrixRecord;
  readonly report: ReportRecord;
  readonly reportSha256: string;
  readonly matrixSha256: string;
  /** Canonically sorted identities for every authenticated `records/<sha>.bin` closure member. */
  readonly recordSha256s: readonly string[];
  readonly dissentCellKeys: readonly string[];
  /** Verifier-derived, authenticated human projection. Absent only for legacy bundle assets. */
  readonly comparison?: PublicComparisonView;
  /** Producer-verified binary admission/instrument facts. Required for claim-package/2 only. */
  readonly binaryQualification?: {
    readonly publicationGrade: boolean;
    readonly truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
    readonly sourceManifestSha256: string;
    readonly admissionManifestSha256: string;
    readonly exclusions: readonly unknown[];
    readonly instruments: readonly {
      armId: string;
      instrumentSha256: string;
      promptTemplateSha256: string;
    }[];
  };
}

interface WilsonArmFact {
  readonly armId: string;
  readonly n: number;
  readonly passRate: string;
  readonly low: string;
  readonly high: string;
}

interface WilsonFacts {
  readonly kind: "wilson";
  readonly arms: readonly WilsonArmFact[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/**
 * paired-delta@1's rendering-relevant projection (P4b Task 6), sibling to `WilsonFacts`. A narrow
 * subset of the method's full `comparison` output (`report/claim.ts`'s `ComparisonSchema`) --
 * only what a public bundle asset actually presents: pairs, delta, interval-or-withheld-reasons,
 * and the shared `conflicted` block every method carries.
 */
interface ComparisonFacts {
  readonly kind: "comparison";
  readonly baseline: string;
  readonly candidate: string;
  readonly alpha: string;
  readonly pairs: number;
  readonly delta: string | null;
  readonly interval: { readonly alpha: string; readonly low: string; readonly high: string } | null;
  readonly reasons: readonly string[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

interface BinaryFacts {
  readonly kind: "binary";
  readonly qualification: {
    readonly configuration: Record<string, unknown>;
    readonly arms: Record<string, Record<string, unknown>>;
    readonly itemDecisions: readonly unknown[];
    readonly excluded: { readonly count: number; readonly items: readonly unknown[] };
    readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
  };
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/**
 * `pairwise-disagreement@1`'s rendering projection (packet #2837, spec §7.1), sibling to
 * `ComparisonFacts`. A panel readout, not a chosen pair: it carries every unordered arm pair the
 * method computed in one pass, so there is no baseline/candidate here. Intervals are keyed
 * `{lower, upper, alpha}`, which is this method family's own spelling and NOT `paired-delta@1`'s
 * `{low, high}`.
 */
interface PairwiseDisagreementFacts {
  readonly kind: "pairwise-disagreement";
  readonly pairs: readonly {
    readonly armA: string;
    readonly armB: string;
    readonly n: number;
    readonly disagreements: number;
    readonly rate: string | null;
    readonly interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null;
  }[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/**
 * `paired-majority-delta@1`'s rendering projection (packet #2837, spec §7.2a), sibling to
 * `ComparisonFacts`. `candidate` is the evidence-declaring arm and `baseline` its evidence-free
 * twin, so a positive `delta` means declaring evidence increased agreement.
 */
interface PairedMajorityDeltaFacts {
  readonly kind: "paired-majority-delta";
  readonly baseline: string;
  readonly candidate: string;
  readonly n: number;
  readonly delta: string | null;
  readonly interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null;
  readonly reasons: readonly string[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/** What every method branch below must produce for asset rendering. Discriminated by `kind` so
 * the render helpers can narrow rather than re-check shape. */
type MethodFacts =
  | WilsonFacts
  | ComparisonFacts
  | BinaryFacts
  | PairwiseDisagreementFacts
  | PairedMajorityDeltaFacts;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const require = createRequire(import.meta.url);

function embeddedFont(packagePath: string): string {
  return readFileSync(require.resolve(packagePath)).toString("base64");
}

const NEWSREADER_FONT = embeddedFont("@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2");
const PUBLIC_SANS_FONT = embeddedFont("@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2");
const IBM_PLEX_MONO_FONT = embeddedFont("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2");
const COLOPHON_MARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(COLOPHON_MARK_SVG).toString("base64")}`;
const FONT_LICENSES = [
  ["Newsreader", "@fontsource-variable/newsreader/LICENSE"],
  ["Public Sans", "@fontsource-variable/public-sans/LICENSE"],
  ["IBM Plex Mono", "@fontsource/ibm-plex-mono/LICENSE"],
] as const;

function embeddedFontCss(): string {
  return `@font-face{font-family:"Newsreader";font-style:normal;font-weight:200 800;font-display:swap;src:url(data:font/woff2;base64,${NEWSREADER_FONT}) format("woff2")}@font-face{font-family:"Public Sans";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${PUBLIC_SANS_FONT}) format("woff2")}@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${IBM_PLEX_MONO_FONT}) format("woff2")}`;
}

function visibleControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
  );
}

function escapeMarkup(value: string): string {
  return visibleControls(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oneLine(value: string): string {
  return visibleControls(value).replace(/\s+/gu, " ").trim();
}

function escapeMarkdown(value: string): string {
  return oneLine(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\[\]()*_`|#!])/gu, "\\$1")
    .replace(/(https?):\/\//giu, "$1\\://");
}

function escapeMarkdownCode(value: string): string {
  return visibleControls(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/(https?):\/\//giu, "$1\\://");
}

function plainText(value: string): string {
  return oneLine(value).replace(/(https?):\/\//giu, "$1:\\/\\/");
}

function canonicalText(value: unknown): string {
  return decoder.decode(canonicalJsonBytes(value));
}

function boundedVisual(value: string, maximumCodePoints: number): string {
  const points = Array.from(oneLine(value));
  return points.length <= maximumCodePoints ? points.join("") : `${points.slice(0, maximumCodePoints - 1).join("")}…`;
}

function recordPaths(input: PublicAssetInput): readonly string[] {
  const expected = [...input.recordSha256s].sort();
  if (
    input.recordSha256s.length !== new Set(input.recordSha256s).size
    || input.recordSha256s.some((sha256) => !SHA256_HEX.test(sha256))
    || input.recordSha256s.some((sha256, index) => sha256 !== expected[index])
  ) {
    throw new Error("public assets require unique, canonically sorted record identities");
  }
  return input.recordSha256s.map((sha256) => `records/${sha256}.bin`);
}

/** Every method this product wires publishes its single Matrix subject's results at this fixed
 * path -- mirrors `report/claim.ts`'s `singleSubjectResults`; the wrapper itself is
 * method-agnostic, only what's inside `results` differs by method. */
function singleSubjectResults(value: unknown, label: string): unknown {
  const results = value as { readonly perSubject?: readonly { readonly results?: unknown }[] } | undefined;
  if (results?.perSubject?.length !== 1) {
    throw new Error(`${label}: expected exactly one subject (this product's single-Matrix Report shape)`);
  }
  return results.perSubject[0]?.results;
}

/** wilson@1's per-arm facts projection. A narrow, local shape check -- deliberately not a general
 * Method-results parser; a mismatch here means the sealed Report was not produced by wilson@1. */
function wilsonProjection(subjectResults: unknown, label: string): WilsonFacts {
  const shape = subjectResults as {
    readonly arms?: Record<string, {
      readonly n?: unknown;
      readonly passRate?: unknown;
      readonly wilsonInterval?: { readonly low?: unknown; readonly high?: unknown };
    }>;
    readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
  } | undefined;
  if (shape?.arms === undefined || shape.conflicted === undefined) {
    throw new Error(`${label}: expected wilson@1's arms/conflicted shape`);
  }
  const arms = Object.entries(shape.arms).map(([armId, arm]) => {
    if (
      typeof arm.n !== "number"
      || typeof arm.passRate !== "string"
      || typeof arm.wilsonInterval?.low !== "string"
      || typeof arm.wilsonInterval.high !== "string"
    ) {
      throw new Error(`${label}: arm ${armId} lacks exact wilson@1 facts`);
    }
    return { armId, n: arm.n, passRate: arm.passRate, low: arm.wilsonInterval.low, high: arm.wilsonInterval.high };
  });
  if (typeof shape.conflicted.count !== "number" || !Array.isArray(shape.conflicted.cellKeys)) {
    throw new Error(`${label}: conflicted facts are invalid`);
  }
  return {
    kind: "wilson",
    arms,
    conflicted: {
      count: shape.conflicted.count,
      cellKeys: shape.conflicted.cellKeys.map((value) => String(value)),
    },
  };
}

/** paired-delta@1's comparison facts projection (P4b Task 6), sibling to `wilsonProjection`. Same
 * narrow, local-shape-check posture: a mismatch here means the sealed Report was not produced by
 * paired-delta@1. Mirrors `report/claim.ts`'s `comparisonProjection`, narrowed to only the fields
 * a public bundle asset presents. */
function comparisonProjection(
  subjectResults: unknown,
  parameters: unknown,
  label: string,
): ComparisonFacts {
  const shape = subjectResults as {
    readonly pairs?: unknown;
    readonly delta?: unknown;
    readonly interval?: { readonly alpha?: unknown; readonly low?: unknown; readonly high?: unknown } | null;
    readonly reasons?: unknown;
    readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
  } | undefined;
  const parameterShape = parameters as {
    readonly baseline?: unknown;
    readonly candidate?: unknown;
    readonly alpha?: unknown;
  } | undefined;
  if (
    typeof shape?.pairs !== "number"
    || !(typeof shape.delta === "string" || shape.delta === null)
    || !Array.isArray(shape.reasons)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
    || !(
      shape.interval === null
      || (
        typeof shape.interval?.alpha === "string"
        && typeof shape.interval.low === "string"
        && typeof shape.interval.high === "string"
      )
    )
    || typeof parameterShape?.baseline !== "string"
    || typeof parameterShape.candidate !== "string"
    || typeof parameterShape.alpha !== "string"
    || !["0.10", "0.05", "0.01"].includes(parameterShape.alpha)
  ) {
    throw new Error(`${label}: expected paired-delta@1's pairs/delta/interval/reasons/conflicted shape`);
  }
  return {
    kind: "comparison",
    baseline: parameterShape.baseline,
    candidate: parameterShape.candidate,
    alpha: Number(parameterShape.alpha).toFixed(4),
    pairs: shape.pairs,
    delta: shape.delta,
    interval: shape.interval === null ? null : { alpha: shape.interval.alpha as string, low: shape.interval.low as string, high: shape.interval.high as string },
    reasons: shape.reasons.map((value) => String(value)),
    conflicted: {
      count: shape.conflicted.count,
      cellKeys: shape.conflicted.cellKeys.map((value) => String(value)),
    },
  };
}

function judgeInterval(value: unknown, label: string): { readonly lower: string; readonly upper: string; readonly alpha: string } | null {
  if (value === null || value === undefined) return null;
  const shape = value as { readonly lower?: unknown; readonly upper?: unknown; readonly alpha?: unknown };
  if (typeof shape.lower !== "string" || typeof shape.upper !== "string" || typeof shape.alpha !== "string") {
    throw new Error(`${label}: expected a {lower, upper, alpha} interval`);
  }
  return { lower: shape.lower, upper: shape.upper, alpha: shape.alpha };
}

/** `pairwise-disagreement@1`'s asset projection (packet #2837), sibling to `comparisonProjection`.
 * Narrow local shape check, same posture as its siblings: a mismatch means the sealed Report was
 * not produced by this method. */
function pairwiseDisagreementAssetProjection(subjectResults: unknown, label: string): PairwiseDisagreementFacts {
  const shape = subjectResults as {
    readonly pairs?: unknown;
    readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
  } | undefined;
  if (
    !Array.isArray(shape?.pairs)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
  ) {
    throw new Error(`${label}: expected pairwise-disagreement@1's pairs/conflicted shape`);
  }
  const pairs = shape.pairs.map((entry) => {
    const pair = entry as {
      readonly armA?: unknown; readonly armB?: unknown; readonly n?: unknown;
      readonly disagreements?: unknown; readonly rate?: unknown; readonly interval?: unknown;
    };
    if (
      typeof pair.armA !== "string" || typeof pair.armB !== "string"
      || typeof pair.n !== "number" || typeof pair.disagreements !== "number"
      || !(typeof pair.rate === "string" || pair.rate === null)
    ) {
      throw new Error(`${label}: expected pairwise-disagreement@1's per-pair armA/armB/n/disagreements/rate shape`);
    }
    return {
      armA: pair.armA, armB: pair.armB, n: pair.n, disagreements: pair.disagreements,
      rate: pair.rate as string | null, interval: judgeInterval(pair.interval, label),
    };
  });
  return {
    kind: "pairwise-disagreement",
    pairs,
    conflicted: {
      count: shape.conflicted.count,
      cellKeys: shape.conflicted.cellKeys.map((value) => String(value)),
    },
  };
}

/** `paired-majority-delta@1`'s asset projection (packet #2837), sibling to `comparisonProjection`.
 * `baseline`/`candidate` come from the method's own output here (unlike `paired-delta@1`, which
 * reads them from the sealed parameters) because this method DERIVES its pair rather than
 * accepting one. */
function pairedMajorityDeltaAssetProjection(subjectResults: unknown, label: string): PairedMajorityDeltaFacts {
  const shape = subjectResults as {
    readonly baseline?: unknown; readonly candidate?: unknown; readonly n?: unknown;
    readonly delta?: unknown; readonly interval?: unknown; readonly reasons?: unknown;
    readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
  } | undefined;
  if (
    typeof shape?.baseline !== "string" || typeof shape.candidate !== "string"
    || typeof shape.n !== "number"
    || !(typeof shape.delta === "string" || shape.delta === null)
    || !Array.isArray(shape.reasons)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
  ) {
    throw new Error(`${label}: expected paired-majority-delta@1's baseline/candidate/n/delta/reasons/conflicted shape`);
  }
  return {
    kind: "paired-majority-delta",
    baseline: shape.baseline,
    candidate: shape.candidate,
    n: shape.n,
    delta: shape.delta as string | null,
    interval: judgeInterval(shape.interval, label),
    reasons: shape.reasons.map((value) => String(value)),
    conflicted: {
      count: shape.conflicted.count,
      cellKeys: shape.conflicted.cellKeys.map((value) => String(value)),
    },
  };
}

/** Dispatches on the produced method (P4b Task 6) -- mirrors `report/claim.ts`'s
 * `methodProjection`, so the two dispatches read as one pattern. Any method this product has not
 * wired an asset projection for throws rather than silently rendering incomplete facts. */
function methodProjection(
  value: unknown,
  method: { readonly id: string; readonly parameters: unknown },
  label: string,
): MethodFacts {
  const subjectResults = singleSubjectResults(value, label);
  switch (method.id) {
    case BENCHMARKING_METHOD_IDS.wilson:
      return wilsonProjection(subjectResults, label);
    case BENCHMARKING_METHOD_IDS.pairedDelta:
      return comparisonProjection(subjectResults, method.parameters, label);
    case BENCHMARKING_METHOD_IDS.binaryInstrument: {
      const validation = validateBinaryInstrumentQualificationProjection(subjectResults);
      if (!validation.ok) throw new Error(`${label}: invalid binary qualification: ${validation.issues.join("; ")}`);
      const qualification = subjectResults as BinaryFacts["qualification"];
      return { kind: "binary", qualification, conflicted: qualification.conflicted };
    }
    case BENCHMARKING_METHOD_IDS.pairwiseDisagreement:
      return pairwiseDisagreementAssetProjection(subjectResults, label);
    case BENCHMARKING_METHOD_IDS.pairedMajorityDelta:
      return pairedMajorityDeltaAssetProjection(subjectResults, label);
    default:
      throw new Error(`${label}: method "${method.id}" has no bundle-asset projection`);
  }
}

function outcomeLabel(outcome: MatrixRecord["completeness"]["runOutcome"]): string {
  if (outcome === "complete") return "Complete comparison";
  if (outcome === "partial") return "Partial comparison";
  return "Cancelled comparison";
}

function qualificationOutcomeLabel(outcome: MatrixRecord["completeness"]["runOutcome"]): string {
  if (outcome === "complete") return "Complete qualification";
  if (outcome === "partial") return "Partial qualification";
  return "Cancelled qualification";
}

function scopeLine(input: PublicAssetInput): string {
  return `${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${input.claim.scope.venue}`;
}

function adverseFacts(input: PublicAssetInput, reportFacts: MethodFacts): readonly string[] {
  const facts: string[] = [];
  if (input.matrix.completeness.runOutcome !== "complete") facts.push(`Matrix: ${reportFacts.kind === "binary" ? qualificationOutcomeLabel(input.matrix.completeness.runOutcome) : outcomeLabel(input.matrix.completeness.runOutcome)}; incomplete cells remain accounted below.`);
  if (reportFacts.conflicted.count > 0) facts.push(`Report conflicted cells: ${reportFacts.conflicted.count}.`);
  if (input.claim.conflicted.count > 0) facts.push(`Claim conflicted cells: ${input.claim.conflicted.count}.`);
  if (input.dissentCellKeys.length > 0) facts.push(`Verification assembly dissenting cells: ${input.dissentCellKeys.length}.`);
  if (input.matrix.attrition.asymmetryFlags.length > 0) facts.push(`Matrix asymmetry flags: ${input.matrix.attrition.asymmetryFlags.length}.`);
  if ((input.report.limitations ?? []).length > 0) facts.push(`Report limitations: ${input.report.limitations!.length}; read every limitation below.`);
  if (input.claim.limitations.length > 0) facts.push(`Claim limitations: ${input.claim.limitations.length}; read every limitation below.`);
  if (facts.length === 0) facts.push("No conflicts, dissent, asymmetry flags, or stated limitations.");
  return facts;
}

function list(items: readonly string[], empty: string): string {
  if (items.length === 0) return `<p>${escapeMarkup(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeMarkup(item)}</li>`).join("")}</ul>`;
}

function armRows(facts: WilsonFacts): string {
  return facts.arms.map((arm) =>
    `<tr><th scope="row">${escapeMarkup(arm.armId)}</th><td>${arm.n}</td><td>${escapeMarkup(arm.passRate)}</td><td>${escapeMarkup(arm.low)}</td><td>${escapeMarkup(arm.high)}</td></tr>`
  ).join("");
}

function armResultTable(facts: WilsonFacts, caption: string): string {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeMarkup(caption)}"><table><caption>${escapeMarkup(caption)}</caption><thead><tr><th scope="col">Arm</th><th scope="col">n</th><th scope="col">Pass rate</th><th scope="col">Interval low</th><th scope="col">Interval high</th></tr></thead><tbody>${armRows(facts)}</tbody></table></div>`;
}

/** Operator-approved P4b copy. The order is part of the public reading contract: direction,
 * estimate, interval status, exact alpha, then the number of paired Tasks. */
function pairedEstimateLine(facts: ComparisonFacts): string {
  const estimate = facts.delta === null ? "unavailable" : facts.delta;
  const interval = facts.interval === null
    ? "withheld"
    : `${facts.interval.low} to ${facts.interval.high}`;
  return `Candidate minus baseline estimate (${facts.candidate} minus ${facts.baseline}): ${estimate}. Interval: ${interval}. Alpha: ${facts.alpha}. Paired task count: ${facts.pairs}.`;
}

/** `paired-majority-delta@1`'s counterpart to `pairedEstimateLine`. Same reading order (direction,
 * estimate, interval status, alpha, paired count) so the two estimators read alike, but written
 * against this method's own field spellings: `lower`/`upper` rather than `low`/`high`, `n` rather
 * than `pairs`, and the alpha carried on the interval rather than alongside it. `candidate` is the
 * evidence-declaring arm and `baseline` its evidence-free twin. */
function pairedMajorityDeltaEstimateLine(facts: PairedMajorityDeltaFacts): string {
  const estimate = facts.delta === null ? "unavailable" : facts.delta;
  const interval = facts.interval === null ? "withheld" : `${facts.interval.lower} to ${facts.interval.upper}`;
  const alpha = facts.interval === null ? "not stated" : facts.interval.alpha;
  return `Candidate minus baseline estimate (${facts.candidate} minus ${facts.baseline}): ${estimate}. Interval: ${interval}. Alpha: ${alpha}. Paired task count: ${facts.n}.`;
}

/** Full-report (unbounded) rendering of paired-delta@1 facts: pairs, delta, and either the
 * interval bounds or -- when withheld -- every reason string, in full (no truncation budget
 * applies on this surface, unlike the compact assets below). */
function comparisonFactsHtml(facts: ComparisonFacts): string {
  const intervalHtml = facts.interval === null
    ? `<p>Interval withheld.</p>${list(facts.reasons, "No withheld reason recorded.")}`
    : `<dl class="facts"><div><dt>Interval low</dt><dd>${escapeMarkup(facts.interval.low)}</dd></div><div><dt>Interval high</dt><dd>${escapeMarkup(facts.interval.high)}</dd></div><div><dt>Alpha</dt><dd>${escapeMarkup(facts.alpha)}</dd></div></dl>`;
  return `<p class="paired-estimate">${escapeMarkup(pairedEstimateLine(facts))}</p><dl class="facts"><div><dt>Paired task count</dt><dd>${facts.pairs}</dd></div><div><dt>Candidate minus baseline estimate</dt><dd>${facts.delta === null ? "—" : escapeMarkup(facts.delta)}</dd></div></dl>${intervalHtml}`;
}

function judgeIntervalHtml(
  interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null,
  reasons: readonly string[],
): string {
  return interval === null
    ? `<p>Interval withheld.</p>${list(reasons, "No withheld reason recorded.")}`
    : `<dl class="facts"><div><dt>Interval lower</dt><dd>${escapeMarkup(interval.lower)}</dd></div><div><dt>Interval upper</dt><dd>${escapeMarkup(interval.upper)}</dd></div><div><dt>Alpha</dt><dd>${escapeMarkup(interval.alpha)}</dd></div></dl>`;
}

/** Renders every unordered arm pair the panel readout computed. No comparative winner is stated:
 * the method carries no chosen pair and this asset must not invent one. */
function pairwiseDisagreementFactsHtml(facts: PairwiseDisagreementFacts): string {
  if (facts.pairs.length === 0) return "<p>No arm pairs were computed.</p>";
  const rows = facts.pairs.map((pair) =>
    `<tr><th scope="row">${escapeMarkup(pair.armA)} vs ${escapeMarkup(pair.armB)}</th><td>${pair.n}</td><td>${pair.disagreements}</td><td>${pair.rate === null ? "—" : escapeMarkup(pair.rate)}</td><td>${pair.interval === null ? "withheld" : `${escapeMarkup(pair.interval.lower)} – ${escapeMarkup(pair.interval.upper)}`}</td></tr>`
  ).join("");
  return `<table><caption>Exact pairwise-disagreement@1 values from the sealed Report</caption><thead><tr><th scope="col">Arm pair</th><th scope="col">n</th><th scope="col">Disagreements</th><th scope="col">Rate</th><th scope="col">Interval</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pairedMajorityDeltaFactsHtml(facts: PairedMajorityDeltaFacts): string {
  return `<dl class="facts"><div><dt>Candidate (evidence-declaring arm)</dt><dd>${escapeMarkup(facts.candidate)}</dd></div><div><dt>Baseline (evidence-free twin)</dt><dd>${escapeMarkup(facts.baseline)}</dd></div><div><dt>Paired task count</dt><dd>${facts.n}</dd></div><div><dt>Candidate minus baseline estimate</dt><dd>${facts.delta === null ? "—" : escapeMarkup(facts.delta)}</dd></div></dl>${judgeIntervalHtml(facts.interval, facts.reasons)}`;
}

/** The projection is already validated at :294 (validateBinaryInstrumentQualificationProjection),
 * so `configuration["strata"]` is a sealed, non-empty, sorted-unique, grammar-conforming array. */
function stratumCaption(configuration: Record<string, unknown>): string {
  const strata = Array.isArray(configuration["strata"])
    ? (configuration["strata"] as readonly unknown[])
        .filter((value): value is string => typeof value === "string")
    : [];
  return `Buckets by stratum (${strata.join(", ")})`;
}

function binaryFactsHtml(facts: BinaryFacts): string {
  const caption = stratumCaption(facts.qualification.configuration);
  const arms = Object.entries(facts.qualification.arms).map(([armId, arm]) => {
    const rates = ["agreement", "falseAccept", "falseReject", "instability", "parserInvalid"]
      .map((name) => `<tr><th scope="row">${escapeMarkup(name)}</th><td><pre>${escapeMarkup(canonicalText(arm[name]))}</pre></td></tr>`)
      .join("");
    return `<section class="binary-arm"><h3>${escapeMarkup(armId)}</h3><p>Instrument <span class="digest">${escapeMarkup(String(arm["instrumentSha256"]))}</span></p><h4>Item, call, and confusion denominators</h4><pre>${escapeMarkup(canonicalText({ item: arm["item"], call: arm["call"], confusion: arm["confusion"] }))}</pre><div class="table-scroll" tabindex="0" role="region" aria-label="${escapeMarkup(armId)} qualification rates"><table><caption>Five registered rates with exact denominators and Wilson intervals</caption><thead><tr><th scope="col">Rate</th><th scope="col">Registered result</th></tr></thead><tbody>${rates}</tbody></table></div><h4>Every candidate-class bucket</h4><pre>${escapeMarkup(canonicalText(arm["byCandidateClass"]))}</pre><h4>${escapeMarkup(caption)}</h4><pre>${escapeMarkup(canonicalText(arm["byStratum"]))}</pre></section>`;
  }).join("");
  return `<p class="neutral">Qualification facts are presented per instrument without comparative conclusions.</p><h3>Registered configuration</h3><pre>${escapeMarkup(canonicalText(facts.qualification.configuration))}</pre>${arms}<h3>Per-item decisions and instability</h3><pre>${escapeMarkup(canonicalText(facts.qualification.itemDecisions))}</pre><h3>Parser-invalid, infrastructure, and other exclusions</h3><pre>${escapeMarkup(canonicalText(facts.qualification.excluded))}</pre>`;
}

/** Dispatches the arm/comparison facts block on `facts.kind` (P4b Task 6). The wilson branch is
 * byte-identical to before this dispatch existed -- `armResultTable` itself is untouched. */
function armResultsHtml(facts: MethodFacts, wilsonCaption: string): string {
  if (facts.kind === "wilson") return armResultTable(facts, wilsonCaption);
  if (facts.kind === "comparison") return comparisonFactsHtml(facts);
  if (facts.kind === "pairwise-disagreement") return pairwiseDisagreementFactsHtml(facts);
  if (facts.kind === "paired-majority-delta") return pairedMajorityDeltaFactsHtml(facts);
  return binaryFactsHtml(facts);
}

function attritionRows(input: PublicAssetInput): string {
  return Object.entries(input.matrix.attrition.perArm).map(([armId, counts]) =>
    `<tr><th scope="row">${escapeMarkup(armId)}</th><td>${counts.expected}</td><td>${counts.judged}</td><td>${counts.unjudged}</td><td>${counts.unscorable}</td><td>${counts.expired}</td><td>${counts.invalidated}</td><td>${counts.excluded}</td><td>${counts.replacements}</td></tr>`
  ).join("");
}

function cellScore(cell: PublicComparisonCell): string {
  return cell.primaryScore === undefined
    ? "No primary score"
    : `${cell.primaryScore.value} ${cell.primaryScore.name} (${cell.primaryScore.direction})`;
}

function descriptiveComparisonHtml(comparison: PublicComparisonView): string {
  const fact = comparison.descriptiveComparison;
  if (fact === undefined) return '<p class="neutral">No paired descriptive measurement is available. No comparative winner is stated.</p>';
  return `<p class="neutral">Across ${fact.pairedCells} paired cells, ${escapeMarkup(fact.firstArm)} had lower ${fact.measurement} in ${fact.lowerByFirst}; ${escapeMarkup(fact.secondArm)} had lower ${fact.measurement} in ${fact.lowerBySecond}; ${fact.ties} tied. Lower is better. This is descriptive evidence, not a registered comparative winner.</p>`;
}

function comparisonMatrixHtml(comparison: PublicComparisonView): string {
  const header = comparison.arms.map((arm) => `<th scope="col">${escapeMarkup(arm)}</th>`).join("");
  const rows = comparison.tasks.map((task) => {
    const armCells = comparison.arms.map((arm) => {
      const cells = comparison.cells.filter((cell) => cell.taskDigest === task.digest && cell.armId === arm);
      if (cells.length === 0) return "<td>Not accounted</td>";
      return `<td>${cells.map((cell) => `<a href="index.html#cell-${escapeMarkup(cell.cellKey)}"><strong>${escapeMarkup(cell.outputSummary)}</strong><br>${escapeMarkup(cellScore(cell))}<br><span class="source-label">${escapeMarkup(cell.outcome)} · replicate ${cell.replicate}</span></a>`).join("<hr>")}</td>`;
    }).join("");
    return `<tr><th scope="row"><strong>${escapeMarkup(task.label)}</strong><br><span class="source-label">${escapeMarkup(task.summary)}</span></th>${armCells}</tr>`;
  }).join("");
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Authenticated task by arm comparison"><table class="comparison-table"><caption>Each configuration faced the same authenticated Tasks</caption><thead><tr><th scope="col">Task</th>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function comparisonCellDetailsHtml(comparison: PublicComparisonView): string {
  return comparison.cells.map((cell) => {
    const outputLinks = cell.outputs.map((output) => `<li><a href="index.html#records-heading">${escapeMarkup(output.name)}</a>: ${escapeMarkup(output.summary)} <span class="digest">${escapeMarkup(output.sha256)}</span></li>`).join("");
    const verdicts = cell.verdicts.map((verdict) => `<li><a href="index.html#records-heading">${escapeMarkup(verdict.evaluator)}</a>: ${escapeMarkup(verdict.verdict)}<pre>${escapeMarkup(canonicalText(verdict.measurements))}</pre></li>`).join("");
    return `<details id="cell-${escapeMarkup(cell.cellKey)}" class="cell-detail"><summary><strong>${escapeMarkup(cell.armId)}</strong> · Task ${escapeMarkup(cell.taskDigest.slice(0, 12))} · replicate ${cell.replicate} · ${escapeMarkup(cellScore(cell))}</summary><p>${escapeMarkup(cell.outputSummary)}</p><h4>Authenticated outputs</h4><ul>${outputLinks || "<li>No solve output.</li>"}</ul><h4>Authenticated verdict evidence</h4><ul>${verdicts || "<li>No verdict evidence.</li>"}</ul></details>`;
  }).join("");
}

function comparisonSectionHtml(comparison: PublicComparisonView | undefined): string {
  if (comparison === undefined) return "";
  const sampleDisclosure = comparison.sampleKind === "bundled-prediction"
    ? '<p class="sample-note">This bundled sample demonstrates the evidence path, not agent quality. Its outcomes are synthetic and derived from the sample consensus inputs. No comparative winner is stated.</p>'
    : "";
  return `<section id="comparison" aria-labelledby="comparison-heading"><p class="eyebrow">Answer first</p><h2 id="comparison-heading">What happened, task by task</h2>${descriptiveComparisonHtml(comparison)}${sampleDisclosure}${comparisonMatrixHtml(comparison)}<h3>Open a cell to inspect its evidence</h3>${comparisonCellDetailsHtml(comparison)}</section>`;
}

function comparisonSectionMarkdown(comparison: PublicComparisonView | undefined): string {
  if (comparison === undefined) return "";
  const fact = comparison.descriptiveComparison;
  const descriptive = fact === undefined
    ? "No paired descriptive measurement is available. No comparative winner is stated."
    : `Across ${fact.pairedCells} paired cells, ${escapeMarkdown(fact.firstArm)} had lower ${fact.measurement} in ${fact.lowerByFirst}; ${escapeMarkdown(fact.secondArm)} had lower ${fact.measurement} in ${fact.lowerBySecond}; ${fact.ties} tied. Lower is better. This is descriptive evidence, not a registered comparative winner.`;
  const sample = comparison.sampleKind === "bundled-prediction"
    ? "\n\nThis bundled sample demonstrates the evidence path, not agent quality. Its outcomes are synthetic and derived from the sample consensus inputs."
    : "";
  const tasks = comparison.tasks.map((task) => {
    const cells = comparison.cells.filter((cell) => cell.taskDigest === task.digest).map((cell) =>
      `  - **${escapeMarkdown(cell.armId)}**, replicate ${cell.replicate}: ${escapeMarkdown(cell.outputSummary)}; ${escapeMarkdown(cellScore(cell))}; outcome ${escapeMarkdown(cell.outcome)}. Task evidence \`${escapeMarkdownCode(task.evidencePath)}\`; outputs ${cell.outputs.map((output) => `\`${escapeMarkdownCode(output.evidencePath)}\``).join(", ") || "none"}; verdicts ${cell.verdicts.map((verdict) => `\`${escapeMarkdownCode(verdict.evidencePath)}\``).join(", ") || "none"}.`
    ).join("\n");
    return `- **${escapeMarkdown(task.label)}** — ${escapeMarkdown(task.summary)}\n${cells}`;
  }).join("\n");
  return `## What happened, task by task\n\n${descriptive}${sample}\n\n${tasks}\n\n`;
}

/**
 * Publication-grade wording, keyed on `truthAdmission` (spec §6.8a Group A; ruling C-5) rather
 * than the `publicationGrade` boolean alone. The boolean-keyed ternary this replaced printed the
 * literal words "Yes — two-human unanimous" for ANY publication-grade admission, and the
 * screened-operator-sampled branch is publication-grade under §6.8 -- so the old ternary would
 * have published a false two-human-unanimous claim for a screened bundle. The two existing
 * strings below keep their exact bytes (half of the byte-compatibility proof, spec §0.4); the
 * screened wording is frozen by ruling C-5 and passes §6.1's overclaim test: no "human", no
 * "unanimous", no "independent". It echoes the mode name so a reader can join it to the "Truth
 * admission" field rendered immediately below, and stays terse because the full disclosure is the
 * `screened-not-independently-labeled` limitation prose rendered in the limitations section.
 */
function publicationGradeWording(truthAdmission: NonNullable<PublicAssetInput["binaryQualification"]>["truthAdmission"]): {
  readonly html: string;
  readonly markdown: string;
} {
  switch (truthAdmission) {
    case "two-human-unanimous":
      return { html: "Yes — two-human unanimous", markdown: "yes — two-human unanimous" };
    case "operator-only":
      return { html: "No — operator-only", markdown: "no — operator-only" };
    case "screened-operator-sampled":
      return { html: "Yes — screened and operator-sampled", markdown: "yes — screened and operator-sampled" };
    default: {
      const exhaustive: never = truthAdmission;
      throw new Error(`unsupported truthAdmission ${String(exhaustive)}`);
    }
  }
}

export function binaryAdmissionHtml(input: PublicAssetInput): string {
  const admission = input.binaryQualification;
  if (admission === undefined) return "";
  return `<section id="qualification-admission" aria-labelledby="qualification-admission-heading"><h2 id="qualification-admission-heading">Authenticated truth admission and instruments</h2><dl class="facts"><div><dt>Publication grade</dt><dd>${publicationGradeWording(admission.truthAdmission).html}</dd></div><div><dt>Truth admission</dt><dd>${escapeMarkup(admission.truthAdmission)}</dd></div><div><dt>Source manifest</dt><dd class="digest">${escapeMarkup(admission.sourceManifestSha256)}</dd></div><div><dt>Admission manifest</dt><dd class="digest">${escapeMarkup(admission.admissionManifestSha256)}</dd></div><div><dt>Pre-run exclusions</dt><dd>${admission.exclusions.length}</dd></div></dl><h3>Human disagreement and deterministic replacements</h3><pre>${escapeMarkup(canonicalText(admission.exclusions))}</pre><h3>Exact instrument and prompt-template commitments</h3><pre>${escapeMarkup(canonicalText(admission.instruments))}</pre></section>`;
}

export function binaryAdmissionMarkdown(input: PublicAssetInput): string {
  const admission = input.binaryQualification;
  if (admission === undefined) return "";
  return `## Authenticated truth admission and instruments\n\n- Publication grade: ${publicationGradeWording(admission.truthAdmission).markdown}\n- Truth admission: ${escapeMarkdown(admission.truthAdmission)}\n- Source manifest: ${escapeMarkdown(admission.sourceManifestSha256)}\n- Admission manifest: ${escapeMarkdown(admission.admissionManifestSha256)}\n- Pre-run exclusions: ${admission.exclusions.length}\n\n### Human disagreement and deterministic replacements\n\n    ${escapeMarkdownCode(canonicalText(admission.exclusions))}\n\n### Exact instrument and prompt-template commitments\n\n    ${escapeMarkdownCode(canonicalText(admission.instruments))}\n\n`;
}

function factsHeading(facts: MethodFacts, source: "report" | "claim"): string {
  if (facts.kind === "wilson") return source === "report" ? "Sealed Report arm results" : "Stored claim mirror";
  if (facts.kind === "comparison") return source === "report" ? "Sealed Report paired comparison" : "Stored paired claim mirror";
  if (facts.kind === "pairwise-disagreement") {
    return source === "report" ? "Sealed Report pairwise disagreement panel" : "Stored pairwise disagreement mirror";
  }
  if (facts.kind === "paired-majority-delta") {
    return source === "report" ? "Sealed Report evidence contrast" : "Stored evidence contrast mirror";
  }
  return source === "report" ? "Sealed binary qualification" : "Stored binary qualification";
}

/** The one neutral sentence each method's index page leads with. Every method needs its own: the
 * fallthrough used to be binary-instrument's sentence, so a method added without a branch here
 * would have published "Verified binary-instrument qualification" over a judge readout. */
function neutralClaimHtml(facts: MethodFacts): string {
  if (facts.kind === "wilson") {
    return '<p class="neutral">No comparative winner is stated; wilson@1 reports neutral per-arm facts only.</p>';
  }
  if (facts.kind === "comparison") {
    return `<p class="neutral">${escapeMarkup(pairedEstimateLine(facts))}</p>`;
  }
  if (facts.kind === "paired-majority-delta") {
    return `<p class="neutral">${escapeMarkup(pairedMajorityDeltaEstimateLine(facts))}</p>`;
  }
  if (facts.kind === "pairwise-disagreement") {
    return '<p class="neutral">No comparative winner is stated; pairwise-disagreement@1 reports every unordered arm pair as a panel, with no baseline and no candidate.</p>';
  }
  return '<p class="neutral">Verified binary-instrument qualification. Facts are presented per instrument without comparative conclusions.</p>';
}

function buildIndex(input: PublicAssetInput, reportFacts: MethodFacts, claimFacts: MethodFacts): string {
  const outcome = input.matrix.completeness.runOutcome;
  const status = reportFacts.kind === "binary" ? qualificationOutcomeLabel(outcome) : outcomeLabel(outcome);
  const adverse = adverseFacts(input, reportFacts);
  const arms = input.claim.scope.arms.map((arm) =>
    `<li><strong>${escapeMarkup(arm.armId)}</strong><pre>${escapeMarkup(canonicalText(arm.pinning))}</pre></li>`
  ).join("");
  const topLevelFiles: readonly [string, string][] = [
    ["benchmark.json", "Benchmark record"],
    ["run.json", "Run record"],
    ["matrix.json", "Matrix record"],
    ["report.json", "Report payload"],
    ["report-envelope.json", "Report signature envelope"],
    ["claim-package.json", "Claim package"],
    ...(reportFacts.kind === "binary" ? [["qualification.json", "Binary qualification graph"] as [string, string]] : []),
    ["static-bundle.json", "Static-bundle projection"],
    ["evidence.json", "Evidence catalog"],
    ["verdicts.json", "Verdict catalog"],
    ["verification/assembly.jsonl", "Verification assembly"],
    ["trust/public-keys.json", "Public trust material"],
  ];
  const casFiles = recordPaths(input);
  const rehearsal = input.claim.rehearsal;
  const rehearsalHtml = rehearsal === undefined
    ? "<p>No product rehearsal is recorded in the stored Claim.</p>"
    : `<p>Preview count: ${rehearsal.previewCount}</p>${list(rehearsal.timestamps, "No timestamps recorded.")}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeMarkup(status)} — Colophon report</title>
<style>
${embeddedFontCss()}
:root{color-scheme:light;--paper:#f7f4ed;--panel:#fffdf8;--ink:#14120e;--muted:#6b675f;--line:#cfc8bb;--vermilion:#c7402a;--indigo:#27406b;--moss:#496246;--ochre:#9d6b23;font:16px/1.6 "Public Sans",Arial,sans-serif}
*{box-sizing:border-box}html,body{margin:0;max-width:100%}body{background:var(--paper);color:var(--ink)}a{color:var(--indigo);text-decoration-thickness:1px;text-underline-offset:.22em}a:focus-visible,[tabindex]:focus-visible{outline:.2rem solid var(--vermilion);outline-offset:.2rem}header,main,footer{width:min(68rem,100%);margin-inline:auto;padding:clamp(1rem,4vw,3rem)}header{border-bottom:1px solid var(--ink);padding-block-end:clamp(2rem,7vw,5rem)}header,main,footer,section,ul,li,dl,div{min-width:0}main{display:grid;gap:0}section{background:transparent;border-bottom:1px solid var(--line);padding:clamp(1.4rem,4vw,3rem) 0}.masthead{display:flex;align-items:center;gap:.7rem;margin-bottom:clamp(2.5rem,8vw,6rem);font-family:"Newsreader",Georgia,serif;font-size:1.55rem;font-weight:650;letter-spacing:-.02em}.masthead img{width:1.65rem;height:1.65rem}.eyebrow,.status,.source-label,.facts dt{font:600 .72rem/1.35 "Public Sans",Arial,sans-serif;letter-spacing:.09em;text-transform:uppercase}.eyebrow{color:var(--vermilion);margin:0 0 .65rem}.status{display:inline-block;border:1px solid currentColor;border-radius:.18rem;padding:.3rem .55rem;margin:0 0 1.2rem}.status[data-run-outcome="partial"],.status[data-run-outcome="cancelled"]{color:var(--vermilion)}h1,h2{font-family:"Newsreader",Georgia,serif;font-weight:500;letter-spacing:-.035em}h1,h2,h3{line-height:1.05;margin-block:0 .8rem}h1{font-size:clamp(3.2rem,11vw,7rem);max-width:11ch}h2{font-size:clamp(2rem,6vw,3.8rem);max-width:18ch}h3{font-size:1rem;margin-top:1.6rem}.lede{font-family:"Newsreader",Georgia,serif;font-size:clamp(1.25rem,3vw,1.75rem);line-height:1.35;max-width:52ch}.neutral{font-weight:650;max-width:62ch;border-top:1px solid var(--line);padding-top:1rem}.adverse{border-top:.3rem solid var(--vermilion);border-bottom-color:var(--vermilion)}.adverse h2{color:var(--vermilion)}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:1.25rem}.facts div{border-top:1px solid var(--ink);padding-top:.55rem}.facts dt{color:var(--muted)}.facts dd{margin:.2rem 0 0;font-weight:600}strong,th,td,li,dd,.source-label{overflow-wrap:anywhere;word-break:break-word}code,pre,.digest{font-family:"IBM Plex Mono",monospace;overflow-wrap:anywhere;word-break:break-word}pre{max-width:100%;white-space:pre-wrap;margin:.7rem 0 0;padding:1rem;background:#eee9df;border:1px solid var(--line);border-radius:.18rem;font-size:.82rem}.table-scroll{max-width:100%;overflow-x:auto;margin-block:.8rem;border-top:1px solid var(--ink)}table{width:100%;min-width:43rem;table-layout:fixed;border-collapse:collapse}caption{text-align:left;font-weight:650;padding-block:.65rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:.65rem}.compact-list{columns:2;column-width:18rem}.compact-list li{break-inside:avoid;margin-block:.3rem}.source-label{color:var(--muted)}.about{font-family:"Newsreader",Georgia,serif;font-size:1.1rem}footer{border-top:1px solid var(--ink)}
@media(max-width:32rem){header,main,footer{padding:1rem}.masthead{margin-bottom:3rem}.compact-list{columns:1}.facts{grid-template-columns:1fr}section{padding:1.5rem 0}h1{font-size:clamp(3rem,18vw,4.6rem)}}
@media print{:root{color-scheme:light}body{background:#fff;color:#000}header,main,footer{width:100%;padding:.5rem 0}section{break-inside:avoid;border-color:#777}a{color:#000;text-decoration:underline}.table-scroll{overflow:visible}table{min-width:0;font-size:9pt}}
</style>
</head>
<body>
<header>
<div class="masthead"><img src="${COLOPHON_MARK_DATA_URI}" width="32" height="32" alt=""><span>${escapeMarkup(PRODUCT_BRANDING.displayName)}</span></div>
<p class="eyebrow">${escapeMarkup(PRODUCT_BRANDING.categoryDescriptor)}</p>
<p class="status" data-run-outcome="${outcome}">${escapeMarkup(status)}</p>
<h1>Colophon report</h1>
<p class="lede">${escapeMarkup(scopeLine(input))}</p>
${neutralClaimHtml(reportFacts)}
</header>
<main>
<section class="adverse" aria-labelledby="adverse-heading"><h2 id="adverse-heading">Prominent adverse facts</h2>${list(adverse, "No adverse facts stated.")}</section>${input.comparison === undefined ? "" : `\n${comparisonSectionHtml(input.comparison)}`}
<section aria-labelledby="scope-heading"><h2 id="scope-heading">Benchmark and configuration scope</h2><dl class="facts"><div><dt>Benchmark digest</dt><dd class="digest">${input.claim.scope.benchmarkSha256}</dd></div><div><dt>Tasks</dt><dd>${input.claim.scope.taskCount}</dd></div><div><dt>Replicates</dt><dd>${input.claim.scope.replicates}</dd></div><div><dt>Venue</dt><dd>${escapeMarkup(input.claim.scope.venue)}</dd></div></dl><h3>Arms and pinned configuration</h3><ul>${arms}</ul></section>${reportFacts.kind === "binary" ? binaryAdmissionHtml(input) : ""}
<section aria-labelledby="matrix-heading"><h2 id="matrix-heading">Sealed Matrix accounting</h2><p class="source-label">Source: authenticated <a href="matrix.json">matrix.json</a>; values below are copied without reconciliation.</p><pre>${escapeMarkup(canonicalText({ completeness: input.matrix.completeness, attrition: input.matrix.attrition }))}</pre><h3>Completeness and attrition</h3><dl class="facts"><div><dt>Matrix run outcome</dt><dd>${escapeMarkup(outcome)}</dd></div><div><dt>Matrix expected</dt><dd>${input.matrix.completeness.expected}</dd></div><div><dt>Matrix judged</dt><dd>${input.matrix.completeness.judged}</dd></div><div><dt>Matrix floor</dt><dd>${escapeMarkup(input.matrix.completeness.floor)}</dd></div></dl><div class="table-scroll" tabindex="0" role="region" aria-label="Per-arm Matrix attrition"><table><caption>Exact per-arm attrition stored in the Matrix</caption><thead><tr><th scope="col">Arm</th><th scope="col">Expected</th><th scope="col">Judged</th><th scope="col">Unjudged</th><th scope="col">Unscorable</th><th scope="col">Expired</th><th scope="col">Invalidated</th><th scope="col">Excluded</th><th scope="col">Replacements</th></tr></thead><tbody>${attritionRows(input)}</tbody></table></div><h3>Matrix asymmetry flags</h3>${list(input.matrix.attrition.asymmetryFlags, "None recorded in the Matrix.")}</section>
<section aria-labelledby="report-heading"><h2 id="report-heading">Sealed Report facts</h2><p class="source-label">Source: authenticated <a href="report.json">report.json</a>; values below are copied without reconciliation.</p><h3>${factsHeading(reportFacts, "report")}</h3>${armResultsHtml(reportFacts, "Exact wilson@1 values from the sealed Report")}<h3>Method and assurance facts stored in the Report</h3><dl class="facts"><div><dt>Report method</dt><dd>${escapeMarkup(input.report.method.id)} @ ${escapeMarkup(input.report.method.version)}</dd></div><div><dt>Report preregistered</dt><dd>${input.report.preregistered === true ? "Yes" : "No"}</dd></div></dl><h3>Report parameters</h3><pre>${escapeMarkup(canonicalText(input.report.method.parameters))}</pre><h3>Report conflicts</h3><pre>${escapeMarkup(canonicalText(reportFacts.conflicted))}</pre><h3>Report disclosures</h3><pre>${escapeMarkup(canonicalText(input.report.disclosures))}</pre></section>
<section aria-labelledby="claim-heading"><h2 id="claim-heading">Stored Claim facts</h2><p class="source-label">Source: authenticated <a href="claim-package.json">claim-package.json</a>; values below are copied without reconciliation.</p><h3>${factsHeading(claimFacts, "claim")}</h3>${armResultsHtml(claimFacts, "Exact arm values stored in the Claim package")}<h3>Claim method and preregistration</h3><dl class="facts"><div><dt>Claim method</dt><dd>${escapeMarkup(input.claim.method.id)} @ ${escapeMarkup(input.claim.method.version)}</dd></div><div><dt>Claim preregistered</dt><dd>${input.claim.method.preregistered ? "Yes" : "No"}</dd></div><div><dt>Assurance preset</dt><dd>${escapeMarkup(input.claim.assurance.preset)}</dd></div></dl><h3>Claim parameters</h3><pre>${escapeMarkup(canonicalText(input.claim.method.parameters))}</pre><h3>Claim completeness</h3><pre>${escapeMarkup(canonicalText(input.claim.completeness))}</pre><h3>Claim attrition</h3><pre>${escapeMarkup(canonicalText(input.claim.attrition))}</pre><h3>Claim conflicts</h3><pre>${escapeMarkup(canonicalText(input.claim.conflicted))}</pre><h3>Claim disclosures</h3><h4>Unverifiable axes, integrity tiers, and per-subject disclosures</h4><pre>${escapeMarkup(canonicalText(input.claim.disclosures))}</pre><h3>Resolved assurance primitives</h3><pre>${escapeMarkup(canonicalText(input.claim.assurance.resolved))}</pre><p>${escapeMarkup(input.claim.assurance.disclosure)}</p><h3>Rehearsal disclosure</h3>${rehearsalHtml}</section>
<section aria-labelledby="dissent-heading"><h2 id="dissent-heading">Verification assembly dissent</h2><p class="source-label">Source: authenticated <a href="verification/assembly.jsonl">verification assembly</a>.</p><dl class="facts"><div><dt>Dissenting cells</dt><dd>${input.dissentCellKeys.length}</dd></div></dl>${list(input.dissentCellKeys, "None recorded in the verification assembly.")}</section>
<section id="limitations" aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations by stored source</h2><h3>Sealed Report limitations</h3>${list(input.report.limitations ?? [], "None recorded in the sealed Report.")}<h3>Stored Claim limitations</h3>${list(input.claim.limitations, "None recorded in the stored Claim.")}<h3>Local self-run trust boundary stored in the Claim</h3><pre>${escapeMarkup(canonicalText(input.claim.venueHonesty))}</pre></section>
<section aria-labelledby="records-heading"><h2 id="records-heading">Records and exact identities</h2><dl class="facts"><div><dt>Report SHA-256</dt><dd class="digest">${input.reportSha256}</dd></div><div><dt>Matrix SHA-256</dt><dd class="digest">${input.matrixSha256}</dd></div><div><dt>Run SHA-256</dt><dd class="digest">${input.claim.records.runSha256}</dd></div><div><dt>Report envelope SHA-256</dt><dd class="digest">${input.claim.records.reportEnvelopeSha256}</dd></div></dl><h3>Top-level records and catalogs</h3><ul class="compact-list">${topLevelFiles.map(([path, label]) => `<li><a href="${path}">${escapeMarkup(label)} <span class="digest">(${path})</span></a></li>`).join("")}</ul><h3>Every manifest-listed content-addressed record</h3><ul class="compact-list">${casFiles.map((path) => `<li><a href="${path}">CAS record <span class="digest">(${path})</span></a></li>`).join("")}</ul></section>
<section id="verification" aria-labelledby="verification-heading"><h2 id="verification-heading">Portable verification</h2><p>Copy this entire directory. Reproduce publication with the exact verifier:</p><pre><code>${escapeMarkup(input.claim.verification.command)}</code></pre><p>Use the compatible major line to receive fixes that preserve this bundle-format contract:</p><pre><code>${escapeMarkup(input.claim.verification.compatibleCommand)}</code></pre><h3>Named checks</h3>${list(input.claim.verification.checks, "No checks recorded.")}<h3>Trust root</h3><p>${escapeMarkup(input.claim.verification.trustRoot)}</p><p class="about">${escapeMarkup(PRODUCT_BRANDING.attribution)}</p></section>
</main>
<footer><nav aria-label="Report references"><a href="index.html#limitations">Read limitations</a> · <a href="index.html#verification">Verify this report</a></nav><p>Report <span class="digest">${input.reportSha256}</span></p><p class="about">${escapeMarkup(PRODUCT_BRANDING.attribution)}</p></footer>
</body>
</html>\n`;
  return html;
}

function compactStatus(input: PublicAssetInput, reportFacts: MethodFacts): string {
  return `${outcomeLabel(input.matrix.completeness.runOutcome)} · Report conflicts ${reportFacts.conflicted.count} · Claim conflicts ${input.claim.conflicted.count} · assembly dissent ${input.dissentCellKeys.length} · Matrix asymmetry ${input.matrix.attrition.asymmetryFlags.length} · Report limitations ${(input.report.limitations ?? []).length} · Claim limitations ${input.claim.limitations.length}`;
}

/** Compact paired surfaces deliberately carry no estimate, interval bound, alpha, or pair count.
 * They disclose the interval state and point to the relative full-report path instead. */
function pairedCompactFragment(facts: MethodFacts): string {
  if (facts.kind === "wilson") return "";
  if (facts.kind === "binary") return "Verified qualification signpost · full evidence at index.html";
  if (facts.kind === "pairwise-disagreement") {
    return `Pairwise disagreement panel · ${facts.pairs.length} arm pairs · index.html`;
  }
  if (facts.delta === null) return "Paired estimate unavailable · read full report at index.html";
  if (facts.interval === null) return "Paired estimate reported; interval withheld · index.html";
  return "Paired estimate and interval in full report · index.html";
}

function buildBadge(input: PublicAssetInput, reportFacts: MethodFacts): string {
  const scope = scopeLine(input);
  if (reportFacts.kind === "binary") {
    return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 920 150" width="920" height="150"><title id="title">Colophon verified qualification</title><desc id="desc">${escapeMarkup(`Verified. ${scope}. Report SHA-256 ${input.reportSha256}. Full evidence: index.html.`)}</desc><metadata>${escapeMarkup(`verified=true; scope=${scope}; Report SHA-256=${input.reportSha256}`)}</metadata><rect width="920" height="150" fill="#14120e"/><text x="20" y="45" fill="#f7f4ed" font-family="sans-serif" font-size="22">Colophon · verified qualification</text><text x="20" y="82" fill="#d8d1c5" font-family="sans-serif" font-size="14">${escapeMarkup(scope)}</text><a href="index.html"><text x="20" y="118" fill="#9eb9ef" font-family="monospace" font-size="11">Report ${input.reportSha256} · index.html</text></a></svg>\n`;
  }
  const status = compactStatus(input, reportFacts);
  const digest = input.reportSha256.slice(0, 12);
  const exactArms = input.claim.scope.arms.map((arm) => arm.armId).join(" · ");
  const visualStatus = boundedVisual(status, 112);
  const visualConfig = boundedVisual(scope, 112);
  // Extra row only for the paired branch (P4b Task 6) -- empty string for wilson keeps every
  // wilson byte, including the fixed 150-height viewBox, identical to before this dispatch.
  const pairedFragment = pairedCompactFragment(reportFacts);
  const height = pairedFragment === "" ? 150 : 176;
  const pairedRow = pairedFragment === ""
    ? ""
    : `<a href="index.html"><text data-field="paired-status" x="20" y="160" fill="#d8d1c5" font-family="Public Sans,sans-serif" font-size="12">${escapeMarkup(pairedFragment)}</text></a>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 920 ${height}" width="920" height="${height}" style="max-width:100%;height:auto"><title id="title">Colophon · ${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))}; no comparative winner stated</title><desc id="desc">${escapeMarkup(`${scope}. Exact configuration arm IDs: ${exactArms}. ${status}. Full Report SHA-256 ${input.reportSha256}. Read index.html limitations and verification.`)}</desc><metadata>${escapeMarkup(`Report SHA-256: ${input.reportSha256}; exact arm IDs: ${exactArms}`)}</metadata><style>${embeddedFontCss()}</style><rect width="920" height="${height}" fill="#14120e"/><rect x="18" y="18" width="12" height="12" transform="rotate(45 24 24)" fill="#c7402a"/><text x="44" y="30" fill="#f7f4ed" font-family="Newsreader,serif" font-size="21" font-weight="650">Colophon</text><line x1="20" x2="900" y1="42" y2="42" stroke="#6b675f"/><text data-field="neutral-status" x="20" y="66" fill="#f7f4ed" font-family="Public Sans,sans-serif" font-size="16" font-weight="700">${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))} · no comparative winner stated</text><text data-field="adverse-status" x="20" y="90" fill="#f07a62" font-family="Public Sans,sans-serif" font-size="12">${escapeMarkup(visualStatus)}</text><text data-field="config-summary" x="20" y="112" fill="#d8d1c5" font-family="Public Sans,sans-serif" font-size="13">${escapeMarkup(visualConfig)}</text><a href="index.html#limitations"><text x="20" y="136" fill="#9eb9ef" font-family="IBM Plex Mono,monospace" font-size="11">Report ${digest} · index.html#limitations · index.html#verification</text></a>${pairedRow}</svg>\n`;
}

function buildSocialCard(input: PublicAssetInput, reportFacts: MethodFacts): string {
  const scope = scopeLine(input);
  if (reportFacts.kind === "binary") {
    return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 1200 630" width="1200" height="630"><title id="title">Colophon verified qualification</title><desc id="desc">${escapeMarkup(`Verified. ${scope}. Report SHA-256 ${input.reportSha256}. Full evidence: index.html.`)}</desc><metadata>${escapeMarkup(`verified=true; scope=${scope}; Report SHA-256=${input.reportSha256}`)}</metadata><rect width="1200" height="630" fill="#f7f4ed"/><text x="78" y="180" fill="#c7402a" font-family="sans-serif" font-size="24">COLOPHON · VERIFIED QUALIFICATION</text><text x="78" y="300" fill="#14120e" font-family="serif" font-size="64">Evidence signpost</text><text x="78" y="390" fill="#14120e" font-family="sans-serif" font-size="24">${escapeMarkup(scope)}</text><a href="index.html"><text x="78" y="500" fill="#27406b" font-family="monospace" font-size="17">Report ${input.reportSha256}</text></a><text x="78" y="545" fill="#27406b" font-family="monospace" font-size="17">Full evidence: index.html</text></svg>\n`;
  }
  const status = compactStatus(input, reportFacts);
  const armIds = input.claim.scope.arms.map((arm) => arm.armId).join(" · ");
  const digest = input.reportSha256.slice(0, 12);
  const visualStatus = boundedVisual(status, 112);
  const visualConfig = boundedVisual(`${input.claim.scope.arms.length} configurations: ${armIds}`, 40);
  // Extra row only for the paired branch (P4b Task 6) -- empty string for wilson, appended after
  // the last existing element, keeps every wilson byte identical to before this dispatch.
  const pairedFragment = pairedCompactFragment(reportFacts);
  const pairedRow = pairedFragment === ""
    ? ""
    : `<a href="index.html"><text data-field="paired-status" x="78" y="605" fill="#6b675f" font-family="Public Sans,sans-serif" font-size="16">${escapeMarkup(pairedFragment)}</text></a>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 1200 630" width="1200" height="630" style="max-width:100%;height:auto"><title id="title">Colophon · ${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))}; neutral benchmark report</title><desc id="desc">${escapeMarkup(`${scope}. Exact configuration arm IDs: ${armIds}. ${status}. Full Report SHA-256 ${input.reportSha256}. Read index.html limitations and verification.`)}</desc><metadata>${escapeMarkup(`Report SHA-256: ${input.reportSha256}; exact arm IDs: ${armIds}`)}</metadata><style>${embeddedFontCss()}</style><rect width="1200" height="630" fill="#f7f4ed"/><line x1="72" x2="1128" y1="72" y2="72" stroke="#14120e" stroke-width="2"/><rect x="78" y="93" width="18" height="18" transform="rotate(45 87 102)" fill="#c7402a"/><text x="118" y="112" fill="#14120e" font-family="Newsreader,serif" font-size="32" font-weight="650">Colophon</text><text data-field="neutral-status" x="78" y="180" fill="#c7402a" font-family="Public Sans,sans-serif" font-size="20" font-weight="700" letter-spacing="1">${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))} · NO COMPARATIVE WINNER STATED</text><text x="78" y="290" fill="#14120e" font-family="Newsreader,serif" font-size="76" font-weight="500">Benchmark report</text><text data-field="adverse-status" x="78" y="350" fill="#c7402a" font-family="Public Sans,sans-serif" font-size="22">${escapeMarkup(visualStatus)}</text><text data-field="config-summary" x="78" y="405" fill="#14120e" font-family="Public Sans,sans-serif" font-size="23">${escapeMarkup(visualConfig)}</text><text x="78" y="452" fill="#14120e" font-family="Public Sans,sans-serif" font-size="22">${escapeMarkup(scope)}</text><line x1="78" x2="1122" y1="492" y2="492" stroke="#cfc8bb"/><a href="index.html#verification"><text x="78" y="540" fill="#27406b" font-family="IBM Plex Mono,monospace" font-size="16">Report ${digest} · index.html#limitations · index.html#verification</text></a><text x="78" y="580" fill="#6b675f" font-family="Public Sans,sans-serif" font-size="16">${escapeMarkup(PRODUCT_BRANDING.attribution)}</text>${pairedRow}</svg>\n`;
}

function markdownArmTable(facts: WilsonFacts): string {
  return [
    "| Arm | n | Pass rate | Wilson low | Wilson high |",
    "|---|---:|---:|---:|---:|",
    ...facts.arms.map((arm) => `| ${escapeMarkdown(arm.armId)} | ${arm.n} | ${escapeMarkdown(arm.passRate)} | ${escapeMarkdown(arm.low)} | ${escapeMarkdown(arm.high)} |`),
  ].join("\n");
}

/** Markdown counterpart to `comparisonFactsHtml` (P4b Task 6): pairs, delta, and either the
 * interval bounds or every withheld reason, in full -- no truncation budget on this surface. */
function comparisonFactsMarkdown(facts: ComparisonFacts): string {
  const delta = facts.delta === null ? "—" : escapeMarkdown(facts.delta);
  const intervalLines = facts.interval === null
    ? ["- Interval: withheld", ...facts.reasons.map((reason) => `  - ${escapeMarkdown(reason)}`)]
    : [
        `- Interval low: ${escapeMarkdown(facts.interval.low)}`,
        `- Interval high: ${escapeMarkdown(facts.interval.high)}`,
        `- Alpha: ${escapeMarkdown(facts.alpha)}`,
      ];
  return [
    escapeMarkdown(pairedEstimateLine(facts)),
    "",
    `- Paired task count: ${facts.pairs}`,
    `- Candidate minus baseline estimate: ${delta}`,
    ...intervalLines,
  ].join("\n");
}

function binaryFactsMarkdown(facts: BinaryFacts): string {
  const caption = stratumCaption(facts.qualification.configuration);
  return [
    "Qualification facts are presented per instrument without comparative conclusions.",
    "",
    "### Registered configuration",
    "",
    `    ${escapeMarkdownCode(canonicalText(facts.qualification.configuration))}`,
    "",
    ...Object.entries(facts.qualification.arms).flatMap(([armId, arm]) => [
      `### ${escapeMarkdown(armId)}`,
      "",
      `- Instrument: ${escapeMarkdown(String(arm["instrumentSha256"]))}`,
      `- Item, call, and confusion denominators: ${escapeMarkdown(canonicalText({ item: arm["item"], call: arm["call"], confusion: arm["confusion"] }))}`,
      `- Agreement: ${escapeMarkdown(canonicalText(arm["agreement"]))}`,
      `- False accept: ${escapeMarkdown(canonicalText(arm["falseAccept"]))}`,
      `- False reject: ${escapeMarkdown(canonicalText(arm["falseReject"]))}`,
      `- Instability: ${escapeMarkdown(canonicalText(arm["instability"]))}`,
      `- Parser invalid: ${escapeMarkdown(canonicalText(arm["parserInvalid"]))}`,
      `- Every candidate-class bucket: ${escapeMarkdown(canonicalText(arm["byCandidateClass"]))}`,
      `- ${escapeMarkdown(caption)}: ${escapeMarkdown(canonicalText(arm["byStratum"]))}`,
      "",
    ]),
    "### Per-item decisions, instability, and exclusions",
    "",
    `    ${escapeMarkdownCode(canonicalText({ itemDecisions: facts.qualification.itemDecisions, excluded: facts.qualification.excluded }))}`,
  ].join("\n");
}

function judgeIntervalMarkdownLines(
  interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null,
  reasons: readonly string[],
): readonly string[] {
  return interval === null
    ? ["- Interval: withheld", ...reasons.map((reason) => `  - ${escapeMarkdown(reason)}`)]
    : [
        `- Interval lower: ${escapeMarkdown(interval.lower)}`,
        `- Interval upper: ${escapeMarkdown(interval.upper)}`,
        `- Alpha: ${escapeMarkdown(interval.alpha)}`,
      ];
}

function pairwiseDisagreementFactsMarkdown(facts: PairwiseDisagreementFacts): string {
  if (facts.pairs.length === 0) return "No arm pairs were computed.";
  return [
    "| Arm pair | n | Disagreements | Rate | Interval |",
    "| --- | --- | --- | --- | --- |",
    ...facts.pairs.map((pair) => {
      const interval = pair.interval === null
        ? "withheld"
        : `${escapeMarkdown(pair.interval.lower)} – ${escapeMarkdown(pair.interval.upper)}`;
      return `| ${escapeMarkdown(pair.armA)} vs ${escapeMarkdown(pair.armB)} | ${pair.n} | ${pair.disagreements} | ${pair.rate === null ? "—" : escapeMarkdown(pair.rate)} | ${interval} |`;
    }),
  ].join("\n");
}

function pairedMajorityDeltaFactsMarkdown(facts: PairedMajorityDeltaFacts): string {
  return [
    `- Candidate (evidence-declaring arm): ${escapeMarkdown(facts.candidate)}`,
    `- Baseline (evidence-free twin): ${escapeMarkdown(facts.baseline)}`,
    `- Paired task count: ${facts.n}`,
    `- Candidate minus baseline estimate: ${facts.delta === null ? "—" : escapeMarkdown(facts.delta)}`,
    ...judgeIntervalMarkdownLines(facts.interval, facts.reasons),
  ].join("\n");
}

/** Dispatches the arm/comparison facts block on `facts.kind` (P4b Task 6), markdown counterpart
 * to `armResultsHtml`. The wilson branch is byte-identical to before this dispatch existed. */
function armResultsMarkdown(facts: MethodFacts): string {
  if (facts.kind === "wilson") return markdownArmTable(facts);
  if (facts.kind === "comparison") return comparisonFactsMarkdown(facts);
  if (facts.kind === "pairwise-disagreement") return pairwiseDisagreementFactsMarkdown(facts);
  if (facts.kind === "paired-majority-delta") return pairedMajorityDeltaFactsMarkdown(facts);
  return binaryFactsMarkdown(facts);
}

function buildReadme(input: PublicAssetInput, reportFacts: MethodFacts, claimFacts: MethodFacts): string {
  const adverse = adverseFacts(input, reportFacts);
  const arms = input.claim.scope.arms.map((arm) =>
    `- **${escapeMarkdown(arm.armId)}** — pinning: ${escapeMarkdown(canonicalText(arm.pinning))}`
  ).join("\n");
  const reportLimitations = (input.report.limitations ?? []).map((value) => `- ${escapeMarkdown(value)}`).join("\n") || "- None recorded in the sealed Report.";
  const claimLimitations = input.claim.limitations.map((value) => `- ${escapeMarkdown(value)}`).join("\n") || "- None recorded in the stored Claim.";
  const topLevelFiles: readonly [string, string][] = [
    ["benchmark.json", "Benchmark record"], ["run.json", "Run record"],
    ["matrix.json", "Matrix record"], ["report.json", "Report payload"],
    ["report-envelope.json", "Report signature envelope"], ["claim-package.json", "Claim package"],
    ...(reportFacts.kind === "binary" ? [["qualification.json", "Binary qualification graph"] as [string, string]] : []),
    ["static-bundle.json", "Static-bundle projection"], ["evidence.json", "Evidence catalog"],
    ["verdicts.json", "Verdict catalog"], ["verification/assembly.jsonl", "Verification assembly"],
    ["trust/public-keys.json", "Public trust material"],
  ];
  const topLevelLinks = topLevelFiles.map(([path, label]) => `- [${label} (\`${path}\`)](${path})`).join("\n");
  const casLinks = recordPaths(input).map((path) => `- [CAS record \`${path}\`](${path})`).join("\n");
  const documentStatus = reportFacts.kind === "binary"
    ? `${qualificationOutcomeLabel(input.matrix.completeness.runOutcome)}. Verified binary-instrument qualification.`
    : `${outcomeLabel(input.matrix.completeness.runOutcome)}. No comparative winner is stated.`;
  return `# Colophon report

**${documentStatus}**

Scope: ${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${escapeMarkdown(input.claim.scope.venue)}.

Report SHA-256: \`${input.reportSha256}\`

Matrix SHA-256: \`${input.matrixSha256}\`

Read the [full report](index.html), [limitations](index.html#limitations), and [portable verification instructions](index.html#verification).${input.comparison === undefined ? "" : `\n\n${comparisonSectionMarkdown(input.comparison).trimEnd()}`}

## Prominent adverse facts

${adverse.map((value) => `- ${escapeMarkdown(value)}`).join("\n")}

## Configurations

${arms}${reportFacts.kind === "binary" ? `\n\n${binaryAdmissionMarkdown(input).trimEnd()}` : ""}

## Sealed Matrix accounting

Source: authenticated [\`matrix.json\`](matrix.json). These stored values are not reconciled with another source.

    ${escapeMarkdownCode(canonicalText({ completeness: input.matrix.completeness, attrition: input.matrix.attrition }))}

## Sealed Report facts

Source: authenticated [\`report.json\`](report.json). These stored values are not reconciled with another source.

### ${factsHeading(reportFacts, "report")}

${armResultsMarkdown(reportFacts)}

### Report method and preregistration

- Report method: ${escapeMarkdown(input.report.method.id)} @ ${escapeMarkdown(input.report.method.version)}
- Report preregistered: ${input.report.preregistered === true ? "yes" : "no"}
- Report parameters: ${escapeMarkdown(canonicalText(input.report.method.parameters))}

### Report conflicts

    ${escapeMarkdownCode(canonicalText(reportFacts.conflicted))}

### Report disclosures

    ${escapeMarkdownCode(canonicalText(input.report.disclosures))}

### Report limitations

${reportLimitations}

## Stored Claim facts

Source: authenticated [\`claim-package.json\`](claim-package.json). These stored values are not reconciled with another source.

### ${factsHeading(claimFacts, "claim")}

${armResultsMarkdown(claimFacts)}

### Claim method and preregistration

- Claim method: ${escapeMarkdown(input.claim.method.id)} @ ${escapeMarkdown(input.claim.method.version)}
- Claim preregistered: ${input.claim.method.preregistered ? "yes" : "no"}
- Claim parameters: ${escapeMarkdown(canonicalText(input.claim.method.parameters))}

### Claim completeness

    ${escapeMarkdownCode(canonicalText(input.claim.completeness))}

### Claim attrition

    ${escapeMarkdownCode(canonicalText(input.claim.attrition))}

### Claim conflicts

    ${escapeMarkdownCode(canonicalText(input.claim.conflicted))}

### Claim disclosures

    ${escapeMarkdownCode(canonicalText(input.claim.disclosures))}

### Claim limitations

${claimLimitations}

### Claim assurance, rehearsal, and self-run trust boundary

- Assurance: ${escapeMarkdown(input.claim.assurance.preset)} — ${escapeMarkdown(canonicalText(input.claim.assurance.resolved))}
- Boundary: ${escapeMarkdown(input.claim.assurance.disclosure)}
- Rehearsal: ${escapeMarkdown(canonicalText(input.claim.rehearsal ?? null))}
- Venue honesty: ${escapeMarkdown(canonicalText(input.claim.venueHonesty))}

## Verification assembly dissent

Source: authenticated [verification assembly](verification/assembly.jsonl).

    ${escapeMarkdownCode(canonicalText({ dissentCellKeys: input.dissentCellKeys }))}

## Raw records and catalogs

### Top-level records and catalogs

${topLevelLinks}

### Every manifest-listed content-addressed record

${casLinks}

## Portable verification

Copy the complete bundle directory. Reproduce publication with the exact verifier:

    ${input.claim.verification.command}

Use the compatible major line to receive fixes that preserve this bundle-format contract:

    ${input.claim.verification.compatibleCommand}

The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material. See [index.html#verification](index.html#verification). ${PRODUCT_BRANDING.attribution}

Typography is embedded for offline use from the SIL Open Font License distributions of Newsreader, Public Sans, and IBM Plex Mono. The complete notices follow so the redistributed font software travels with its license.

${FONT_LICENSES.map(([name, path]) => `## ${name} font license\n\n\`\`\`text\n${readFileSync(require.resolve(path), "utf8").trim()}\n\`\`\``).join("\n\n")}
`;
}

function buildShareText(input: PublicAssetInput, reportFacts: MethodFacts): string {
  if (reportFacts.kind === "binary") {
    return `Colophon · verified qualification. ${plainText(scopeLine(input))}. Report ${input.reportSha256}. Full evidence: index.html; verify: index.html#verification with ${plainText(input.claim.verification.command)}.\n`;
  }
  // Paired branch only (P4b Task 6): empty string for wilson keeps this sentence byte-identical
  // to before this dispatch existed.
  const pairedFragment = pairedCompactFragment(reportFacts);
  const pairedClause = pairedFragment === "" ? "" : ` ${plainText(pairedFragment)}.`;
  return `Colophon · ${outcomeLabel(input.matrix.completeness.runOutcome)}; no comparative winner stated. ${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${plainText(input.claim.scope.venue)}. ${plainText(compactStatus(input, reportFacts))}. Report ${input.reportSha256}.${pairedClause} Full report: index.html; limitations: index.html#limitations; verify: index.html#verification with ${plainText(input.claim.verification.command)}. ${PRODUCT_BRANDING.attribution}\n`;
}

/** Fixed, deterministic public-bundle/2 presentation bytes. The builder only projects already
 * verified stored facts; it never computes a statistic, selects a winner, or reconciles records. */
export function buildPublicAssets(input: PublicAssetInput): Readonly<Record<string, Uint8Array>> {
  const reportFacts = methodProjection(input.report.results, input.report.method, "sealed Report");
  const claimFacts = methodProjection(input.claim.results, input.claim.method, "stored claim package");
  if ((reportFacts.kind === "binary") !== (input.binaryQualification !== undefined)) {
    throw new Error("binary public assets require exactly one producer-verified admission/instrument projection");
  }
  return {
    "index.html": encoder.encode(buildIndex(input, reportFacts, claimFacts)),
    "badge.svg": encoder.encode(buildBadge(input, reportFacts)),
    "social-card.svg": encoder.encode(buildSocialCard(input, reportFacts)),
    "README.md": encoder.encode(buildReadme(input, reportFacts, claimFacts)),
    "share.txt": encoder.encode(buildShareText(input, reportFacts)),
  };
}
