// SPDX-License-Identifier: Apache-2.0

import type { AnchorsResult, LifecycleResult, RecordSetReport, RecordSetSummary, ReferencesResult } from "./check-record-set.js";
import { UNKNOWN_KIND, printable } from "./results.js";
import type { CheckStatus, RecordCheckId, RecordReport, SignatureCounts } from "./results.js";

/** A file left unread because of its size. It counts as a failure. */
export interface UnreadFile {
  readonly file: string;
  readonly bytes: number;
}

export type RootProblemCode = "changed" | "missing" | "not-listed" | "not-regular" | "hard-link" | "unreadable" | "list-format";

/** One way the directory is not what the root commits to. */
export interface RootProblem {
  readonly code: RootProblemCode;
  readonly file: string;
  readonly detail: string;
}

/** What `--root` found, with every name from the input already printable. It says nothing about who published the digest. */
export interface RootReport {
  /** The digest given. */
  readonly digest: string;
  /** The top-level file that hashes to it. Absent when none does, which fails the run. */
  readonly list?: string;
  /** Entries in the list. */
  readonly listed: number;
  /** Whether the listed files were read. They are not when no list was found or it broke the format. */
  readonly checked: boolean;
  readonly problems: readonly RootProblem[];
  /** Listed files over the size limit: hashed and compared, and not parsed. */
  readonly notParsed: readonly UnreadFile[];
  /** Whether the bytes of the keys file are in the list. Absent when no keys were supplied. */
  readonly keys?: { readonly covered: true; readonly listedAs: string } | { readonly covered: false };
}

/** Everything the command read and decided, printed one way for a person and one for `--json`. */
export interface CommandReport {
  readonly target: string;
  /** Directory entries that are not files, and so were not read. */
  readonly notRead: number;
  readonly tooLarge: readonly UnreadFile[];
  readonly suppliedKeys: number;
  /** One per record, in the same order. */
  readonly files: readonly string[];
  readonly summary: RecordSetSummary;
  readonly records: readonly RecordReport[];
  /** Absent for one file, which is not a set. */
  readonly checks?: RecordSetReport["checks"];
  /** Present only with `--root`. */
  readonly root?: RootReport;
}

const LABEL_WIDTH = 15;
const NOT_A_SET = "not checked: one file is not a set";
const LISTED_FAILURES = 5;
const NO_IDENTITY = "skipped: no key was tied to an identity";

/** In the order the completeness line reports them. */
const ROOT_PROBLEM_PHRASES: Readonly<Record<RootProblemCode, string>> = {
  changed: "changed",
  missing: "missing",
  "not-listed": "not listed",
  "not-regular": "not regular",
  "hard-link": "hard-linked",
  unreadable: "unreadable",
  "list-format": "breaking the list format",
};

const SKIP_PHRASES: Readonly<Record<string, string>> = {
  "no-claimed-digest": "no digest claimed",
  "encoding-not-required": "not required by family",
  "not-a-record": "not records",
  "unknown-kind": "kind unknown",
};

/** Findings that say what a check did not cover, as opposed to what failed. */
const NOTES: ReadonlySet<string> = new Set([
  "records-not-reached",
  "references-not-read",
  "references-unavailable",
  "deliveries-without-observations",
  "anchor-time-not-evaluated",
  "anchor-pending",
  "anchor-subject-kind-unchecked",
]);

/** Written out because the discovery tree refuses locale-sensitive formatting. */
function number(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/gu, ",");
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${number(value)} ${value === 1 ? singular : plural}`;
}

function line(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`;
}

function skipReasons(records: readonly RecordReport[], id: RecordCheckId): string {
  const reasons = new Map<string, number>();
  for (const { checks } of records) {
    const check = checks.find((candidate) => candidate.id === id)!;
    if (check.status !== "skipped") continue;
    const code = check.findings[0]?.code ?? "unknown";
    const phrase = SKIP_PHRASES[code] ?? code;
    reasons.set(phrase, (reasons.get(phrase) ?? 0) + 1);
  }
  if (reasons.size === 1) return [...reasons.keys()][0]!;
  return [...reasons]
    .sort(([, left], [, right]) => right - left)
    .map(([phrase, times]) => `${number(times)} ${phrase}`)
    .join(", ");
}

function checkLine(label: string, id: RecordCheckId, report: CommandReport, passedAs = "passed"): string {
  const counts: Readonly<Record<CheckStatus, number>> = report.summary.checks[id];
  const parts = [
    ...(counts.passed > 0 ? [`${number(counts.passed)} ${passedAs}`] : []),
    ...(counts.failed > 0 ? [`${number(counts.failed)} failed`] : []),
    ...(counts.skipped > 0 ? [`${number(counts.skipped)} skipped (${skipReasons(report.records, id)})`] : []),
  ];
  return line(label, parts.length === 0 ? "nothing read" : parts.join(", "));
}

function signaturesLine(signatures: SignatureCounts): string {
  if (signatures.total === 0) return line("Signatures", "none in these files");
  const ownKey = signatures.verified - signatures.verifiedWithSuppliedKey;
  return line("Signatures", [
    ...(ownKey > 0 ? [`${number(ownKey)} verified by the key in their own id`] : []),
    ...(signatures.verifiedWithSuppliedKey > 0 ? [`${number(signatures.verifiedWithSuppliedKey)} verified against keys you supplied`] : []),
    ...(signatures.invalid > 0 ? [`${number(signatures.invalid)} failed`] : []),
    signatures.unverified === 0 ? "none unverified" : `${number(signatures.unverified)} not verified (no key)`,
  ].join(", "));
}

function referencesLine(result: ReferencesResult): string {
  const resolved = number(result.resolved + result.resolvedPublished);
  const published = result.resolvedPublished === 0
    ? ""
    : `, ${count(result.resolvedPublished, "by a published document", "of them by published documents")}`;
  const unavailable = result.unavailable === 0 ? "" : `, ${number(result.unavailable)} unavailable`;
  if (result.status === "skipped") return line("References", "skipped: no record here has references to read");
  if (result.status === "failed") return line("References", `failed: ${number(result.dangling)} dangling, ${resolved} resolved${published}${unavailable}`);
  return line("References", `${result.opaque > 0 ? "passed for known kinds" : "passed"}: ${resolved} resolved${published}${unavailable}`);
}

function lifecycleLine(result: LifecycleResult): string {
  if (result.status === "skipped") {
    return line("Lifecycle", result.attempts.length === 0 ? "skipped: no observations here" : "skipped: no attempt-engaged here, so no source is authoritative");
  }
  const uncovered = result.deliveriesWithoutObservations === 0
    ? ""
    : `, ${count(result.deliveriesWithoutObservations, "Delivery", "Deliveries")} with no log`;
  return line("Lifecycle", `${result.status}: ${count(result.attempts.length, "attempt")} folded${uncovered}`);
}

function anchorsLine(result: AnchorsResult): string {
  if (result.report === undefined) return line("Anchors", "not checked: no anchor records here");
  const statuses = result.report.anchors.map(({ status }) => status);
  const pending = statuses.filter((status) => status === "pending").length;
  const present = statuses.filter((status) => status === "present").length;
  if (result.status === "failed") return line("Anchors", `failed: ${number(result.report.invalid.length)} invalid`);
  return line("Anchors", [
    ...(present > 0 ? [`passed: ${count(present, "proof")} consistent, time not evaluated`] : []),
    ...(pending > 0 ? [`${number(pending)} pending`] : []),
  ].join(", "));
}

function failureLines(report: CommandReport): readonly string[] {
  const fromRoot = (report.root?.problems ?? []).map(({ code, file, detail }) => `  ${file}: ${code}: ${detail}`);
  const unread = report.tooLarge.map(({ file, bytes }) =>
    `  ${printable(`${file}: too-large: ${number(bytes)} bytes is over the limit, so it was not read.`)}`);
  const fromRecords = report.records.flatMap((record, index) => record.checks
    .filter(({ status }) => status === "failed")
    .flatMap(({ id, findings }) => findings
      .filter(({ code }) => !NOTES.has(code))
      .map(({ path, detail }) => `  ${printable(`${report.files[index]!}: ${id}:${path === undefined ? "" : ` ${path}:`} ${detail}`)}`)));
  const fromSet = (report.checks ?? [])
    .filter(({ status }) => status === "failed")
    .flatMap(({ id, findings }) => findings
      .filter(({ code }) => !NOTES.has(code))
      .map(({ subject, path, detail }) => `  ${printable(`${id}:${subject === undefined ? "" : ` ${subject}`}${path === undefined ? "" : ` ${path}`}: ${detail}`)}`));
  const failures = [...fromRoot, ...unread, ...fromRecords, ...fromSet];
  return [
    ...failures.slice(0, LISTED_FAILURES),
    ...(failures.length > LISTED_FAILURES ? [`  and ${number(failures.length - LISTED_FAILURES)} more; --json has them all`] : []),
  ];
}

function conclusion(report: CommandReport): string {
  const failedChecks = (report.checks ?? []).filter(({ status }) => status === "failed").map(({ id }) => `${id} failed`);
  const failures = [
    ...((report.root?.problems.length ?? 0) > 0 ? ["Completeness failed"] : []),
    ...(report.tooLarge.length > 0 ? [`${count(report.tooLarge.length, "file")} too large to read`] : []),
    ...(report.summary.recordsFailed > 0 ? [`${count(report.summary.recordsFailed, "record")} failed`] : []),
    ...failedChecks,
  ];
  return `${failures.length === 0 ? "Nothing failed" : failures.join(", ")}. Skipped and unknown are not passes.`;
}

/** Whether anything failed, which is what the exit code answers. */
export function reportFailed(report: CommandReport): boolean {
  return report.root?.checked === false
    || (report.root?.problems.length ?? 0) > 0
    || report.tooLarge.length > 0
    || report.summary.recordsFailed > 0
    || (report.checks ?? []).some(({ status }) => status === "failed");
}

function rootCompletenessText({ listed, problems }: RootReport): string {
  if (problems.length === 0) return `passed: ${count(listed, "listed file")} present and unchanged, no others`;
  const counted = Object.entries(ROOT_PROBLEM_PHRASES).flatMap(([code, phrase]) => {
    const times = problems.filter((problem) => problem.code === code).length;
    return times === 0 ? [] : [`${number(times)} ${phrase}`];
  });
  return `failed: ${counted.join(", ")}`;
}

/** What the report can say about which files should exist. */
function completenessLine(report: CommandReport): string {
  if (report.root !== undefined) return line("Completeness", rootCompletenessText(report.root));
  return line("Completeness", report.checks === undefined ? NOT_A_SET : "not checked: nothing here says which files should exist");
}

function keysLine({ keys }: RootReport): readonly string[] {
  if (keys === undefined) return [];
  return [line("Keys", keys.covered
    ? `covered by the root: ${keys.listedAs} is in the list`
    : "not covered by the root: their bytes are not in the list")];
}

function rootMatchedLine(root: RootReport): string {
  return line("Root", `matched: ${root.list!} is ${root.digest}`);
}

/** The whole report when the root gave nothing to compare the files with: only what was decided. */
function renderUnchecked(report: CommandReport, root: RootReport): string {
  const failures = failureLines(report);
  return [
    ...(root.list === undefined
      ? [
        `Looked at the top of ${printable(report.target)} for ${root.digest}.`,
        "",
        line("Root", "failed: no file there has this digest"),
        line("Completeness", "not checked: no list to compare with"),
      ]
      : [
        `Read the list from ${printable(report.target)}, and none of the files it names.`,
        "",
        rootMatchedLine(root),
        completenessLine(report),
        "",
        ...failures,
      ]),
    "",
    root.list === undefined ? "Root failed, so nothing else was checked." : "The list broke its format, so nothing else was checked.",
    "",
  ].join("\n");
}

/**
 * The report as a person reads it. Each line prints `passed` only for what ran, and says what did
 * not and why. The last line stays a statement about failures, because that is all the counts
 * above it can support.
 */
export function renderReport(report: CommandReport): string {
  const { root, summary } = report;
  if (root?.checked === false) return renderUnchecked(report, root);
  const unknown = summary.kinds[UNKNOWN_KIND] ?? 0;
  const unread = [
    ...(report.notRead === 0 ? [] : [count(report.notRead, "entry that is not a file", "entries that are not files")]),
    ...(report.tooLarge.length === 0 ? [] : [count(report.tooLarge.length, "file over the size limit", "files over the size limit")]),
  ];
  const notParsed = root?.notParsed.length ?? 0;
  const failures = failureLines(report);
  return [
    `Read ${count(summary.records + notParsed, "file")} from ${printable(report.target)}${
      unread.length === 0 ? "" : `, and did not read ${unread.join(" or ")}`
    }${notParsed === 0 ? "" : `, and did not parse ${count(notParsed, "file")} over the size limit`}.`,
    "",
    ...(root === undefined ? [] : [rootMatchedLine(root)]),
    line("Kinds", `${number(summary.records - unknown)} known, ${number(unknown - summary.namingNoType)} unknown naming a type, ${number(summary.namingNoType)} naming no type`),
    checkLine("Digest", "digest", report, root === undefined ? "passed, compared with each file's own name" : "passed, compared with the list"),
    checkLine("Encoding", "encoding", report),
    checkLine("Schema", "schema", report),
    signaturesLine(summary.signatures),
    ...(root === undefined ? [] : keysLine(root)),
    line("Trust binding", root === undefined ? NO_IDENTITY : `${NO_IDENTITY}, and a root pins what was published, not who published it`),
    report.checks === undefined ? line("References", NOT_A_SET) : referencesLine(report.checks[0]),
    report.checks === undefined ? line("Lifecycle", NOT_A_SET) : lifecycleLine(report.checks[1]),
    report.checks === undefined ? line("Anchors", NOT_A_SET) : anchorsLine(report.checks[2]),
    completenessLine(report),
    "",
    ...(failures.length === 0 ? [] : [...failures, ""]),
    conclusion(report),
    "",
  ].join("\n");
}
