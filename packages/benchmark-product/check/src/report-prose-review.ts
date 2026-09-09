// SPDX-License-Identifier: Apache-2.0

/**
 * The report page's prose review (issue #3016).
 *
 * The first unsolicited external reading of a published report was that it "overexplains itself"
 * and repeats itself, and that it read as machine-written. Both halves of that are mechanical
 * defects, not taste: a statement the page already makes as a check, a tally, or a fixed block is
 * restated in prose, and the page narrates controls that need no narration.
 *
 * This module is the review, so that it runs whenever the code that produces a report is built
 * rather than as a one-off cleanup. It reads a rendered `index.html` and returns findings. It
 * never rewrites anything: the published page is byte-pinned (see
 * `FROZEN_REPORT_PROSE_FINDINGS`), so acting on a finding is a presentation revision, not an edit.
 *
 * Rule sources are named on every rule. The signs-of-AI-writing set is the Wikipedia
 * "Signs of AI writing" guide the external reader cited; the self-narration set is `CLAUDE.md`
 * §Frontends ("Show, don't narrate — no helper-text cruft"); the repetition set is issue #3016's
 * own acceptance criterion that each fact appears once.
 */

/** One reviewable rule. `id` is the stable key a finding and a frozen allowance join on. */
export interface ReportProseRule {
  readonly id: string;
  readonly summary: string;
  /** Where the rule comes from, so a disagreement is with the source rather than with this file. */
  readonly source: string;
}

export interface ReportProseFinding {
  readonly rule: ReportProseRule["id"];
  /** The offending prose, normalized exactly as `FROZEN_REPORT_PROSE_FINDINGS` records it. */
  readonly text: string;
  readonly detail: string;
}

export const REPORT_PROSE_RULES: readonly ReportProseRule[] = [
  {
    id: "repeated-statement",
    summary: "A statement the page already makes is made again somewhere else on the page.",
    source: "issue #3016 acceptance criterion 1",
  },
  {
    id: "narrated-control",
    summary: "Prose that tells the reader to operate a control the control already describes.",
    source: "CLAUDE.md §Frontends, \"Show, don't narrate — no helper-text cruft\"",
  },
  {
    id: "signs-of-ai-writing",
    summary: "Editorializing, puffery, formulaic transitions, or participial summary padding.",
    source: "Wikipedia, \"Signs of AI writing\"",
  },
] as const;

/**
 * Patterns for `signs-of-ai-writing`, transcribed from the guide's own section headings. Each
 * entry is one sign; the label is what a failure prints, so it has to name the sign rather than
 * the regex.
 */
const AI_WRITING_SIGNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "editorializing about significance", pattern: /\b(it (?:is|'s) (?:important|worth) (?:to note|noting)|notably|importantly|crucially)\b/iu },
  { label: "puffery", pattern: /\b(comprehensive|robust|seamless|cutting-edge|state-of-the-art|holistic|multifaceted|nuanced)\b/iu },
  { label: "promotional verb", pattern: /\b(underscor(?:e|es|ed|ing)|showcas(?:e|es|ed|ing)|delv(?:e|es|ed|ing)|stands as a testament|plays? an? (?:vital|crucial|key|pivotal) role)\b/iu },
  { label: "negative parallelism", pattern: /\b(?:it (?:is|'s) )?not (?:only|just) [^,.;]+,? but\b/iu },
  { label: "formulaic transition or conclusion", pattern: /(^|[.;] )(in (?:summary|conclusion)|overall|moreover|furthermore|additionally)[,:]/iu },
  { label: "participial summary clause", pattern: /,\s(?:ensuring|highlighting|underscoring|reflecting|demonstrating|showcasing|emphasizing|providing)\s/iu },
  { label: "vague attribution", pattern: /\b((?:widely|generally) (?:regarded|considered|recognized)|(?:many|some) (?:experts|observers|critics))\b/iu },
];

/** Patterns for `narrated-control`. Kept narrow: an instruction the reader needs is not narration. */
const NARRATED_CONTROL_SIGNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "imperative instruction to operate a control", pattern: /^(?:open|click|expand|tap|select|scroll|hover|toggle)\b/iu },
  { label: "instruction to operate a control", pattern: /\b(?:click|tap|expand|toggle)\b[^.;]*\bto\b/iu },
  { label: "pointer at the page's own layout", pattern: /\b(?:see|read|view|refer to)\b[^.;]*\b(?:below|above)\b|\b(?:shown|listed|rendered|detailed|described|documented)\s+(?:below|above)\b/iu },
];

/**
 * Element content the page derives from a sealed record rather than authoring: every table and
 * list cell, and every disclosure control's interior. Reviewing record text would report findings
 * against bytes this product cannot rewrite, and a term inside a closed control costs a reader
 * nothing until they open it.
 */
const DATA_BEARING = /<(li|dd|dt|td|th|details)\b[^>]*>[\s\S]*?<\/\1>/giu;
const VERBATIM = /<(style|script|pre|code)\b[^>]*>[\s\S]*?<\/\1>/giu;
const AUTHORED = /<(p|h1|h2|h3|h4|caption)\b[^>]*>([\s\S]*?)<\/\1>/giu;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/**
 * The page's authored prose, one entry per rendered element, in document order. Exported because
 * a caller that wants the word count (issue #3016 acceptance criterion 3) needs the same corpus
 * the rules read, not a second approximation of it.
 */
export function authoredReportProse(html: string): readonly string[] {
  const stripped = html.replace(VERBATIM, " ").replace(DATA_BEARING, " ");
  const blocks: string[] = [];
  for (const match of stripped.matchAll(AUTHORED)) {
    const text = decodeEntities(match[2]!.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
    if (text !== "") blocks.push(text);
  }
  return blocks;
}

/** Total words of authored prose. The ratchet `reportProseWordCount` feeds is a ceiling, not a target. */
export function reportProseWordCount(html: string): number {
  return authoredReportProse(html)
    .reduce((total, block) => total + block.split(" ").filter((word) => word !== "").length, 0);
}

/**
 * One statement: a sentence, or a clause a semicolon joined to one. The page states "No
 * comparative winner is stated" once as a clause and once as a sentence, so a splitter that only
 * saw full stops would miss the repetition the external reader actually hit.
 */
function statements(block: string): readonly string[] {
  return block
    .split(/(?<=[.!?;])\s+|;\s*/u)
    .map((part) => part.replace(/[.!?;:,]+$/u, "").replace(/\s+/gu, " ").trim().toLowerCase())
    .filter((part) => part !== "");
}

/**
 * Reviews one rendered report page. Findings are returned in rule order, then in first-appearance
 * order, so a caller comparing against a frozen list compares a stable sequence.
 */
export function reviewReportProse(html: string): readonly ReportProseFinding[] {
  const blocks = authoredReportProse(html);
  const findings: ReportProseFinding[] = [];

  const occurrences = new Map<string, number>();
  const order: string[] = [];
  for (const block of blocks) {
    // Counted per occurrence rather than per block: a paragraph that makes the same statement
    // twice is the defect, not an exemption from it.
    for (const statement of statements(block)) {
      const seen = occurrences.get(statement);
      if (seen === undefined) order.push(statement);
      occurrences.set(statement, (seen ?? 0) + 1);
    }
  }
  for (const statement of order) {
    const count = occurrences.get(statement)!;
    if (count > 1) {
      findings.push({
        rule: "repeated-statement",
        text: statement,
        detail: `stated ${count} times; issue #3016 requires each fact to appear once`,
      });
    }
  }

  for (const block of blocks) {
    for (const sign of NARRATED_CONTROL_SIGNS) {
      if (sign.pattern.test(block)) {
        findings.push({ rule: "narrated-control", text: block, detail: sign.label });
        break;
      }
    }
  }

  for (const block of blocks) {
    for (const sign of AI_WRITING_SIGNS) {
      if (sign.pattern.test(block)) {
        findings.push({ rule: "signs-of-ai-writing", text: block, detail: sign.label });
        break;
      }
    }
  }

  return findings;
}

/**
 * A finding the published page still carries, with the wording that replaces it.
 *
 * These are not waivers. `verifyPublicBundleSnapshot` byte-compares every presentation asset
 * against its own rebuild, and every published claim advertises its compatible verifier as a minor
 * line (see `legacy-closures.ts`), so changing one of these strings in place would make every
 * already-published bundle fail under the command it printed. Adopting the rulings is
 * therefore a bundle-format allocation, exactly as
 * `spec/2026-09-02-report-page-information-architecture.md` §8 rules for the reading order that
 * lands in the same revision.
 */
export interface FrozenReportProseFinding {
  readonly rule: ReportProseRule["id"];
  readonly text: string;
  /** What the next presentation revision renders instead. */
  readonly ruling: string;
}

export const FROZEN_REPORT_PROSE_FINDINGS: readonly FrozenReportProseFinding[] = [
  {
    rule: "repeated-statement",
    text: "no comparative winner is stated",
    ruling:
      "The claim line in the header is the page's single statement of it. The bundled-sample note "
      + "ends at \"derived from the sample consensus inputs.\" and the descriptive line ends at "
      + "\"Lower is better.\"; neither restates the header. The binary profile carries the same "
      + "repetition off this page -- `binaryFactsHtml` opens with the tail of the claim line "
      + "`neutralClaimHtml` already rendered -- and drops it in the same revision.",
  },
  {
    rule: "repeated-statement",
    text: "values below are copied without reconciliation",
    ruling:
      "The Matrix, Report, and Claim sections each keep their authenticated source link. The "
      + "non-reconciliation disclosure is a property of the page, not of a section, so it is "
      + "stated once, on the first sealed-source section, and the later source labels end at "
      + "their record link.",
  },
  {
    rule: "repeated-statement",
    text: "built on jinn",
    ruling:
      "Attribution renders once, in the footer imprint. The verification section drops its copy "
      + "(report UI kit structural rule 5; also §1.3 of the information-architecture spec).",
  },
  {
    rule: "narrated-control",
    text: "Open a cell to inspect its evidence",
    ruling:
      "Cut. The disclosure controls beneath it are self-evident, and CLAUDE.md §Frontends bans "
      + "instructions for self-evident controls outright.",
  },
] as const;

/**
 * The published page's authored-prose word count, pinned at the count this review first measured.
 * A ceiling, not a target: issue #3016 requires reading length to fall and forbids buying the
 * reduction by dropping a disclosure, so prose may shrink freely and may not grow.
 */
export const REPORT_PROSE_WORD_CEILING = 363;
