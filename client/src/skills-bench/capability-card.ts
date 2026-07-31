/**
 * Capability card (design §4 of
 * docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md):
 * the large, self-contained SVG that carries the numbers. Delivered at the
 * top of the GitHub delivery issue and the hosted report; the card/report
 * split (design §1) is load-bearing — the report becomes narrative-only
 * once this exists, and stops repeating the figures.
 *
 * **Self-contained per design §1**: GitHub issues strip HTML/CSS, so both
 * badge and card must be images, not markup. Same discipline as
 * `renderBadgeSvg` (capability-report.ts): no `<image>`, `xlink:href`,
 * `@import`, external `url(https:...)`, `<link>`, or webfonts — a generic
 * monospace font-family name only. Reuses `renderBadgeSvg`'s five approved
 * hexes and its `escapeXml` helper so the two artifacts never drift in
 * palette or escaping behavior.
 *
 * Pure — every value is read from an already-resolved `CapabilityReport`
 * (specifically its `fields`/`receipt`/optional `cohort`); nothing here
 * re-derives a number from raw outcomes.
 */
import {
  cohortRank, deriveCostOverhead, escapeXml, ordinal, validateCohort, type CapabilityReport,
} from './capability-report.js';

// ---------------------------------------------------------------------------
// Palette — identical to renderBadgeSvg's five approved hexes (design §4:
// "Visual rules follow DESIGN.md"). SVG embedded via <img src> can't consume
// CSS custom properties, so these five inlined hexes are the only colors
// either artifact may use anywhere.
// ---------------------------------------------------------------------------

const PAPER = '#ffffff';
const BORDER = '#33415c';
const INK = '#1b2430';
/** vow-green — tints the effect metric when the net paired delta is positive. */
const SUCCESS = '#527a70';
/** break-red — tints the effect metric when the net paired delta is negative. */
const DANGER = '#934c4c';

const FONT = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const WIDTH = 800;
const PAD = 32;
const CONTENT_WIDTH = WIDTH - PAD * 2;
/** Softened-brutalist corners (DESIGN.md §1/§5): the outer card reads at
 *  roughly the `rounded.panel` (10px) intent, the metric tiles at roughly
 *  `rounded.default` (6px) — never razor-square, never pillowy. */
const CARD_RADIUS = 8;
const BOX_RADIUS = 6;
const BOX_GAP = 16;
const BOX_HEIGHT = 76;

/** JetBrains Mono's advance width is roughly 0.6em; 0.64 is a conservative
 *  (slight over-) estimate so wrapped lines never run past `CONTENT_WIDTH`
 *  in the rendering font, at the cost of an occasional extra line. */
const CHAR_WIDTH_RATIO = 0.64;

function charsPerLine(fontSize: number): number {
  return Math.max(10, Math.floor(CONTENT_WIDTH / (fontSize * CHAR_WIDTH_RATIO)));
}

/** Greedy word-wrap into lines no longer than `charsPerLine(fontSize)` — the
 *  only long free-text field this card renders is
 *  `fields.discriminationProvenance`, and SVG `<text>` never wraps on its
 *  own. */
function wrapText(text: string, fontSize: number): string[] {
  const maxChars = charsPerLine(fontSize);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

interface TextOpts {
  weight?: number;
  /** `fill-opacity`, not a new hex — the approved-hex scanner only sees the
   *  five colors above; this is how "muted" text stays within that set. */
  opacity?: number;
  anchor?: 'start' | 'middle' | 'end';
}

function textEl(x: number, y: number, size: number, fill: string, str: string, opts: TextOpts = {}): string {
  const weight = opts.weight ?? 400;
  const anchor = opts.anchor ?? 'start';
  const opacityAttr = opts.opacity !== undefined ? ` fill-opacity="${opts.opacity}"` : '';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ` +
    `fill="${fill}"${opacityAttr} text-anchor="${anchor}">${escapeXml(str)}</text>`;
}

function dividerEl(y: number): string {
  return `<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${BORDER}" stroke-width="1"/>`;
}

interface Metric {
  label: string;
  value: string;
  fill: string;
}

/** Metric 1 — tasks solved. **Honesty gating is mandatory here, not just on
 *  the badge**: gates on `presentation.effectClaimable` (D1 S1/I1 — computed
 *  once in `buildCapabilityReport` from the trigger rate alone, treating a
 *  MISSING rate exactly like a low one, never on the delta itself — see
 *  `ReportPresentation`'s doc comment for why), so a treatment arm that
 *  barely triggered — or has no trigger data at all — never reads as a clean
 *  effect number. Tinted neutral in that case; tinted by sign otherwise. */
function effectMetric(report: CapabilityReport): Metric {
  const { presentation } = report;
  if (!presentation.effectClaimable) {
    return { label: 'Tasks solved', value: presentation.effectCaveat, fill: INK };
  }
  const { baseline, treatment, n } = report.fields;
  const delta = presentation.netDelta;
  const fill = delta > 0 ? SUCCESS : delta < 0 ? DANGER : INK;
  return { label: 'Tasks solved', value: `${baseline.passed} → ${treatment.passed} of ${n}`, fill };
}

/** Metric 2 — skill loaded. `unknown` (never a fabricated `0 of 0`) when no
 *  session-JSONL trigger data was captured for this run at all — this is
 *  also the metric that carries the concrete explanation when metric 1 has
 *  fallen back to the not-exercised framing. */
function loadsMetric(report: CapabilityReport): Metric {
  const rate = report.receipt.triggerRate;
  if (!rate || rate.total === 0) return { label: 'Skill loaded', value: 'unknown', fill: INK };
  return { label: 'Skill loaded', value: `${rate.triggered} of ${rate.total}`, fill: INK };
}

/** Metric 3 — cost overhead. `unknown` (never a fabricated `0%`) when
 *  `deriveCostOverhead` can't compute a ratio (zero/missing baseline mean). */
function costMetric(report: CapabilityReport): Metric {
  const overhead = deriveCostOverhead(report.receipt);
  if (overhead === null) return { label: 'Cost', value: 'unknown', fill: INK };
  const pctValue = Math.round(overhead * 100);
  const sign = pctValue > 0 ? '+' : '';
  return { label: 'Cost', value: `${sign}${pctValue}%`, fill: INK };
}

/** The capability card: the artifact that carries the numbers (design §4),
 *  in section order — identity, what was evaluated, three metrics, an
 *  optional cohort line, and the honesty-line footer. */
export function renderCapabilityCardSvg(report: CapabilityReport): string {
  const { fields, cohort, presentation } = report;
  const sha = presentation.shortSha;
  const parts: string[] = [];
  let y = PAD;

  // 1. Identity — <skill>@<sha>, "evaluated by jinn", date on the face (an
  // undated capability claim is the classic stale-badge failure — design §4
  // item 1's stated reason for putting the date on the card at all).
  y += 22;
  parts.push(textEl(PAD, y, 22, INK, `${fields.skill}@${sha}`, { weight: 600 }));
  y += 20;
  parts.push(textEl(PAD, y, 12, INK, `evaluated by jinn · ${fields.measuredOn}`, { opacity: 0.65 }));
  y += 14;
  parts.push(dividerEl(y));
  y += 22;

  // 2. What was evaluated — MEASURED task count alongside the whole set
  // (D1 I3: the whole-set `taskCount` alone is misleading whenever screening
  // or a per-run exclusion means the measured population is smaller — a
  // 12-task set that only measured 8 must not print a bare "12 tasks" beside
  // a footer reading "n=8"), domain, discrimination provenance (truthful in
  // both directions — see buildDiscriminationProvenance), agent + model.
  parts.push(textEl(PAD, y, 13, INK, 'What was evaluated', { weight: 600 }));
  y += 20;
  parts.push(textEl(PAD, y, 12, INK, `${fields.n} of ${fields.taskCount} tasks · ${fields.domain}`, { opacity: 0.85 }));
  y += 18;
  for (const line of wrapText(fields.discriminationProvenance, 12)) {
    parts.push(textEl(PAD, y, 12, INK, line, { opacity: 0.85 }));
    y += 18;
  }
  parts.push(textEl(PAD, y, 12, INK, `${fields.agent} · ${fields.model}`, { opacity: 0.85 }));
  y += 14;
  parts.push(dividerEl(y));
  y += 24;

  // 3. Three metrics — tasks solved, skill loaded, cost. Effect (metric 1)
  // tinted by sign; the other two stay neutral (design §4 item 3).
  const metrics = [effectMetric(report), loadsMetric(report), costMetric(report)];
  const boxWidth = (CONTENT_WIDTH - BOX_GAP * 2) / 3;
  metrics.forEach((metric, i) => {
    const boxX = PAD + i * (boxWidth + BOX_GAP);
    const cx = boxX + boxWidth / 2;
    parts.push(
      `<rect x="${boxX}" y="${y}" width="${boxWidth}" height="${BOX_HEIGHT}" rx="${BOX_RADIUS}" ` +
      `fill="${PAPER}" stroke="${BORDER}" stroke-width="1"/>`,
    );
    parts.push(textEl(cx, y + 24, 11, INK, metric.label, { opacity: 0.6, anchor: 'middle' }));
    parts.push(textEl(cx, y + 52, 18, metric.fill, metric.value, { weight: 600, anchor: 'middle' }));
  });
  y += BOX_HEIGHT;
  y += 20;
  parts.push(dividerEl(y));
  y += 22;

  // 4. Cohort line — rank via cohortRank; omitted entirely (no placeholder
  // row) when no cohort was measured (design §4 item 4).
  if (cohort) {
    validateCohort(cohort);
    const { rank, of } = cohortRank(cohort);
    parts.push(textEl(PAD, y, 12, INK, `Rank ${ordinal(rank)} of ${of} in ${cohort.domain}`, { weight: 600 }));
    y += 14;
    y += 20;
    parts.push(dividerEl(y));
    y += 22;
  }

  // 5. Footer — the honesty line and a text link to the full report (the
  // card is an image, so the link renders as text, not a hyperlink).
  // `report.links.reportUrl` is the resolved public URL (render-report.ts's
  // --base-url wiring); a caller that hasn't resolved one yet (e.g. a
  // standalone unit test) falls back to the same relative path this footer
  // rendered before that wiring existed.
  parts.push(textEl(PAD, y, 12, INK, `n=${fields.n}, intervals overlap — direction, not proof`, { opacity: 0.85 }));
  y += 18;
  const reportRef = report.links.reportUrl ?? `reports/${fields.skill}@${sha}/report.md`;
  parts.push(textEl(PAD, y, 11, INK, `full report: ${reportRef}`, { opacity: 0.55 }));
  y += 14;

  const height = Math.ceil(y + PAD);
  const ariaLabel =
    `jinn capability card for ${fields.skill}@${sha}, evaluated ${fields.measuredOn}: ` +
    metrics.map((m) => `${m.label.toLowerCase()} ${m.value}`).join(', ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
    `viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="${CARD_RADIUS}" ` +
    `fill="${PAPER}" stroke="${BORDER}" stroke-width="1"/>`,
    ...parts,
    '</svg>',
  ].join('\n') + '\n';
}
