import type { MatrixRecord, ReportRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { PRODUCT_BRANDING } from "../branding.js";
import { COLOPHON_MARK_SVG } from "../branding-assets.js";
import type { ClaimPackage } from "../report/claim.js";

export interface PublicAssetInput {
  readonly claim: ClaimPackage;
  readonly matrix: MatrixRecord;
  readonly report: ReportRecord;
  readonly reportSha256: string;
  readonly matrixSha256: string;
  /** Canonically sorted identities for every authenticated `records/<sha>.bin` closure member. */
  readonly recordSha256s: readonly string[];
  readonly dissentCellKeys: readonly string[];
}

interface WilsonArmFact {
  readonly armId: string;
  readonly n: number;
  readonly passRate: string;
  readonly low: string;
  readonly high: string;
}

interface WilsonFacts {
  readonly arms: readonly WilsonArmFact[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

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

function requireWilsonFacts(value: unknown, label: string): WilsonFacts {
  const results = value as {
    readonly perSubject?: readonly {
      readonly results?: {
        readonly arms?: Record<string, {
          readonly n?: unknown;
          readonly passRate?: unknown;
          readonly wilsonInterval?: { readonly low?: unknown; readonly high?: unknown };
        }>;
        readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
      };
    }[];
  };
  const subject = results?.perSubject?.[0]?.results;
  if (results?.perSubject?.length !== 1 || subject?.arms === undefined || subject.conflicted === undefined) {
    throw new Error(`${label}: expected wilson@1's single-subject results shape`);
  }
  const arms = Object.entries(subject.arms).map(([armId, arm]) => {
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
  if (typeof subject.conflicted.count !== "number" || !Array.isArray(subject.conflicted.cellKeys)) {
    throw new Error(`${label}: conflicted facts are invalid`);
  }
  return {
    arms,
    conflicted: {
      count: subject.conflicted.count,
      cellKeys: subject.conflicted.cellKeys.map((value) => String(value)),
    },
  };
}

function outcomeLabel(outcome: MatrixRecord["completeness"]["runOutcome"]): string {
  if (outcome === "complete") return "Complete comparison";
  if (outcome === "partial") return "Partial comparison";
  return "Cancelled comparison";
}

function scopeLine(input: PublicAssetInput): string {
  return `${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${input.claim.scope.venue}`;
}

function adverseFacts(input: PublicAssetInput, reportFacts: WilsonFacts): readonly string[] {
  const facts: string[] = [];
  if (input.matrix.completeness.runOutcome !== "complete") facts.push(`Matrix: ${outcomeLabel(input.matrix.completeness.runOutcome)}; incomplete cells remain accounted below.`);
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

function attritionRows(input: PublicAssetInput): string {
  return Object.entries(input.matrix.attrition.perArm).map(([armId, counts]) =>
    `<tr><th scope="row">${escapeMarkup(armId)}</th><td>${counts.expected}</td><td>${counts.judged}</td><td>${counts.unjudged}</td><td>${counts.unscorable}</td><td>${counts.expired}</td><td>${counts.invalidated}</td><td>${counts.excluded}</td><td>${counts.replacements}</td></tr>`
  ).join("");
}

function buildIndex(input: PublicAssetInput, reportFacts: WilsonFacts, claimFacts: WilsonFacts): string {
  const outcome = input.matrix.completeness.runOutcome;
  const status = outcomeLabel(outcome);
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
  return `<!doctype html>
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
<p class="neutral">No comparative winner is stated; wilson@1 reports neutral per-arm facts only.</p>
</header>
<main>
<section class="adverse" aria-labelledby="adverse-heading"><h2 id="adverse-heading">Prominent adverse facts</h2>${list(adverse, "No adverse facts stated.")}</section>
<section aria-labelledby="scope-heading"><h2 id="scope-heading">Benchmark and configuration scope</h2><dl class="facts"><div><dt>Benchmark digest</dt><dd class="digest">${input.claim.scope.benchmarkSha256}</dd></div><div><dt>Tasks</dt><dd>${input.claim.scope.taskCount}</dd></div><div><dt>Replicates</dt><dd>${input.claim.scope.replicates}</dd></div><div><dt>Venue</dt><dd>${escapeMarkup(input.claim.scope.venue)}</dd></div></dl><h3>Arms and pinned configuration</h3><ul>${arms}</ul></section>
<section aria-labelledby="matrix-heading"><h2 id="matrix-heading">Sealed Matrix accounting</h2><p class="source-label">Source: authenticated <a href="matrix.json">matrix.json</a>; values below are copied without reconciliation.</p><pre>${escapeMarkup(canonicalText({ completeness: input.matrix.completeness, attrition: input.matrix.attrition }))}</pre><h3>Completeness and attrition</h3><dl class="facts"><div><dt>Matrix run outcome</dt><dd>${escapeMarkup(outcome)}</dd></div><div><dt>Matrix expected</dt><dd>${input.matrix.completeness.expected}</dd></div><div><dt>Matrix judged</dt><dd>${input.matrix.completeness.judged}</dd></div><div><dt>Matrix floor</dt><dd>${escapeMarkup(input.matrix.completeness.floor)}</dd></div></dl><div class="table-scroll" tabindex="0" role="region" aria-label="Per-arm Matrix attrition"><table><caption>Exact per-arm attrition stored in the Matrix</caption><thead><tr><th scope="col">Arm</th><th scope="col">Expected</th><th scope="col">Judged</th><th scope="col">Unjudged</th><th scope="col">Unscorable</th><th scope="col">Expired</th><th scope="col">Invalidated</th><th scope="col">Excluded</th><th scope="col">Replacements</th></tr></thead><tbody>${attritionRows(input)}</tbody></table></div><h3>Matrix asymmetry flags</h3>${list(input.matrix.attrition.asymmetryFlags, "None recorded in the Matrix.")}</section>
<section aria-labelledby="report-heading"><h2 id="report-heading">Sealed Report facts</h2><p class="source-label">Source: authenticated <a href="report.json">report.json</a>; values below are copied without reconciliation.</p><h3>Sealed Report arm results</h3>${armResultTable(reportFacts, "Exact wilson@1 values from the sealed Report")}<h3>Method and assurance facts stored in the Report</h3><dl class="facts"><div><dt>Report method</dt><dd>${escapeMarkup(input.report.method.id)} @ ${escapeMarkup(input.report.method.version)}</dd></div><div><dt>Report preregistered</dt><dd>${input.report.preregistered === true ? "Yes" : "No"}</dd></div></dl><h3>Report parameters</h3><pre>${escapeMarkup(canonicalText(input.report.method.parameters))}</pre><h3>Report conflicts</h3><pre>${escapeMarkup(canonicalText(reportFacts.conflicted))}</pre><h3>Report disclosures</h3><pre>${escapeMarkup(canonicalText(input.report.disclosures))}</pre></section>
<section aria-labelledby="claim-heading"><h2 id="claim-heading">Stored Claim facts</h2><p class="source-label">Source: authenticated <a href="claim-package.json">claim-package.json</a>; values below are copied without reconciliation.</p><h3>Stored claim mirror</h3>${armResultTable(claimFacts, "Exact arm values stored in the Claim package")}<h3>Claim method and preregistration</h3><dl class="facts"><div><dt>Claim method</dt><dd>${escapeMarkup(input.claim.method.id)} @ ${escapeMarkup(input.claim.method.version)}</dd></div><div><dt>Claim preregistered</dt><dd>${input.claim.method.preregistered ? "Yes" : "No"}</dd></div><div><dt>Assurance preset</dt><dd>${escapeMarkup(input.claim.assurance.preset)}</dd></div></dl><h3>Claim parameters</h3><pre>${escapeMarkup(canonicalText(input.claim.method.parameters))}</pre><h3>Claim completeness</h3><pre>${escapeMarkup(canonicalText(input.claim.completeness))}</pre><h3>Claim attrition</h3><pre>${escapeMarkup(canonicalText(input.claim.attrition))}</pre><h3>Claim conflicts</h3><pre>${escapeMarkup(canonicalText(input.claim.conflicted))}</pre><h3>Claim disclosures</h3><h4>Unverifiable axes, integrity tiers, and per-subject disclosures</h4><pre>${escapeMarkup(canonicalText(input.claim.disclosures))}</pre><h3>Resolved assurance primitives</h3><pre>${escapeMarkup(canonicalText(input.claim.assurance.resolved))}</pre><p>${escapeMarkup(input.claim.assurance.disclosure)}</p><h3>Rehearsal disclosure</h3>${rehearsalHtml}</section>
<section aria-labelledby="dissent-heading"><h2 id="dissent-heading">Verification assembly dissent</h2><p class="source-label">Source: authenticated <a href="verification/assembly.jsonl">verification assembly</a>.</p><dl class="facts"><div><dt>Dissenting cells</dt><dd>${input.dissentCellKeys.length}</dd></div></dl>${list(input.dissentCellKeys, "None recorded in the verification assembly.")}</section>
<section id="limitations" aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations by stored source</h2><h3>Sealed Report limitations</h3>${list(input.report.limitations ?? [], "None recorded in the sealed Report.")}<h3>Stored Claim limitations</h3>${list(input.claim.limitations, "None recorded in the stored Claim.")}<h3>Local self-run trust boundary stored in the Claim</h3><pre>${escapeMarkup(canonicalText(input.claim.venueHonesty))}</pre></section>
<section aria-labelledby="records-heading"><h2 id="records-heading">Records and exact identities</h2><dl class="facts"><div><dt>Report SHA-256</dt><dd class="digest">${input.reportSha256}</dd></div><div><dt>Matrix SHA-256</dt><dd class="digest">${input.matrixSha256}</dd></div><div><dt>Run SHA-256</dt><dd class="digest">${input.claim.records.runSha256}</dd></div><div><dt>Report envelope SHA-256</dt><dd class="digest">${input.claim.records.reportEnvelopeSha256}</dd></div></dl><h3>Top-level records and catalogs</h3><ul class="compact-list">${topLevelFiles.map(([path, label]) => `<li><a href="${path}">${escapeMarkup(label)} <span class="digest">(${path})</span></a></li>`).join("")}</ul><h3>Every manifest-listed content-addressed record</h3><ul class="compact-list">${casFiles.map((path) => `<li><a href="${path}">CAS record <span class="digest">(${path})</span></a></li>`).join("")}</ul></section>
<section id="verification" aria-labelledby="verification-heading"><h2 id="verification-heading">Portable verification</h2><p>Copy this entire directory, then run:</p><pre><code>${escapeMarkup(input.claim.verification.command)}</code></pre><h3>Named checks</h3>${list(input.claim.verification.checks, "No checks recorded.")}<h3>Trust root</h3><p>${escapeMarkup(input.claim.verification.trustRoot)}</p><p class="about">${escapeMarkup(PRODUCT_BRANDING.attribution)}</p></section>
</main>
<footer><nav aria-label="Report references"><a href="index.html#limitations">Read limitations</a> · <a href="index.html#verification">Verify this report</a></nav><p>Report <span class="digest">${input.reportSha256}</span></p><p class="about">${escapeMarkup(PRODUCT_BRANDING.attribution)}</p></footer>
</body>
</html>\n`;
}

function compactStatus(input: PublicAssetInput, reportFacts: WilsonFacts): string {
  return `${outcomeLabel(input.matrix.completeness.runOutcome)} · Report conflicts ${reportFacts.conflicted.count} · Claim conflicts ${input.claim.conflicted.count} · assembly dissent ${input.dissentCellKeys.length} · Matrix asymmetry ${input.matrix.attrition.asymmetryFlags.length} · Report limitations ${(input.report.limitations ?? []).length} · Claim limitations ${input.claim.limitations.length}`;
}

function buildBadge(input: PublicAssetInput, reportFacts: WilsonFacts): string {
  const scope = scopeLine(input);
  const status = compactStatus(input, reportFacts);
  const digest = input.reportSha256.slice(0, 12);
  const exactArms = input.claim.scope.arms.map((arm) => arm.armId).join(" · ");
  const visualStatus = boundedVisual(status, 112);
  const visualConfig = boundedVisual(scope, 112);
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 920 150" width="920" height="150" style="max-width:100%;height:auto"><title id="title">Colophon · ${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))}; no comparative winner stated</title><desc id="desc">${escapeMarkup(`${scope}. Exact configuration arm IDs: ${exactArms}. ${status}. Full Report SHA-256 ${input.reportSha256}. Read index.html limitations and verification.`)}</desc><metadata>${escapeMarkup(`Report SHA-256: ${input.reportSha256}; exact arm IDs: ${exactArms}`)}</metadata><style>${embeddedFontCss()}</style><rect width="920" height="150" fill="#14120e"/><rect x="18" y="18" width="12" height="12" transform="rotate(45 24 24)" fill="#c7402a"/><text x="44" y="30" fill="#f7f4ed" font-family="Newsreader,serif" font-size="21" font-weight="650">Colophon</text><line x1="20" x2="900" y1="42" y2="42" stroke="#6b675f"/><text data-field="neutral-status" x="20" y="66" fill="#f7f4ed" font-family="Public Sans,sans-serif" font-size="16" font-weight="700">${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))} · no comparative winner stated</text><text data-field="adverse-status" x="20" y="90" fill="#f07a62" font-family="Public Sans,sans-serif" font-size="12">${escapeMarkup(visualStatus)}</text><text data-field="config-summary" x="20" y="112" fill="#d8d1c5" font-family="Public Sans,sans-serif" font-size="13">${escapeMarkup(visualConfig)}</text><a href="index.html#limitations"><text x="20" y="136" fill="#9eb9ef" font-family="IBM Plex Mono,monospace" font-size="11">Report ${digest} · index.html#limitations · index.html#verification</text></a></svg>\n`;
}

function buildSocialCard(input: PublicAssetInput, reportFacts: WilsonFacts): string {
  const scope = scopeLine(input);
  const status = compactStatus(input, reportFacts);
  const armIds = input.claim.scope.arms.map((arm) => arm.armId).join(" · ");
  const digest = input.reportSha256.slice(0, 12);
  const visualStatus = boundedVisual(status, 112);
  const visualConfig = boundedVisual(`${input.claim.scope.arms.length} configurations: ${armIds}`, 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 1200 630" width="1200" height="630" style="max-width:100%;height:auto"><title id="title">Colophon · ${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))}; neutral benchmark report</title><desc id="desc">${escapeMarkup(`${scope}. Exact configuration arm IDs: ${armIds}. ${status}. Full Report SHA-256 ${input.reportSha256}. Read index.html limitations and verification.`)}</desc><metadata>${escapeMarkup(`Report SHA-256: ${input.reportSha256}; exact arm IDs: ${armIds}`)}</metadata><style>${embeddedFontCss()}</style><rect width="1200" height="630" fill="#f7f4ed"/><line x1="72" x2="1128" y1="72" y2="72" stroke="#14120e" stroke-width="2"/><rect x="78" y="93" width="18" height="18" transform="rotate(45 87 102)" fill="#c7402a"/><text x="118" y="112" fill="#14120e" font-family="Newsreader,serif" font-size="32" font-weight="650">Colophon</text><text data-field="neutral-status" x="78" y="180" fill="#c7402a" font-family="Public Sans,sans-serif" font-size="20" font-weight="700" letter-spacing="1">${escapeMarkup(outcomeLabel(input.matrix.completeness.runOutcome))} · NO COMPARATIVE WINNER STATED</text><text x="78" y="290" fill="#14120e" font-family="Newsreader,serif" font-size="76" font-weight="500">Benchmark report</text><text data-field="adverse-status" x="78" y="350" fill="#c7402a" font-family="Public Sans,sans-serif" font-size="22">${escapeMarkup(visualStatus)}</text><text data-field="config-summary" x="78" y="405" fill="#14120e" font-family="Public Sans,sans-serif" font-size="23">${escapeMarkup(visualConfig)}</text><text x="78" y="452" fill="#14120e" font-family="Public Sans,sans-serif" font-size="22">${escapeMarkup(scope)}</text><line x1="78" x2="1122" y1="492" y2="492" stroke="#cfc8bb"/><a href="index.html#verification"><text x="78" y="540" fill="#27406b" font-family="IBM Plex Mono,monospace" font-size="16">Report ${digest} · index.html#limitations · index.html#verification</text></a><text x="78" y="580" fill="#6b675f" font-family="Public Sans,sans-serif" font-size="16">${escapeMarkup(PRODUCT_BRANDING.attribution)}</text></svg>\n`;
}

function markdownArmTable(facts: WilsonFacts): string {
  return [
    "| Arm | n | Pass rate | Wilson low | Wilson high |",
    "|---|---:|---:|---:|---:|",
    ...facts.arms.map((arm) => `| ${escapeMarkdown(arm.armId)} | ${arm.n} | ${escapeMarkdown(arm.passRate)} | ${escapeMarkdown(arm.low)} | ${escapeMarkdown(arm.high)} |`),
  ].join("\n");
}

function buildReadme(input: PublicAssetInput, reportFacts: WilsonFacts, claimFacts: WilsonFacts): string {
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
    ["static-bundle.json", "Static-bundle projection"], ["evidence.json", "Evidence catalog"],
    ["verdicts.json", "Verdict catalog"], ["verification/assembly.jsonl", "Verification assembly"],
    ["trust/public-keys.json", "Public trust material"],
  ];
  const topLevelLinks = topLevelFiles.map(([path, label]) => `- [${label} (\`${path}\`)](${path})`).join("\n");
  const casLinks = recordPaths(input).map((path) => `- [CAS record \`${path}\`](${path})`).join("\n");
  return `# Colophon report

**${outcomeLabel(input.matrix.completeness.runOutcome)}. No comparative winner is stated.**

Scope: ${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${escapeMarkdown(input.claim.scope.venue)}.

Report SHA-256: \`${input.reportSha256}\`

Matrix SHA-256: \`${input.matrixSha256}\`

Read the [full report](index.html), [limitations](index.html#limitations), and [portable verification instructions](index.html#verification).

## Prominent adverse facts

${adverse.map((value) => `- ${escapeMarkdown(value)}`).join("\n")}

## Configurations

${arms}

## Sealed Matrix accounting

Source: authenticated [\`matrix.json\`](matrix.json). These stored values are not reconciled with another source.

    ${escapeMarkdownCode(canonicalText({ completeness: input.matrix.completeness, attrition: input.matrix.attrition }))}

## Sealed Report facts

Source: authenticated [\`report.json\`](report.json). These stored values are not reconciled with another source.

### Sealed Report arm results

${markdownArmTable(reportFacts)}

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

### Stored claim mirror

${markdownArmTable(claimFacts)}

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

Copy the complete bundle directory and run:

    ${input.claim.verification.command}

The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material. See [index.html#verification](index.html#verification). ${PRODUCT_BRANDING.attribution}

Typography is embedded for offline use from the SIL Open Font License distributions of Newsreader, Public Sans, and IBM Plex Mono. The complete notices follow so the redistributed font software travels with its license.

${FONT_LICENSES.map(([name, path]) => `## ${name} font license\n\n\`\`\`text\n${readFileSync(require.resolve(path), "utf8").trim()}\n\`\`\``).join("\n\n")}
`;
}

function buildShareText(input: PublicAssetInput, reportFacts: WilsonFacts): string {
  return `Colophon · ${outcomeLabel(input.matrix.completeness.runOutcome)}; no comparative winner stated. ${input.claim.scope.taskCount} tasks · ${input.claim.scope.arms.length} arms · ${input.claim.scope.replicates} replicates · ${plainText(input.claim.scope.venue)}. ${plainText(compactStatus(input, reportFacts))}. Report ${input.reportSha256}. Full report: index.html; limitations: index.html#limitations; verify: index.html#verification with ${plainText(input.claim.verification.command)}. ${PRODUCT_BRANDING.attribution}\n`;
}

/** Fixed, deterministic public-bundle/1 presentation bytes. The builder only projects already
 * verified stored facts; it never computes a statistic, selects a winner, or reconciles records. */
export function buildPublicAssets(input: PublicAssetInput): Readonly<Record<string, Uint8Array>> {
  const reportFacts = requireWilsonFacts(input.report.results, "sealed Report");
  const claimFacts = requireWilsonFacts(input.claim.results, "stored claim package");
  return {
    "index.html": encoder.encode(buildIndex(input, reportFacts, claimFacts)),
    "badge.svg": encoder.encode(buildBadge(input, reportFacts)),
    "social-card.svg": encoder.encode(buildSocialCard(input, reportFacts)),
    "README.md": encoder.encode(buildReadme(input, reportFacts, claimFacts)),
    "share.txt": encoder.encode(buildShareText(input, reportFacts)),
  };
}
