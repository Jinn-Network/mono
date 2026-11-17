// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3865: the glossary conformance test, item 5 of section 7 of
 * `docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md` ("the spec" below).
 *
 * Two assertions, over every reader-facing string this package generates:
 *
 * 1. **No hidden term reaches a reader.** Section 5 closes by naming the nouns a reader never meets.
 *    Nine leave by hiding; `CAS` leaves by rename, so it is checked by the second assertion.
 * 2. **No section 5 concept is presented under a second name.** Asserted twice. Over the spec
 *    itself, as section 7 words it: every section 4 row that presents a section 5 concept gives it
 *    that concept's name, with section 5's headings rule as the exception set (read from the
 *    section 4 rows that mark themselves as a heading form) and the four names section 5 licenses
 *    for **the runs**. And over the generated strings: a concept's other names are its contract
 *    spellings (section 5's third column), the names section 4 retires for it (the "Reader-visible
 *    term today" of every rename row whose reader-facing name is the concept's), and `CAS` for
 *    *evidence file*; none may reach a reader.
 *
 * Every list is read from the spec. Each parser checks the shape it reads and the counts the spec
 * states in words ("nine nouns", "Three rows", "four names"), so an edit that changes the spec's
 * shape fails here by name rather than quietly widening or narrowing the test. The lists that are
 * restated here, `OTHER_SENSES` and the surface inventories, say why next to themselves.
 *
 * What counts as reader-facing (the surface set):
 *
 * - The five report assets `buildPublicAssets` writes (`index.html`, `README.md`, `share.txt`,
 *   `badge.svg`, `social-card.svg`), at the newest format the reader supports (`/10` today), for
 *   every method this package renders and for the conditional branches listed in
 *   `REPORT_PROFILES`. Older formats are not scanned. Every published format's page is
 *   byte-compared by the reader against its own rebuild, so no change can reach it and no change
 *   can repair it; that now includes `/10`, which `check` 0.2.1 reads (see `BUNDLE_V10_FORMAT`).
 *   The violations recorded against `/10` are retired by the format that replaces its page, and a
 *   new format fails the surface inventory below until this test scans it.
 * - `colophon-check`'s human output: the usage text, the stdout of a checked bundle (every shape in
 *   `READER_RENDERS`), and stderr (every refusal the characterization suite reaches, pinned in
 *   `characterization/testing/checker-outputs.expected.json` and held equal to the real CLI by
 *   `checker-outputs.test.ts`, plus the operational refusals and the two notes). Every flag the
 *   usage text lists is mapped to the rendering that covers its output (`CLI_FLAGS`).
 *
 * Not covered: `--json` output (contract, spec section 2), the product CLI and web app (outside the
 * spec's section 1 scope; see the note on `REPORT_ASSETS` for section 4.2's v1.14 ruling on their
 * timestamp-proof block), docs prose, the older formats above, and section
 * 4 renames whose reader-facing name is not a section 5 concept (`Unjudged` to *Not judged*, `Alpha`
 * to *Confidence level*): the glossary rules concepts, and those rows are held by each rename
 * unit's own gates.
 *
 * What is shown without being named is masked before matching (spec section 3: a hidden concept "may
 * still be *shown* (a digest, a file link) without being *named*"): digests, file paths, protocol
 * identifiers, package and command names, flags, the contract check names section 2 lists, and code
 * or preformatted blocks, which carry sealed record bytes verbatim. Names section 4 rules for a
 * reader are masked too, so a ruled name that happens to contain an inherited word is not read as
 * that word.
 *
 * Violations already on `next` are recorded in `KNOWN_VIOLATIONS`, each with the open issue that
 * owns it (`OWNERS`). The ledger must equal what the surfaces carry
 * exactly: a new violation fails, and so does a recorded one that has gone, so the list cannot
 * outlive the strings it describes. To regenerate it after a change that is meant:
 *
 *   GLOSSARY_CONFORMANCE_PRINT=1 yarn vitest run src/reader-vocabulary-conformance.test.ts
 *
 * and copy the printed entries, keeping each owner.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, SIX_VARIABLE_DISCLOSURE_SPECIFICATION } from "@jinn-network/benchmarking-records";
import type { IntegrityAnchorsReport } from "./anchor/check.js";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { expectedChecks } from "./capabilities.js";
import { ANCHOR_CASES } from "./characterization/testing/anchor-cases.js";
import { renderVerifiedBundle, runVerifierCli } from "./cli.js";
import type { FreezeRepoVerificationResult } from "./freeze-repo.js";
import { domainBindingProof, type VerifiedDomainBinding } from "./identity/domain-binding.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import type { PublicBundleSigner } from "./signers.js";
import { goldenInput } from "./testing/golden-asset-input.js";
import type { PublicBundleVerificationResult, VerifiedPublicBundleSnapshot } from "./verify.js";

// ---------------------------------------------------------------------------
// The spec, read
// ---------------------------------------------------------------------------

const SPEC = readFileSync(
  new URL("../../../../docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md", import.meta.url),
  "utf8",
);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function numberWord(word: string, where: string): number {
  const value = NUMBER_WORDS[word.toLowerCase()];
  if (value === undefined) throw new Error(`spec ${where}: "${word}" is not a number word this test reads`);
  return value;
}

/** The body of one `## ` section, located by its heading line. */
function specSection(heading: string): string {
  const lines = SPEC.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`spec heading "${heading}" not found; the conformance test reads it`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function one(pattern: RegExp, text: string, where: string): RegExpExecArray {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`spec ${where}: expected text matching ${pattern} is gone`);
  return match;
}

function cells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** Every table in `text` whose header is exactly `header`, as rows of cells. Any other table in
 * `text` is a shape this test does not read, so it fails rather than being skipped. */
function tables(text: string, header: readonly string[], where: string): string[][][] {
  const lines = text.split("\n");
  const headerLine = `| ${header.join(" | ")} |`;
  const found: string[][][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("| ") || (index > 0 && lines[index - 1]!.startsWith("|"))) continue;
    if (line !== headerLine) throw new Error(`spec ${where}: a table with header ${line} is not one this test reads`);
    const rows: string[][] = [];
    for (let row = index + 2; row < lines.length && lines[row]!.startsWith("|"); row += 1) {
      const rowCells = cells(lines[row]!);
      if (rowCells.length !== header.length) throw new Error(`spec ${where}: row has ${rowCells.length} cells: ${lines[row]}`);
      rows.push(rowCells);
    }
    found.push(rows);
  }
  if (found.length === 0) throw new Error(`spec ${where}: no table with header ${headerLine}`);
  return found;
}

/** Markdown emphasis and code markers off, whitespace collapsed. */
function plain(text: string): string {
  return text.replace(/[*`]/gu, "").replace(/\s+/gu, " ").trim();
}

interface GlossaryRow {
  readonly concept: string;
  /** Lowercase, as section 5 writes it. */
  readonly name: string;
  readonly contractSpellings: readonly string[];
}

interface RulingRow {
  readonly section: "4.1" | "4.2";
  readonly term: string;
  readonly ruling: string;
  readonly name: string;
  readonly note: string;
}

const SECTION_4 = specSection("## 4. Rulings");
const SECTION_5 = specSection("## 5. Canonical glossary");
const SECTION_2 = specSection("## 2. The two sides of the line");
/** Prose reads with its line breaks folded, so a rewrap of the spec is not a change of shape. */
const SECTION_5_PROSE = SECTION_5.replace(/\s+/gu, " ");
const SECTION_2_PROSE = SECTION_2.replace(/\s+/gu, " ");

const GLOSSARY: readonly GlossaryRow[] = tables(
  SECTION_5,
  ["Concept", "Reader-facing name", "Contract spelling (unchanged)"],
  "section 5",
)[0]!.map(([concept, name, spellings]) => ({
  concept: concept!,
  name: name!.toLowerCase(),
  // Each spelling is one backticked token or one plain phrase; a parenthesis qualifies the token
  // before it (`disagreements` (pairwise-disagreement)) and is not a spelling of its own.
  contractSpellings: spellings!
    .replace(/\([^()]*(?:`[^`]*`[^()]*)*\)/gu, "")
    .split(",")
    .map(plain)
    .filter((spelling) => spelling !== ""),
}));

const RULINGS: readonly RulingRow[] = (() => {
  const split = SECTION_4.indexOf("\n### 4.2 ");
  const split3 = SECTION_4.indexOf("\n### 4.3 ");
  if (split < 0 || split3 < 0) throw new Error("spec section 4: subsections 4.2 and 4.3 are no longer where this test reads them");
  const header = ["Reader-visible term today", "Ruling", "Reader-facing name", "Note"] as const;
  const read = (text: string, section: "4.1" | "4.2"): RulingRow[] =>
    tables(text, header, `section ${section}`).flat().map(([term, ruling, name, note]) => ({
      section, term: term!, ruling: ruling!, name: name!, note: note!,
    }));
  return [...read(SECTION_4.slice(0, split), "4.1"), ...read(SECTION_4.slice(split, split3), "4.2")];
})();

function glossaryRow(name: string, where: string): GlossaryRow {
  const row = GLOSSARY.find((entry) => entry.name === name.toLowerCase());
  if (row === undefined) throw new Error(`spec ${where}: "${name}" is not a section 5 reader-facing name`);
  return row;
}

/** Section 5's closing paragraph: the nouns a reader never meets, and the one that leaves by rename. */
const HIDDEN = (() => {
  const listed = one(/Concepts a reader never meets by name, after this spec: ([^.]+)\./u, SECTION_5_PROSE, "section 5 hidden list")[1]!
    .split(",").map((noun) => noun.trim());
  const count = numberWord(one(/\*\*(\w+) nouns removed from the reader's vocabulary by hiding alone\*\*/u, SECTION_5_PROSE, "section 5 hidden count")[1]!, "section 5 hidden count");
  const renamed = one(/`(\w+)` is the tenth noun a reader stops meeting, but it leaves by rename \(§4\.1: `([^`]+)` → \*([^*]+)\*\)/u, SECTION_5_PROSE, "section 5 renamed noun");
  const hidden = listed.filter((noun) => noun !== renamed[1]);
  if (hidden.length !== count || listed.length !== count + 1) {
    throw new Error(`spec section 5: lists ${listed.length} nouns and says ${count} leave by hiding plus one by rename`);
  }
  return { hidden, renamed: { noun: renamed[1]!, from: renamed[2]!, concept: glossaryRow(renamed[3]!, "section 5 renamed noun") } };
})();

/** Section 5's headings rule, as the section 4 rows that invoke it: name and concept per row. */
const HEADING_FORMS: readonly { readonly name: string; readonly concept: GlossaryRow }[] = RULINGS
  .filter((row) => /headings rule/u.test(row.note))
  .map((row) => ({
    name: plain(row.name),
    concept: glossaryRow(one(/concept \*{1,2}([^*]+)\*{1,2}/u, row.note, `section ${row.section} heading row "${row.term}"`)[1]!, "heading row"),
  }));

/** The same rule as section 5 states it, read independently so the two can be held equal. */
const HEADINGS_RULE_AS_STATED = (() => {
  const match = one(/(\w+) rows meet that condition today: ([\s\S]+?)\. A heading that \*contains\*/u, SECTION_5_PROSE, "section 5 headings rule");
  const stated: { name: string; concept: string }[] = [];
  const parts = match[2]!.split(/whose concept is \*\*([^*]+)\*\*/u);
  for (let index = 0; index + 1 < parts.length; index += 2) {
    for (const name of parts[index]!.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/gu)) stated.push({ name: name[1]!, concept: parts[index + 1]! });
  }
  return { count: numberWord(match[1]!, "section 5 headings rule"), stated };
})();

/** The names section 5 licenses for **the runs** beyond its own. */
const RUNS_COLLAPSE = (() => {
  const match = one(/\*\*The runs\*\* is still presented under (\w+) names in §4\.1 \(([^)]+)\)/u, SECTION_5_PROSE, "section 5 runs collapse");
  const names = [...match[2]!.matchAll(/\*([^*]+)\*/gu)].map((name) => name[1]!);
  if (names.length !== numberWord(match[1]!, "section 5 runs collapse")) {
    throw new Error(`spec section 5: says the runs has ${match[1]} names in section 4.1 and lists ${names.length}`);
  }
  return { concept: glossaryRow("the runs", "section 5 runs collapse"), names };
})();

/** The contract check names, from section 2's list. Printed to a reader and ruled keep + gloss. */
const CHECK_NAMES: readonly string[] = [
  ...one(/the check-name strings \(([^)]+)\)/u, SECTION_2_PROSE, "section 2 check names")[1]!.matchAll(/`([^`]+)`/gu),
].map((name) => name[1]!);

/** The method names section 2 lists as contract identifiers (`/wilson`, `/binary-instrument`). */
const METHOD_NAMES: readonly string[] = [
  ...one(/registry URIs \(([^;]+);/u, SECTION_2_PROSE, "section 2 method identifiers")[1]!.matchAll(/`\/([^`]+)`/gu),
].map((name) => name[1]!);

/** The sealed field names section 2 lists. A field whose plural is another sealed field
 * (`disclosure`, `disclosures`) is matched in the singular only. */
const SEALED_FIELDS: ReadonlySet<string> = new Set([
  ...one(/JSON field names in every sealed record, including ([^;]+);/u, SECTION_2_PROSE, "section 2 field names")[1]!.matchAll(/`([^`]+)`/gu),
].map((name) => name[1]!));

/** Names section 4 rules for a reader, split where a cell names several (`A / B`, `A … B`). */
function ruledNames(cell: string): string[] {
  const quoted = [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
  const source = quoted.length > 0 && /^(?:Table caption )?`[^`]+`$/u.test(cell) ? quoted.join(" / ") : cell;
  return plain(source.replace(/\((?:the record|second heading|column headers?|as a bare modifier|[^)]*`[^)]*)\)/gu, ""))
    .split(/\s*\/\s*|\s*…\s*/u)
    .map((name) => name.replace(/[.:]+$/u, "").trim())
    .filter((name) => name !== "" && name !== "—" && !/[<>]/u.test(name));
}

const RENAMES = /^rename/u;
const HIDES = /^hide/u;

/** Section 5's collapses, stated in prose right after the glossary table:
 * `"runs the judges disagreed on"` collapses `conflicted` and *assembly dissent*;
 * `"the runs"` collapses *Matrix accounting* and *completeness/attrition*. */
const STATED_COLLAPSES: ReadonlyMap<GlossaryRow, readonly string[]> = (() => {
  const match = one(
    /\*\*"([^"]+)"\*\* collapses `([^`]+)` \([^)]+\) and \*([^*]+)\* \([^)]+\)[^;]*; and \*\*"([^"]+)"\*\* collapses \*([^*]+)\* and \*([^*]+)\*/u,
    SECTION_5_PROSE,
    "section 5 stated collapses",
  );
  return new Map<GlossaryRow, readonly string[]>([
    [glossaryRow(match[1]!, "section 5 stated collapses"), [match[2]!, match[3]!]],
    [glossaryRow(match[4]!, "section 5 stated collapses"), [match[5]!, ...match[6]!.split("/").map((part) => part.trim())]],
  ]);
})();

/** The section 5 concept a section 4 rename row names: either its reader-facing name is that
 * concept's own name (or licensed collapse name), or its retired term is one of the terms section 5
 * collapses into the concept (`Completeness` / `Attrition` -> **the runs**). */
function conceptOf(row: RulingRow): GlossaryRow | undefined {
  if (!RENAMES.test(row.ruling)) return undefined;
  const names = new Set(ruledNames(row.name).map((name) => name.toLowerCase()));
  const byName = GLOSSARY.find((entry) => names.has(entry.name));
  if (byName !== undefined) return byName;
  if (RUNS_COLLAPSE.names.some((licensed) => names.has(licensed.toLowerCase()))) return RUNS_COLLAPSE.concept;
  const terms = new Set(ruledNames(row.term).map((term) => term.toLowerCase()));
  for (const [concept, collapsed] of STATED_COLLAPSES) {
    if (collapsed.some((entry) => terms.has(entry.toLowerCase()))) return concept;
  }
  return undefined;
}

/**
 * Every other name of each section 5 concept: its contract spellings, the names section 4 retires
 * for it, and `CAS` for evidence file. Hidden nouns are left to assertion 1 so one occurrence is not
 * reported twice, and a concept's own name is never its alias.
 *
 * A contract spelling section 5 capitalizes (`Report`) is a record's proper name and is matched
 * without a plural, which would otherwise read the verb "reports" as the record.
 */
const ALIASES: ReadonlyMap<GlossaryRow, readonly { readonly alias: string; readonly inflects: boolean }[]> = new Map(GLOSSARY.map((row) => {
  const retired = RULINGS.filter((ruling) => conceptOf(ruling) === row).flatMap((ruling) => ruledNames(ruling.term));
  const collapsed = STATED_COLLAPSES.get(row) ?? [];
  const renamed = HIDDEN.renamed.concept === row ? [HIDDEN.renamed.noun, HIDDEN.renamed.from] : [];
  const hidden = new Set(HIDDEN.hidden.map((noun) => noun.toLowerCase()));
  const aliases = new Map<string, { alias: string; inflects: boolean }>();
  for (const alias of [...row.contractSpellings, ...collapsed, ...retired, ...renamed]) {
    const key = alias.toLowerCase();
    if (key === row.name || hidden.has(key) || aliases.has(key)) continue;
    aliases.set(key, { alias, inflects: !(row.contractSpellings.includes(alias) && /^[A-Z]/u.test(alias)) });
  }
  return [row, [...aliases.values()]];
}));

/** A name as section 4 and section 5 are compared: markup off, lowercase, a trailing plural off. */
function normalized(name: string): string {
  return plain(name).toLowerCase().replace(/(?<=[a-z])s$/u, "");
}

/**
 * Assertion 2 over the spec, as section 7 words it: "It asserts over §4's **Reader-facing name**
 * column, with the rows §5's headings rule marks as headings or column headers as its exception
 * set." A section 4 row presents a section 5 concept when its reader-facing name is the concept's,
 * when a term it retires is one of the concept's contract spellings or a term section 5 collapses
 * into it, or when its note marks it a heading form of the concept. Such a row must give the
 * concept its own name, or a name that contains it (section 5: a heading that *contains* a canonical
 * name "is not in this class and needs no exception"). The exceptions are the heading forms that
 * point back to the concept, and the names section 5 licenses for **the runs**. Every other row is
 * returned as a second name.
 */
function secondNamesInSectionFour(): string[] {
  const findings: string[] = [];
  for (const row of RULINGS) {
    const names = ruledNames(row.name);
    if (names.length === 0) continue;
    const whole = plain(row.name);
    const terms = ruledNames(row.term).map(normalized);
    const concepts = new Set<GlossaryRow>(HEADING_FORMS.filter((form) => form.name === whole).map((form) => form.concept));
    for (const entry of GLOSSARY) {
      const spellings = [...entry.contractSpellings, ...(STATED_COLLAPSES.get(entry) ?? [])].map(normalized);
      if (names.some((name) => normalized(name) === normalized(entry.name)) || terms.some((term) => spellings.includes(term))) {
        concepts.add(entry);
      }
    }
    for (const concept of concepts) {
      if (HEADING_FORMS.some((form) => form.name === whole && form.concept === concept)) continue;
      if (concept === RUNS_COLLAPSE.concept && RUNS_COLLAPSE.names.includes(whole)) continue;
      for (const name of names) {
        if (!termPattern(concept.name).test(name)) findings.push(`section ${row.section} "${row.term}" presents ${concept.name} as "${name}"`);
      }
    }
  }
  return findings;
}

/**
 * Words that also name a different, ruled thing on some surfaces. Restated rather than derived
 * because section 4 rules these by example, not as a token: the generated strings inflect them
 * ("trust anchors you supplied"), and section 4 names the page only by its masthead. Each entry says
 * which ruling it defers to and where it applies.
 */
const OTHER_SENSES: readonly { readonly phrase: RegExp; readonly surfaces: "all" | "report assets"; readonly ruling: string }[] = [
  // Section 4.2: "Trust material" becomes "Trust anchors you supply": root certificates the reader
  // supplies, not the timestamp proof a bundle carries.
  { phrase: /\btrust\s+anchors?\b/giu, surfaces: "all", ruling: "4.2 Trust material" },
  // Section 4.1 keeps "Colophon report" as the page's masthead noun, so on the report assets a
  // lowercase "report" is the page and the sealed record is the capitalized "Report". The reader
  // tool never names the page, so there "report" in either case is the record.
  { phrase: /(?<![A-Za-z])report(?![A-Za-z])/gu, surfaces: "report assets", ruling: "4.1 Colophon report" },
  // Section 4.2 keeps "present rather than verified" in usage() and uses "verify" for checking an
  // RFC 3161 or OpenTimestamps proof against supplied trust anchors ("do not verify this timestamp
  // proof"), which is a cryptographic signature/time check, not recomputing the bundle's checks.
  { phrase: /\bdo\s+not\s+verify\s+this\s+timestamp\s+proof\b/giu, surfaces: "all", ruling: "4.2 Trust material / timestamp proof" },
];

// ---------------------------------------------------------------------------
// The surfaces, rendered
// ---------------------------------------------------------------------------

/** Every reader-facing surface in `check` under spec section 1. The product's workspace `verify` output
 * (`core/src/cli/verify-human.ts`) and web verification card (`web/src/components/verification-form.tsx`)
 * are not scanned (spec section 4.2, v1.14, #5241): this package cannot render either, and the ruling
 * reaches only their timestamp-proof block, not the whole surface. The product prints that block's
 * note and coverage lines with this package's `timestampProofEvaluationNote` and
 * `renderTimestampCoverage`, which `READER_RENDERS` reaches; the web card's copy is held to this
 * package's source by its own tests. */
const REPORT_ASSETS = ["index.html", "README.md", "share.txt", "badge.svg", "social-card.svg"] as const;
const READER_SURFACES = ["colophon-check usage", "colophon-check stdout", "colophon-check stderr"] as const;
type Surface = (typeof REPORT_ASSETS)[number] | (typeof READER_SURFACES)[number];

/** The format whose page this test scans. A newer supported format is a new page, so the surface
 * inventory below fails until this is moved to it and its violations are recorded. */
const SCANNED_FORMAT = BUNDLE_V10_FORMAT;

/**
 * Every flag `colophon-check`'s usage text lists, and the rendering in `readerSurfaces` that reaches
 * the human output it adds. A flag the usage text gains is a new reader-facing output, so the
 * inventory check below fails until its output is rendered here and recorded in this map.
 */
const CLI_FLAGS: Readonly<Record<string, string>> = {
  "--json": "not scanned: `--json` keys and values are contract (spec section 2)",
  "--tsa-root": "READER_RENDERS: every anchor report the characterization suite builds, trust anchors supplied or not",
  "--ots-headers": "READER_RENDERS (chain-time anchors) and the malformed-headers refusal in readerSurfaces",
  "--freeze-repo": "FREEZE_RESULTS and the freeze note in readerSurfaces",
  "--identity-binding": "READER_RENDERS (both binding mechanisms) and the binding note in readerSurfaces",
  "--help": "the usage text, which `-h` and a bare invocation print too",
};

const goldenFacts = await goldenInput(SCANNED_FORMAT);
const ARMS = Object.keys((goldenFacts.report.results as { perSubject: { results: { arms: object } }[] })
  .perSubject[0]!.results.arms);
const sha = (character: string): string => character.repeat(64);

/** The golden facts with one method substituted, the way `report-prose-review.test.ts` reaches a
 * method branch. Not a bundle: only what `buildPublicAssets` reads. */
function withMethod(methodId: string, parameters: Record<string, string>, results: unknown, extra: object = {}): PublicAssetInput {
  const wrapped = { perSubject: [{ subjectSha256: goldenFacts.matrixSha256, results }] };
  return {
    ...goldenFacts,
    report: { ...goldenFacts.report, method: { id: methodId, version: "1", parameters }, results: wrapped },
    claim: { ...goldenFacts.claim, method: { ...goldenFacts.claim.method, id: methodId, parameters }, results: wrapped },
    ...extra,
  } as unknown as PublicAssetInput;
}

function zeroRate(): Record<string, unknown> {
  return { numerator: 0, denominator: 0, estimate: null, wilsonInterval: null, withheldReason: "zero-denominator" };
}

function zeroProjection(): Record<string, unknown> {
  return {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: zeroRate(), falseAccept: zeroRate(), falseReject: zeroRate(),
    instability: zeroRate(), parserInvalid: zeroRate(),
  };
}

function binaryInput(truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled"): PublicAssetInput {
  return withMethod(BENCHMARKING_METHOD_IDS.binaryInstrument, {}, {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority", measurementProfile: "binary-instrument@1",
      candidateClasses: ["factuality"], strata: ["core", "stress"], parserInvalidPolicy: "reject",
      truthAdmission, intervalAlpha: "0.05",
    },
    arms: Object.fromEntries(ARMS.map((armId, index) => [armId, {
      instrumentSha256: `sha256:${sha(String(index + 1))}`,
      ...zeroProjection(),
      byCandidateClass: { factuality: zeroProjection() },
      byStratum: { core: zeroProjection(), stress: zeroProjection() },
    }])),
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  }, {
    comparison: undefined,
    binaryQualification: {
      publicationGrade: truthAdmission !== "operator-only",
      truthAdmission,
      sourceManifestSha256: `sha256:${sha("d")}`,
      admissionManifestSha256: `sha256:${sha("e")}`,
      exclusions: [],
      instruments: ARMS.map((armId, index) => ({
        armId, instrumentSha256: `sha256:${sha(String(index + 1))}`, promptTemplateSha256: `sha256:${sha("f")}`,
      })),
    },
  });
}

/** One disclosure entry per status, so each status's branch renders. */
function disclosureSection(): object {
  const statuses = [
    { status: "measured-here", statement: "Pinned by the harness manifest.", evidence: [{ role: "pinned-configuration", digest: { sha256: sha("4") } }] },
    { status: "disclosed-by-publisher", statement: "Stated by the publisher.", sources: [{ uri: "https://example.com/model-card" }] },
    { status: "undisclosed", reason: "not-stated" },
  ];
  const keys = ["ingestion-model", "retrieval-config", "answer-model", "answer-prompt", "judge-model", "judge-prompt"];
  return {
    recordSha256: sha("5"),
    specification: SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
    subjectSha256: sha("6"),
    variables: Object.fromEntries(keys.map((key, index) => [key, statuses[index % statuses.length]])),
  };
}

/**
 * Every report page this suite reads. One profile per method `buildPublicAssets` projects, plus the
 * conditional branches a published page can reach: every adverse fact, the zero-judged sentence,
 * rehearsal, task selection, dataset coverage, the six-variable section, the quiet page, and the
 * three truth-admission wordings.
 */
const REPORT_PROFILES: Readonly<Record<string, PublicAssetInput>> = {
  [BENCHMARKING_METHOD_IDS.wilson]: goldenFacts,
  "wilson, every conditional branch": {
    ...goldenFacts,
    matrix: {
      ...goldenFacts.matrix,
      completeness: { ...goldenFacts.matrix.completeness, runOutcome: "partial" },
      attrition: { ...goldenFacts.matrix.attrition, asymmetryFlags: ["unequal-expiry"] },
    },
    report: {
      ...goldenFacts.report,
      results: {
        perSubject: [{
          subjectSha256: goldenFacts.matrixSha256,
          results: {
            arms: Object.fromEntries(ARMS.map((armId, index) => [armId, {
              n: index === 0 ? 0 : 3, passRate: "0.0000", wilsonInterval: { low: "0.0000", high: "0.0000" },
            }])),
            conflicted: { count: 1, cellKeys: ["cell-a"] },
          },
        }],
      },
    },
    claim: {
      ...goldenFacts.claim,
      conflicted: { count: 1, cellKeys: ["cell-a"] },
      rehearsal: { previewCount: 2, timestamps: ["2026-01-01T00:00:00Z"] },
      taskSelection: { mode: "claimant-chosen" },
      terminalBench21Comparability: { selectedTaskCount: 3, datasetTaskCount: 89 },
      disclosure: disclosureSection(),
    },
    dissentCellKeys: ["cell-a"],
  } as unknown as PublicAssetInput,
  "wilson, no adverse fact": {
    ...goldenFacts,
    report: { ...goldenFacts.report, limitations: [] },
    claim: { ...goldenFacts.claim, limitations: [] },
  } as unknown as PublicAssetInput,
  [BENCHMARKING_METHOD_IDS.pairedDelta]: withMethod(
    BENCHMARKING_METHOD_IDS.pairedDelta,
    { baseline: ARMS[0]!, candidate: ARMS[1]!, alpha: "0.05" },
    { pairs: 3, delta: "0.083333", interval: { alpha: "0.05", low: "-0.041667", high: "0.208333" }, reasons: [], conflicted: { count: 0, cellKeys: [] } },
  ),
  [BENCHMARKING_METHOD_IDS.pairedMajorityDelta]: withMethod(
    BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
    { alpha: "0.05" },
    { baseline: ARMS[0]!, candidate: ARMS[1]!, n: 3, delta: null, interval: null, reasons: ["insufficient-pairs"], conflicted: { count: 0, cellKeys: [] } },
  ),
  [BENCHMARKING_METHOD_IDS.pairwiseDisagreement]: withMethod(
    BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
    { alpha: "0.05" },
    {
      pairs: [
        { armA: ARMS[0]!, armB: ARMS[1]!, n: 3, disagreements: 1, rate: "0.3333", interval: { lower: "0.0100", upper: "0.7900", alpha: "0.05" } },
        { armA: ARMS[1]!, armB: ARMS[0]!, n: 0, disagreements: 0, rate: null, interval: null },
      ],
      conflicted: { count: 0, cellKeys: [] },
    },
  ),
  [BENCHMARKING_METHOD_IDS.binaryInstrument]: binaryInput("two-human-unanimous"),
  "binary-instrument, operator-only": binaryInput("operator-only"),
  "binary-instrument, screened-operator-sampled": binaryInput("screened-operator-sampled"),
};

/** A minimal snapshot for the CLI's `verify` seam; the freeze seam below never reads it. */
function verifiedAs(verification: PublicBundleVerificationResult): VerifiedPublicBundleSnapshot {
  const bytes = new TextEncoder().encode("{}");
  return {
    verification,
    snapshot: {
      manifest: { format: "benchmark-product-public-bundle/2", files: [{ path: "bundle.json", sha256: sha("0"), bytes: bytes.length }] },
      bytes,
      identity: sha("0"),
      fileBytes: new Map([["bundle.json", bytes]]),
    },
  } as unknown as VerifiedPublicBundleSnapshot;
}

const CLASSIC = {
  identity: sha("a"),
  benchmarkSha256: sha("b"), runSha256: sha("c"), matrixSha256: sha("d"), reportSha256: sha("e"), reportEnvelopeSha256: sha("f"),
};
const SIX = ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"];
const PUBLISHER_KEY = "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX";
const SIGNERS: readonly PublicBundleSigner[] = [
  { role: "publisher", identity: "urn:publisher", keyId: PUBLISHER_KEY, custody: "undeclared", keyFingerprint: `sha256:${sha("7")}` },
  { role: "automated-grader", identity: "urn:grader", keyId: "urn:key:grader", custody: "same-operator" },
  { role: "human-reviewer", identity: "urn:reviewer", keyId: "urn:key:reviewer", custody: "undeclared" },
  { role: "human-reviewer", identity: "urn:reviewer-2", keyId: "urn:key:reviewer-2", custody: "undeclared" },
  { role: "label-admission", identity: "urn:admission", keyId: "urn:key:admission", custody: "same-operator" },
] as unknown as readonly PublicBundleSigner[];

function binding(mechanism: "dns-txt" | "well-known-url"): VerifiedDomainBinding {
  return {
    format: "colophon-domain-binding/1",
    domain: "example.com",
    keyId: PUBLISHER_KEY,
    mechanism,
    statedAt: "2026-01-01T00:00:00Z",
    proof: domainBindingProof("example.com", PUBLISHER_KEY, mechanism),
    confirmation: "key-signature-only",
  } as VerifiedDomainBinding;
}

function metadataFirst(notFetched: number): PublicBundleVerificationResult {
  return {
    format: "benchmark-product-public-bundle/5",
    identity: `sha256:${sha("a")}`,
    checks: ["manifest", "evidence-closure", "artifact-integrity", "signature-validity", "matrix-rederivation", "report-verification", "claim-consistency"],
    benchmarkDigest: `sha256:${sha("b")}`, manifestDigest: `sha256:${sha("c")}`, cohortDigest: `sha256:${sha("d")}`,
    matrixDigest: `sha256:${sha("e")}`, reportDigest: `sha256:${sha("f")}`,
    evidenceRecords: 12, artifacts: 5, verifiedSignerKeyIds: [],
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched", verified: 2, notFetched,
      notFetchedDigests: Array.from({ length: notFetched }, (_, index) => sha(String(index + 1))),
    },
  } as unknown as PublicBundleVerificationResult;
}

/** Every human stdout shape this suite renders itself: one per closure, every anchor report the
 * characterization suite builds, each signer and binding form. */
const READER_RENDERS: readonly string[] = [
  renderVerifiedBundle({ format: "benchmark-product-public-bundle/4", checks: SIX, ...CLASSIC } as PublicBundleVerificationResult),
  renderVerifiedBundle(metadataFirst(1)),
  renderVerifiedBundle(metadataFirst(3)),
  // A report carrying an invalid anchor is refused, not rendered; its refusal is in the pins.
  // Render both with and without `disclosure-specification` so `CHECK_SUBJECTS` reaches every
  // active check subject.
  ...Object.values(ANCHOR_CASES)
    .map((report) => report() as IntegrityAnchorsReport)
    .filter((report) => report.invalid.length === 0)
    .map((report) => renderVerifiedBundle({
      format: "benchmark-product-public-bundle/7",
      checks: [...SIX, "integrity-anchors"],
      ...CLASSIC,
      anchors: report,
    } as PublicBundleVerificationResult)),
  renderVerifiedBundle({
    format: "benchmark-product-public-bundle/8",
    checks: [...SIX, "integrity-anchors", "disclosure-specification"],
    ...CLASSIC,
  } as PublicBundleVerificationResult),
  renderVerifiedBundle({
    format: BUNDLE_V10_FORMAT,
    capabilities: ["external-import"],
    checks: expectedChecks(["external-import"]),
    ...CLASSIC,
  } as unknown as PublicBundleVerificationResult),
  renderVerifiedBundle({ format: "benchmark-product-public-bundle/4", checks: SIX, ...CLASSIC, signers: SIGNERS } as PublicBundleVerificationResult),
  renderVerifiedBundle(
    { format: "benchmark-product-public-bundle/4", checks: SIX, ...CLASSIC, signers: SIGNERS } as PublicBundleVerificationResult,
    binding("dns-txt"),
  ),
  renderVerifiedBundle(
    { format: "benchmark-product-public-bundle/4", checks: SIX, ...CLASSIC, signers: SIGNERS } as PublicBundleVerificationResult,
    binding("well-known-url"),
  ),
];

const FREEZE_RESULTS: readonly FreezeRepoVerificationResult[] = [
  { ok: true, executableBitChecked: true, bundleIdentity: sha("a"), commitId: sha("8").slice(0, 40), fileCount: 30, differences: [] },
  {
    ok: false, executableBitChecked: false, executableBitSkipped: "not-recorded", bundleIdentity: sha("a"), commitId: sha("8").slice(0, 40), fileCount: 30,
    differences: [{ kind: "missing", path: "matrix.json" }, { kind: "unexpected", path: "extra.txt" }, { kind: "changed", path: "index.html" }],
  },
  { ok: true, executableBitChecked: false, executableBitSkipped: "not-probed", bundleIdentity: sha("a"), commitId: sha("8").slice(0, 40), fileCount: 30, differences: [] },
  { ok: true, executableBitChecked: false, bundleIdentity: sha("a"), commitId: sha("8").slice(0, 40), fileCount: 30, differences: [] },
];

interface CharacterizationPin {
  readonly human?: { readonly stdout: string; readonly stderr: string };
}

async function readerSurfaces(): Promise<Record<(typeof READER_SURFACES)[number], string[]>> {
  const usage = await runVerifierCli([]);
  const stdout: string[] = [...READER_RENDERS];
  const stderr: string[] = [];
  const pins = JSON.parse(readFileSync(
    new URL("./characterization/testing/checker-outputs.expected.json", import.meta.url),
    "utf8",
  )) as Record<string, CharacterizationPin>;
  for (const pin of Object.values(pins)) {
    if (pin.human === undefined) continue;
    stdout.push(pin.human.stdout);
    stderr.push(pin.human.stderr);
  }
  const verified = async () => verifiedAs({ format: "benchmark-product-public-bundle/4", checks: SIX, ...CLASSIC, signers: SIGNERS } as PublicBundleVerificationResult);
  for (const freeze of FREEZE_RESULTS) {
    const run = await runVerifierCli(["bundle", "--freeze-repo", "repo"], { verify: verified, freezeRepo: () => freeze });
    stdout.push(run.stdout);
  }
  // The two notes, together, and the operational refusals.
  const notes = await runVerifierCli(["bundle", "--freeze-repo", "repo", "--identity-binding", "binding.json"], {
    verify: verified,
    readFile: () => new Uint8Array([123]),
    freezeRepo: () => { throw new Error("the bundle declares no licence"); },
  });
  stdout.push(notes.stdout);
  stderr.push(notes.stderr);
  const headers = await runVerifierCli(["bundle", "--ots-headers", "headers.txt"], {
    readFile: () => new TextEncoder().encode("not a header line\n"),
  });
  stderr.push(headers.stderr);
  return { "colophon-check usage": [usage.stderr], "colophon-check stdout": stdout, "colophon-check stderr": stderr };
}

// ---------------------------------------------------------------------------
// Reader text, and what is shown without being named
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, "&");
}

/** HTML or SVG to one reader block per line: verbatim blocks out, inline elements merged into the
 * block that holds them, and the attributes a reader is given (`alt`, `aria-label`, `title`) kept.
 * An SVG `<metadata>` element is a machine-readable header (`verified=true; scope=...`), not prose. */
function markupText(markup: string): string {
  const body = markup.replace(/<(style|script|pre|code|metadata)\b[^>]*>[\s\S]*?<\/\1>/giu, "\n");
  const attributes = [...body.matchAll(/\s(?:alt|aria-label|title)="([^"]*)"/giu)].map((match) => match[1]!);
  const blocks = body
    .replace(/<\/?(?:a|span|strong|em|b|i|abbr|small|sup|sub)\b[^>]*>/giu, "")
    .split(/<[^>]*>/u);
  return [...attributes, ...blocks].map((block) => decodeEntities(block).replace(/\s+/gu, " ").trim()).filter((block) => block !== "").join("\n");
}

/** Markdown to reader lines: fenced and indented code out, inline code out, link targets out. */
function markdownText(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*\n[\s\S]*?^```$/gmu, "")
    .split("\n")
    .filter((line) => !line.startsWith("    "))
    .map((line) =>
      blankInlineJson(line)
        .replace(/`[^`]*`/gu, " ")
        .replace(/\]\([^)]*\)/gu, "]")
        .replace(/\\([\\[\]()*_`|#!])/gu, "$1")
        .replace(/(https?)\\:\/\//giu, "$1://")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

function readerText(surface: Surface, raw: string): string {
  if (surface === "index.html" || surface.endsWith(".svg")) return markupText(raw);
  if (surface === "README.md") return markdownText(raw);
  return raw;
}

/** A name as a pattern: words joined by any run of spaces or hyphens, so a wrapped line, a
 * hyphenated spelling (`parser-invalid`) and a spaced one (`Parser invalid`) are one name. */
function phrase(name: string): string {
  return name.split(/[\s-]+/u).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s-]+");
}

/** Shown, not named. Each is replaced by a same-length run of spaces so line positions hold. */
const SHOWN: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu,
  /\b(?:urn|did:key):[^\s,;)"']+/giu,
  /<identifier: see --json>(?::[\w-]+)?/gu,
  /(?:sha256:)?\b[0-9a-f]{64}\b/giu,
  /(?<![\w/-])(?:[\w.-]+\/)*[\w.-]+\.(?:jsonl|json|bin|html|svg|txt|md)(?:#[\w-]+)?/giu,
  /@[\w-]+\/[\w.@-]+/gu,
  /\bcolophon-(?:check|verify)\b/gu,
  /(?<![\w-])--[\w-]+/gu,
  // Dotted field paths (`trust.evaluators.<name>`, `headline.baseline.passRate`) and the
  // hyphenated path labels a refusal leads with (`report-envelope: `): contract, printed as written.
  /(?<![\w.])[A-Za-z][\w-]*(?:\.[A-Za-z0-9<][\w<>:-]*)+/gu,
  /(?<![\w-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?=: )/gu,
  // Identifiers presented without their origin (`disclosure/six-variable/v1`, `rfc3161-tsa/v1`).
  /(?<![\w/.@-])[A-Za-z0-9][\w.@-]*(?:\/[\w.@-]+){2,}/gu,
  /(?<![\w/.@-])[A-Za-z0-9][\w.@-]*\/v\d[\w.]*/gu,
  // Method identifiers by name, alone or as `name@version` (spec section 2).
  new RegExp(`(?<![\\w-])(?:${METHOD_NAMES.map(phrase).join("|")})(?:@\\d+)?(?![\\w-])`, "gu"),
  // Only the hyphenated check names, and `disclosure-specification` only as written: `phrase` would
  // also mask a spaced "disclosure specification", a noun section 5 hides, wherever reader prose
  // printed it. `manifest` and `trust` are plain words in reader prose ("trust anchors") and carry
  // no inherited name.
  new RegExp(
    `(?<![\\w-])(?:${CHECK_NAMES.filter((name) => name.includes("-") && name !== "disclosure-specification").map(phrase).join("|")})(?![\\w-])`,
    "gu",
  ),
  /(?<![\w-])disclosure-specification(?![\w-])/gu,
];

const HIDDEN_PATTERNS = HIDDEN.hidden.map((noun) => ({ name: noun, pattern: termPattern(noun) }));
const ALIAS_PATTERNS = [...ALIASES].flatMap(([concept, aliases]) =>
  aliases.map(({ alias, inflects }) => ({ concept, name: concept.name, alias, pattern: termPattern(alias, inflects) })));

function wholePhrase(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${phrase(name)}(?![A-Za-z0-9])`, "giu");
}

/**
 * Names section 4 rules for a reader that carry an inherited word: every reader-facing name, and
 * the current term of a row that keeps it. Set aside before the second-name scan, so a ruled name
 * is not read as the inherited word inside it (the kept caption `Exact wilson@1 values from the
 * sealed Report`). Only names that carry such a word, so a ruled name that is a common phrase
 * ("The claim") cannot cut an inherited one ("the Claim package") in two. Not applied to the
 * hidden-term scan: a ruled name carrying a hidden noun would be the spec contradicting itself.
 */
const RULED: readonly RegExp[] = [...new Set(RULINGS.flatMap((row) => {
  const names = ruledNames(row.name);
  return RENAMES.test(row.ruling) || HIDES.test(row.ruling) || names.length > 0 ? names : ruledNames(row.term);
}))]
  .filter((name) => ALIAS_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(name)))
  .sort((left, right) => right.length - left.length)
  .map(wholePhrase);

/**
 * Spans a second-name match inside is not counted against a concept. A hide row's term is the
 * hidden-term scan's business. A term section 4 retires for one concept is that concept's finding,
 * not every concept whose word it contains (`Report conflicts` is the runs the judges disagreed on,
 * not the result). And a rename + gloss row licenses its inherited word once, in parentheses after
 * the reader-facing name (spec section 3): `timestamp proof (anchor)`.
 */
const SET_ASIDE: readonly { readonly pattern: RegExp; readonly owner?: GlossaryRow }[] = RULINGS.flatMap((row) => {
  if (HIDES.test(row.ruling)) return ruledNames(row.term).map((term) => ({ pattern: wholePhrase(term) }));
  const concept = conceptOf(row);
  if (concept === undefined) return [];
  const retired = ruledNames(row.term).map((term) => ({ pattern: wholePhrase(term), owner: concept }));
  const glosses = /^rename \+ gloss/u.test(row.ruling)
    ? ruledNames(row.name).flatMap((name) => ruledNames(row.term).map((term) => ({
      pattern: new RegExp(`(?<![A-Za-z0-9])${phrase(name)}\\s*\\(\\s*${phrase(term)}(?:e?s)?\\s*\\)`, "giu"),
    })))
    : [];
  return [...retired, ...glosses];
});

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/gu, " "));
}

/** Blanks in `target` every span `pattern` matches in `source`, a same-length text it was masked from. */
function blankWhere(target: string, source: string, pattern: RegExp): string {
  let result = target;
  for (const match of source.matchAll(pattern)) {
    result = result.slice(0, match.index) + " ".repeat(match[0].length) + result.slice(match.index + match[0].length);
  }
  return result;
}

/** A term as a whole word or phrase, any case, with a plural on its last word where it inflects.
 * Identifier-shaped spellings (`parserInvalid`, `cellKey`) match only as written, and so does a
 * field whose plural is a different sealed field (`disclosure`, `disclosures`). */
function termPattern(term: string, inflects = true): RegExp {
  const identifier = /[a-z][A-Z]|[./]/u.test(term);
  const plural = inflects && !identifier && !SEALED_FIELDS.has(`${term}s`);
  return new RegExp(
    `(?<![A-Za-z0-9])${phrase(term)}${plural ? "(?:e?s)?" : ""}(?![A-Za-z0-9])`,
    identifier ? "gu" : "giu",
  );
}

/** Every string a sealed record carries, longest first. Printed verbatim, they are the record's
 * words, not this package's: contract under spec section 2, and kept as-is by section 4.1's
 * venue-honesty row ("The existing verbatim limitation sentences are already plain"). */
function sealedValues(input: PublicAssetInput): readonly string[] {
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 3) values.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(input);
  return [...values].sort((left, right) => right.length - left.length);
}

function blankValues(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    for (let index = result.indexOf(value); index >= 0; index = result.indexOf(value, index + value.length)) {
      const before = result[index - 1];
      const after = result[index + value.length];
      if ((before !== undefined && /[A-Za-z0-9]/u.test(before)) || (after !== undefined && /[A-Za-z0-9]/u.test(after))) continue;
      result = result.slice(0, index) + value.replace(/[^\n]/gu, " ") + result.slice(index + value.length);
    }
  }
  return result;
}

/** A sealed record printed inline as canonical JSON (`- Venue honesty: {...}`): the label before it
 * is reader text, the JSON is the record's bytes. `escapeMarkdown` escapes `[`, `]`, `*`, `_`, etc.
 * inside that inline JSON (`\"limits\":\[\"...\"\]`), so try unescaping Markdown punctuation too. */
function isInlineJsonTail(tail: string): boolean {
  for (const candidate of [tail, tail.replace(/\\([\\[\]()*_`|#!])/gu, "$1").replace(/(https?)\\:\/\//giu, "$1://")]) {
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      // Try next form.
    }
  }
  return false;
}

function blankInlineJson(text: string): string {
  return text.split("\n").map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "{" && line[index] !== "[") continue;
      if (isInlineJsonTail(line.slice(index))) {
        return line.slice(0, index) + " ".repeat(line.length - index);
      }
    }
    return line;
  }).join("\n");
}

/**
 * Section 4.2 keeps the reader tool's `Artifact content` block whole ("Already reader-shaped, and
 * the caveat under it is exemplary"). Its row names a block, not a phrase, by eliding the plain
 * words between its heading and its last line (`Artifact content … not fetched`); the block opens
 * with that heading line and continues through every indented line beneath it. Only such a row
 * names a block: a kept word (`Bundle`) keeps the word, not whatever a later output indents beneath
 * it, and an ellipsis inside a quoted string (`What is recomputed is …`) shortens the quotation.
 */
const KEPT_BLOCK_HEADINGS: ReadonlySet<string> = new Set(RULINGS
  .filter((row) => row.section === "4.2" && /^keep/u.test(row.ruling) && /^[^`…]+ … [^`…]+$/u.test(row.term))
  .flatMap((row) => ruledNames(row.term).slice(0, 1)));

function blankKeptBlocks(text: string): string {
  const lines = text.split("\n");
  let kept = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (KEPT_BLOCK_HEADINGS.has(trimmed)) {
      kept = true;
      return " ".repeat(line.length);
    }
    if (kept && line.startsWith(" ")) return " ".repeat(line.length);
    kept = false;
    return line;
  }).join("\n");
}

/** The smallest reader unit holding a match: its line, cut at the separators the surfaces use
 * between facts (` · `, `; `, ` | `, a sentence end), with Markdown markers off. */
function unitAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const offset = index - lineStart;
  const separator = / · |; | \| |(?<=[.?!]) (?=[A-Z0-9])/gu;
  let start = 0;
  let end = line.length;
  for (const match of line.matchAll(separator)) {
    if (match.index + match[0].length <= offset) start = match.index + match[0].length;
    else if (match.index >= offset) {
      end = match.index;
      break;
    }
  }
  return displayed(line.slice(start, end).replace(/^(?:#+|[-*|])\s+/u, "").replace(/\s+\|$/u, "").replace(/\*\*/gu, "").trim());
}

/** A unit as the ledger records it: a digest as `<sha256>` and inline record JSON as `{…}`, so one
 * label rendered over many records is one entry. */
function displayed(unit: string): string {
  const digests = unit.replace(/[0-9a-f]{64}/gu, "<sha256>");
  for (let index = 0; index < digests.length; index += 1) {
    if (digests[index] !== "{" && digests[index] !== "[") continue;
    if (isInlineJsonTail(digests.slice(index))) return `${digests.slice(0, index)}{…}`;
  }
  return digests;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

type Rule = "hidden term" | "second name";

interface Violation {
  readonly surface: Surface;
  readonly rule: Rule;
  /** The hidden noun, or the section 5 name of the concept presented under another name. */
  readonly name: string;
  /** Every distinct reader line carrying it, digests and identifiers left in, sorted. */
  readonly units: readonly string[];
}

function ledgerDifferences(
  observed: readonly Violation[],
  recorded: readonly KnownViolation[],
): readonly string[] {
  const actual = ledger(observed);
  const expected = ledger(recorded);
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  const diffs: string[] = [];
  for (const key of keys) {
    const seenUnits = actual[key];
    const recordedUnits = expected[key];
    if (seenUnits === undefined) {
      diffs.push(`stale known-violation entry (violation no longer observed): ${key}`);
      continue;
    }
    if (recordedUnits === undefined) {
      diffs.push(`new unrecorded violation: ${key} -> ${JSON.stringify(seenUnits)}`);
      continue;
    }
    for (const unit of seenUnits) {
      if (!recordedUnits.includes(unit)) diffs.push(`new violating unit under ${key}: ${JSON.stringify(unit)}`);
    }
    for (const unit of recordedUnits) {
      if (!seenUnits.includes(unit)) diffs.push(`stale recorded unit under ${key}: ${JSON.stringify(unit)}`);
    }
  }
  const seen = new Set<string>();
  for (const entry of recorded) {
    const key = ledgerKey(entry);
    if (seen.has(key)) diffs.push(`recorded twice: ${key}`);
    seen.add(key);
    if (!Object.hasOwn(OWNERS, entry.owner)) {
      diffs.push(`owner of ${key} is #${String(entry.owner)}, which OWNERS does not list`);
    }
    if (entry.units.length === 0) diffs.push(`no units recorded for ${key}`);
  }
  return diffs;
}

/** Section 4.1 applied to `check/src/assets.ts`: every report asset. */
const REPORT_VIOLATION_OWNER = 3862 as const;
/**
 * The reader tool's refusal lines and the recomputed-checks caveat (`CHECK_SUBJECTS` in
 * `outcome.ts`), ruled in spec section 4.2 (v1.13, *Refusal lines*): the human refusal line follows
 * section 5, the `--json` `message` keeps the refusing module's words, and a field path prints as
 * written. The one entry it still owns follows from that last rule, and it rules the entry out of
 * section 5's reach rather than retiring it.
 */
const READER_PROSE_AND_REFUSAL_OWNER = 5251 as const;

/** The `Timestamps` and `Timestamp coverage` blocks name each covered record by its claim anchor subject, so a reader meets "matrix". */
const TIMESTAMP_SUBJECT_OWNER = 5278 as const;

/** The issues on Jinn-Network/mono that own recorded violations: each either retires its entries
 * or rules them out of section 5's reach, and its change updates this ledger. */
const OWNERS = {
  [REPORT_VIOLATION_OWNER]: "Report page vocabulary",
  [TIMESTAMP_SUBJECT_OWNER]: "the subject label in the reader's timestamp blocks",
  [READER_PROSE_AND_REFUSAL_OWNER]: "a field path a refusal line prints as written",
} as const;

interface KnownViolation extends Violation {
  readonly owner: keyof typeof OWNERS;
}

const REPORT_ASSET_SET: ReadonlySet<string> = new Set(REPORT_ASSETS);

/** One rendered surface, and the sealed values printed in it. */
interface Rendered {
  readonly raw: string;
  readonly sealed?: readonly string[];
}

/** Scans reader text. A unit is reported as rendered, digests and identifiers left in, so the
 * ledger shows what a reader sees and what to fix. */
function scan(surface: Surface, rendered: readonly Rendered[]): Violation[] {
  const senses = OTHER_SENSES
    .filter((sense) => sense.surfaces === "all" || REPORT_ASSET_SET.has(surface))
    .map((sense) => sense.phrase);
  const found = new Map<string, { rule: Rule; name: string; units: Set<string> }>();
  for (const { raw, sealed = [] } of rendered) {
    const text = readerText(surface, raw);
    const record = (rule: Rule, name: string, index: number): void => {
      const key = `${rule}\u0000${name}`;
      const entry = found.get(key) ?? { rule, name, units: new Set<string>() };
      entry.units.add(unitAt(text, index));
      found.set(key, entry);
    };
    const shown = blankInlineJson(blankValues(SHOWN.reduce(blank, text), sealed));
    for (const { name, pattern } of HIDDEN_PATTERNS) {
      for (const match of shown.matchAll(pattern)) record("hidden term", name, match.index);
    }
    // Hidden nouns are blanked before the second scan, so one occurrence is reported once. Ruled
    // names and other senses are found in the text as written, since the masks above can cut one
    // (`wilson@1` is a method identifier inside the kept caption `Exact wilson@1 values from the
    // sealed Report`); every mask keeps positions, so a span found in `text` is the same span here.
    const named = [...RULED, ...senses].reduce(
      (masked, pattern) => blankWhere(masked, text, pattern),
      HIDDEN_PATTERNS.map(({ pattern }) => pattern).reduce(blank, blankKeptBlocks(shown)),
    );
    const spans = SET_ASIDE.flatMap(({ pattern, owner }) =>
      [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length, owner })));
    for (const { concept, name, pattern } of ALIAS_PATTERNS) {
      for (const match of named.matchAll(pattern)) {
        const end = match.index + match[0].length;
        const setAside = spans.some((span) => span.start <= match.index && end <= span.end && span.owner !== concept);
        if (!setAside) record("second name", name, match.index);
      }
    }
  }
  return [...found.values()].map(({ rule, name, units }) => ({ surface, rule, name, units: [...units].sort() }));
}

async function observedViolations(): Promise<Violation[]> {
  const decoder = new TextDecoder();
  const reports = Object.values(REPORT_PROFILES).map((input) => ({ assets: buildPublicAssets(input), sealed: sealedValues(input) }));
  const violations: Violation[] = [];
  for (const asset of REPORT_ASSETS) {
    violations.push(...scan(asset, reports.map(({ assets, sealed }) => ({ raw: decoder.decode(assets[asset]), sealed }))));
  }
  const reader = await readerSurfaces();
  for (const surface of READER_SURFACES) violations.push(...scan(surface, reader[surface].map((raw) => ({ raw }))));
  return violations;
}

function ledgerKey(violation: Violation): string {
  return `${violation.surface} · ${violation.rule} · ${violation.name}`;
}

function ledger(violations: readonly Violation[]): Record<string, readonly string[]> {
  return Object.fromEntries(violations.map((violation) => [ledgerKey(violation), violation.units]).sort(([left], [right]) => (left! < right! ? -1 : 1)));
}

/**
 * The observed ledger as source for `KNOWN_VIOLATIONS`, keeping each recorded owner. An entry the
 * ledger does not have yet prints `OWNER_REQUIRED`, which is defined nowhere, so a regenerated
 * ledger does not load until someone names the issue that owns the new violation.
 */
function printLedger(observed: readonly Violation[]): string {
  const owners = new Map(KNOWN_VIOLATIONS.map((known) => [ledgerKey(known), known.owner]));
  const sorted = [...observed].sort((left, right) => (ledgerKey(left) < ledgerKey(right) ? -1 : 1));
  return sorted.map((violation) => {
    const owner = owners.get(ledgerKey(violation));
    const ownerCode = owner === REPORT_VIOLATION_OWNER
      ? "REPORT_VIOLATION_OWNER"
      : owner === READER_PROSE_AND_REFUSAL_OWNER
        ? "READER_PROSE_AND_REFUSAL_OWNER"
        : owner === TIMESTAMP_SUBJECT_OWNER ? "TIMESTAMP_SUBJECT_OWNER" : "OWNER_REQUIRED";
    return [
      "  {",
      `    surface: ${JSON.stringify(violation.surface)}, rule: ${JSON.stringify(violation.rule)}, name: ${JSON.stringify(violation.name)},`,
      `    owner: ${ownerCode},`,
      "    units: [",
      ...violation.units.map((unit) => `      ${JSON.stringify(unit)},`),
      "    ],",
      "  },",
    ].join("\n");
  }).join("\n");
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  {
    surface: "README.md", rule: "hidden term", name: "Matrix",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Matrix SHA-256:",
      "Matrix asymmetry flags: 1.",
      "Matrix: Partial comparison",
      "Sealed Matrix accounting",
      "The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material.",
      "[Matrix record ( )]",
    ],
  },
  {
    surface: "README.md", rule: "hidden term", name: "catalog",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Raw records and catalogs",
      "Top-level records and catalogs",
      "[Evidence catalog ( )]",
      "[Verdict catalog ( )]",
    ],
  },
  {
    surface: "README.md", rule: "hidden term", name: "envelope",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "[Report signature envelope ( )]",
    ],
  },
  {
    surface: "README.md", rule: "hidden term", name: "projection",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "[Static-bundle projection ( )]",
    ],
  },
  {
    surface: "README.md", rule: "hidden term", name: "subject",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "subject: <sha256>",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "answer changed on rerun",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Instability:",
      "Per-item decisions, instability, and exclusions",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "answer could not be read",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Parser invalid:",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "configuration",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "2 arms",
      "Arm",
      "Arm pair",
      "Candidate (evidence-declaring arm): sample-uniform",
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
      "Sealed Report arm results",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "decided differently",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Disagreements",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "evidence file",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "[CAS record  ]",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "fingerprint",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Matrix SHA-256:",
      "Report SHA-256:",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "how the judges were qualified",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Registered configuration",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "judge",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Authenticated truth admission and instruments",
      "Exact instrument and prompt-template commitments",
      "Instrument: sha256:<sha256>",
      "Qualification facts are presented per instrument without comparative conclusions.",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "method",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim method and preregistration",
      "Claim method: method/binary-instrument @ 1",
      "Claim method: method/paired-delta @ 1",
      "Claim method: method/paired-majority-delta @ 1",
      "Claim method: method/pairwise-disagreement @ 1",
      "Claim method: method/wilson @ 1",
      "Report method and preregistration",
      "Report method: method/binary-instrument @ 1",
      "Report method: method/paired-delta @ 1",
      "Report method: method/paired-majority-delta @ 1",
      "Report method: method/pairwise-disagreement @ 1",
      "Report method: method/wilson @ 1",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "repeat",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "1 replicates",
      "baseline, replicate 1: Forecast 100% Yes",
      "baseline, replicate 1: Forecast 32% Yes",
      "baseline, replicate 1: Forecast 64% Yes",
      "sample-uniform, replicate 1: Forecast 50% Yes",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "run",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Across 3 paired cells, baseline had lower solverBrier in 3",
      "Claim conflicted cells: 1.",
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
      "Pass rate over judged cells",
      "Report conflicted cells: 1.",
      "incomplete cells remain accounted below.",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "runs the judges disagreed on",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim conflicted cells: 1.",
      "Claim conflicts",
      "Report conflicted cells: 1.",
      "Report conflicts",
      "Verification assembly dissent",
      "Verification assembly dissenting cells: 1.",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "the claim",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Stored Claim facts",
      "[Claim package ( )]",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "the result",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "None recorded in the sealed Report.",
      "Report SHA-256:",
      "Report conflicted cells: 1.",
      "Report disclosures",
      "Report limitations",
      "Report limitations: 5",
      "Report parameters:",
      "Report preregistered: yes",
      "Sealed Report arm results",
      "Sealed Report evidence contrast",
      "Sealed Report facts",
      "Sealed Report paired comparison",
      "Sealed Report pairwise disagreement panel",
      "The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material.",
      "[Report payload ( )]",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "the runs",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim attrition",
      "Claim completeness",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "what was pinned",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Six-variable disclosure",
    ],
  },
  {
    surface: "README.md", rule: "second name", name: "who ran this",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Venue honesty:",
    ],
  },
  {
    surface: "badge.svg", rule: "hidden term", name: "Matrix",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Matrix asymmetry 0",
      "Matrix asymmetry 1",
    ],
  },
  {
    surface: "badge.svg", rule: "second name", name: "configuration",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "2 arm pairs",
      "2 arms",
      "Exact configuration arm IDs: baseline",
    ],
  },
  {
    surface: "badge.svg", rule: "second name", name: "fingerprint",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Full Report SHA-256 <sha256>.",
      "Report SHA-256 <sha256>.",
    ],
  },
  {
    surface: "badge.svg", rule: "second name", name: "repeat",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "1 replicates",
    ],
  },
  {
    surface: "badge.svg", rule: "second name", name: "runs the judges disagreed on",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim conflicts 0",
      "Claim conflicts 1",
      "Report conflicts 0",
      "Report conflicts 1",
      "assembly dissent 0",
      "assembly dissent 1",
    ],
  },
  {
    surface: "badge.svg", rule: "second name", name: "the result",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Full Report SHA-256 <sha256>.",
      "Report 1a72e2614af4",
      "Report <sha256>",
      "Report SHA-256 <sha256>.",
      "Report limitations 0",
      "Report limitations 5",
      "Report …",
      "Report…",
    ],
  },
  // Ruled by #5251 (spec section 4.2, *Refusal lines*): a refusal prints a field path as written,
  // and `anchors` is the claim field that holds its timestamp proofs, so a reader meets the contract
  // spelling. `SHOWN` reads only dotted field paths as paths, so this one-word path is recorded.
  {
    surface: "colophon-check stderr", rule: "second name", name: "timestamp proof",
    owner: READER_PROSE_AND_REFUSAL_OWNER,
    units: [
      "colophon-check: the claim's field anchors does not agree with the records here",
    ],
  },
  // Owned by #5278. The `Timestamps` and `Timestamp coverage` blocks name each covered record by
  // its claim anchor subject (`lock`, `matrix`), so a reader meets "matrix".
  {
    surface: "colophon-check stdout", rule: "hidden term", name: "Matrix",
    owner: TIMESTAMP_SUBJECT_OWNER,
    units: [
      "matrix timestamp proof",
      "matrix: none — no timestamp proof was carried and none was promised",
      "matrix: timestamped",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "Matrix",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Exact per-arm attrition stored in the Matrix",
      "Matrix SHA-256",
      "Matrix asymmetry flags",
      "Matrix asymmetry flags: 1.",
      "Matrix expected",
      "Matrix floor",
      "Matrix judged",
      "Matrix record (matrix.json)",
      "Matrix run outcome",
      "Matrix: Partial comparison",
      "None recorded in the Matrix.",
      "Per-arm Matrix attrition",
      "Sealed Matrix accounting",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "assurance preset",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Assurance preset",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "assurance primitive",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Resolved assurance primitives",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "catalog",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Evidence catalog (evidence.json)",
      "Top-level records and catalogs",
      "Verdict catalog (verdicts.json)",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "envelope",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Report envelope SHA-256",
      "Report signature envelope (report-envelope.json)",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "projection",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Static-bundle projection (static-bundle.json)",
    ],
  },
  {
    surface: "index.html", rule: "hidden term", name: "subject",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Unverifiable axes, integrity tiers, and per-subject disclosures",
      "subject <sha256>",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "answer changed on rerun",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Per-item decisions and instability",
      "instability",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "answer could not be read",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Parser-invalid, infrastructure, and other exclusions",
      "parserInvalid",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "configuration",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "2 arms",
      "Arm",
      "Arm pair",
      "Arms and pinned configuration",
      "Authenticated task by arm comparison",
      "Candidate (evidence-declaring arm)",
      "Exact arm values stored in the Claim package",
      "Exact per-arm attrition stored in the Matrix",
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
      "Per-arm Matrix attrition",
      "Sealed Report arm results",
      "pairwise-disagreement@1 reports every unordered arm pair as a panel, with no baseline and no candidate.",
      "wilson@1 reports neutral per-arm facts only.",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "decided differently",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Disagreements",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "evidence file",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "CAS record (records/<sha256>.bin)",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "fingerprint",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Benchmark digest",
      "Matrix SHA-256",
      "Report SHA-256",
      "Report envelope SHA-256",
      "Run SHA-256",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "how the judges were qualified",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Registered configuration",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "judge",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Authenticated truth admission and instruments",
      "Exact instrument and prompt-template commitments",
      "Facts are presented per instrument without comparative conclusions.",
      "Instrument sha256:<sha256>",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "method",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim method",
      "Claim method and preregistration",
      "Report method",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "recompute",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Verify this report",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "repeat",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "1 replicates",
      "Replicates",
      "replicate 1",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "run",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Across 3 paired cells, baseline had lower solverBrier in 3",
      "Claim conflicted cells: 1.",
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
      "Pass rate over judged cells",
      "Report conflicted cells: 1.",
      "incomplete cells remain accounted below.",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "runs the judges disagreed on",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim conflicted cells: 1.",
      "Claim conflicts",
      "Dissenting cells",
      "Report conflicted cells: 1.",
      "Report conflicts",
      "Verification assembly dissent",
      "Verification assembly dissenting cells: 1.",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "the claim",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim package (claim-package.json)",
      "Exact arm values stored in the Claim package",
      "Stored Claim facts",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "the result",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Method and assurance facts stored in the Report",
      "None recorded in the sealed Report.",
      "Report <sha256>",
      "Report SHA-256",
      "Report conflicted cells: 1.",
      "Report disclosures",
      "Report limitations: 5",
      "Report parameters",
      "Report payload (report.json)",
      "Report preregistered",
      "Report references",
      "Sealed Report arm results",
      "Sealed Report evidence contrast",
      "Sealed Report facts",
      "Sealed Report limitations",
      "Sealed Report paired comparison",
      "Sealed Report pairwise disagreement panel",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "the runs",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim attrition",
      "Claim completeness",
      "Completeness and attrition",
      "Exact per-arm attrition stored in the Matrix",
      "Per-arm Matrix attrition",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "what was pinned",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Rehearsal disclosure",
      "Six-variable disclosure",
    ],
  },
  {
    surface: "index.html", rule: "second name", name: "where it ran",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Venue",
    ],
  },
  {
    surface: "share.txt", rule: "hidden term", name: "Matrix",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Matrix asymmetry 0",
      "Matrix asymmetry 1",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "configuration",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "2 arm pairs",
      "2 arms",
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "recompute",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "verify: index.html#verification with npx @colophon-claims/verify@0.1.0 <bundle-dir>.",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "repeat",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "1 replicates",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "run",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "No rate is stated for arm baseline: none of its cells reached a pass or fail verdict.",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "runs the judges disagreed on",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim conflicts 0",
      "Claim conflicts 1",
      "Report conflicts 0",
      "Report conflicts 1",
      "assembly dissent 0",
      "assembly dissent 1",
    ],
  },
  {
    surface: "share.txt", rule: "second name", name: "the result",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Report <sha256>.",
      "Report limitations 0",
      "Report limitations 5",
    ],
  },
  {
    surface: "social-card.svg", rule: "hidden term", name: "Matrix",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Matrix asymmetry 0",
      "Matrix asymmetry 1",
    ],
  },
  {
    surface: "social-card.svg", rule: "second name", name: "configuration",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "2 arm pairs",
      "2 arms",
      "Exact configuration arm IDs: baseline",
    ],
  },
  {
    surface: "social-card.svg", rule: "second name", name: "fingerprint",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Full Report SHA-256 <sha256>.",
      "Report SHA-256 <sha256>.",
    ],
  },
  {
    surface: "social-card.svg", rule: "second name", name: "repeat",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "1 replicates",
    ],
  },
  {
    surface: "social-card.svg", rule: "second name", name: "runs the judges disagreed on",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Claim conflicts 0",
      "Claim conflicts 1",
      "Report conflicts 0",
      "Report conflicts 1",
      "assembly dissent 0",
      "assembly dissent 1",
    ],
  },
  {
    surface: "social-card.svg", rule: "second name", name: "the result",
    owner: REPORT_VIOLATION_OWNER,
    units: [
      "Full Report SHA-256 <sha256>.",
      "Report 1a72e2614af4",
      "Report <sha256>",
      "Report SHA-256 <sha256>.",
      "Report limitations 0",
      "Report limitations 5",
      "Report …",
      "Report…",
    ],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the spec reads as this test expects", () => {
  test("section 5 hides nine nouns and renames CAS to evidence file", () => {
    expect(HIDDEN.hidden).toHaveLength(9);
    expect(HIDDEN.renamed.noun).toBe("CAS");
    expect(HIDDEN.renamed.concept.name).toBe("evidence file");
    // Section 4.1 carries the rename section 5 cites.
    expect(RULINGS.some((row) => row.term === HIDDEN.renamed.from && RENAMES.test(row.ruling)
      && row.name.toLowerCase() === HIDDEN.renamed.concept.name)).toBe(true);
  });

  test("the heading exception set is the section 4 rows that invoke the headings rule, and section 5 names the same rows", () => {
    expect(HEADING_FORMS.length).toBe(HEADINGS_RULE_AS_STATED.count);
    expect(HEADING_FORMS.map(({ name, concept }) => ({ name, concept: concept.name })))
      .toEqual(HEADINGS_RULE_AS_STATED.stated);
  });

  test("the four names section 5 licenses for the runs are section 4.1 rulings", () => {
    const ruled = RULINGS.filter((row) => row.section === "4.1").map((row) => plain(row.name));
    for (const name of RUNS_COLLAPSE.names) expect(ruled, name).toContain(name);
  });

  test("runs the judges disagreed on and decided differently stay two concepts", () => {
    const conflicted = glossaryRow("runs the judges disagreed on", "test");
    const decided = glossaryRow("decided differently", "test");
    expect(conflicted).not.toBe(decided);
    expect(conflicted.contractSpellings).toContain("conflicted");
    expect(decided.contractSpellings).toContain("disagreements");
    expect(ALIASES.get(conflicted)?.map(({ alias }) => alias)).not.toContain("disagreements");
    expect(ALIASES.get(decided)?.map(({ alias }) => alias)).not.toContain("conflicted");
  });

  test("no name is the alias of two concepts, and no concept's name is another's alias", () => {
    const owners = new Map<string, string>();
    for (const [row, aliases] of ALIASES) {
      for (const { alias } of aliases) {
        const key = alias.toLowerCase();
        expect(owners.get(key), `"${alias}" names both ${owners.get(key)} and ${row.name}`).toBeUndefined();
        owners.set(key, row.name);
      }
    }
    for (const row of GLOSSARY) expect(owners.get(row.name), row.name).toBeUndefined();
  });

  test("the check names section 2 lists are the ones section 4.2 rules keep and gloss", () => {
    const glossRow = RULINGS.find((row) => row.section === "4.2" && /keep \+ gloss/u.test(row.ruling));
    expect(glossRow).toBeDefined();
    expect([...glossRow!.term.matchAll(/`([^`]+)`/gu)].map((match) => match[1])).toEqual(CHECK_NAMES);
  });

  test("the only kept block section 4.2 names is the Artifact content block", () => {
    expect([...KEPT_BLOCK_HEADINGS]).toEqual(["Artifact content"]);
  });

  test("the reader tool's verdict verb is the shipped one, not the reserved placeholder", () => {
    const recompute = GLOSSARY.find((row) => row.concept === "Running the checks again over the bundle");
    expect(recompute?.name).toBe("recompute");
    expect(RULINGS.find((row) => row.section === "4.2" && row.term.startsWith("`Recomputed:"))?.ruling)
      .toMatch(/shipped/u);
    for (const output of READER_RENDERS) {
      expect(output).toMatch(/^Recomputed: \d+ of \d+ checks passed/u);
    }
  });
});

describe("section 4 presents each section 5 concept under one name", () => {
  test("every section 4 name for a concept is its own, a heading form of it, or a licensed name for the runs", () => {
    expect(secondNamesInSectionFour()).toEqual([]);
  });
});

describe("the matcher", () => {
  const scanText = (text: string): Violation[] => scan("share.txt", [{ raw: text }]);

  test("a hidden noun is found in any case and number, and once", () => {
    expect(scanText("The Matrix accounting. Two matrices? No: matrixes.").map(ledgerKey))
      .toEqual(["share.txt · hidden term · Matrix"]);
  });

  test("a file link, a digest, and a check name are shown, not named", () => {
    expect(scanText(`Open matrix.json; matrix-rederivation passed; sha256:${sha("a")}.`)).toEqual([]);
  });

  test("CAS is caught as a second name for evidence file", () => {
    expect(scanText("CAS record (records/x.bin)").map(ledgerKey)).toEqual(["share.txt · second name · evidence file"]);
  });

  test("the runs under its own name and its four licensed names is one name", () => {
    expect(scanText([`the runs`, ...RUNS_COLLAPSE.names].join(". "))).toEqual([]);
  });

  test("a heading form section 5's headings rule names is not a second name", () => {
    expect(scanText(HEADING_FORMS.map(({ name }) => name).join(". "))).toEqual([]);
  });

  test("an inherited name beside the reader-facing one is a second name", () => {
    expect(scanText("Configuration baseline. Arm baseline.").map(ledgerKey))
      .toEqual(["share.txt · second name · configuration"]);
  });
});

describe("reader-facing strings", () => {
  test("every asset buildPublicAssets writes is a surface this test reads", () => {
    for (const input of Object.values(REPORT_PROFILES)) {
      expect(Object.keys(buildPublicAssets(input)).sort()).toEqual([...REPORT_ASSETS].sort());
    }
  });

  test("every method buildPublicAssets projects has a page here, and it projects no other", () => {
    for (const method of Object.values(BENCHMARKING_METHOD_IDS)) {
      if (Object.hasOwn(REPORT_PROFILES, method)) continue;
      expect(() => buildPublicAssets(withMethod(method, {}, {})), method).toThrow(/has no bundle-asset projection/u);
    }
  });

  test("the page scanned is the newest format's: a new format is a new page", () => {
    expect(SCANNED_FORMAT).toBe(SUPPORTED_BUNDLE_FORMATS.at(-1));
  });

  test("every flag the usage text lists has its output rendered here", async () => {
    const usage = (await runVerifierCli([])).stderr;
    const flags = [...new Set([...usage.matchAll(/(?<![\w-])--[a-z][\w-]*/gu)].map((match) => match[0]))].sort();
    expect(flags).toEqual(Object.keys(CLI_FLAGS).sort());
  });

  test("carry exactly the recorded violations, each with its owner", async () => {
    const observed = await observedViolations();
    if (process.env["GLOSSARY_CONFORMANCE_PRINT"] === "1") console.log(printLedger(observed));
    expect(ledgerDifferences(observed, KNOWN_VIOLATIONS)).toEqual([]);
  });
});
