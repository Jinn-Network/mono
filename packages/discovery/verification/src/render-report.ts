// SPDX-License-Identifier: Apache-2.0

import type { AnchorsResult, LifecycleResult, RecordSetReport, RecordSetSummary, ReferencesResult } from "./check-record-set.js";
import { UNKNOWN_KIND } from "./results.js";
import type { CheckStatus, RecordCheckId, RecordReport, SignatureCounts } from "./results.js";

/** Everything the command read and decided, printed one way for a person and one for `--json`. */
export interface CommandReport {
  readonly target: string;
  /** Directory entries that are not files, and so were not read. */
  readonly notRead: number;
  readonly suppliedKeys: number;
  /** One per record, in the same order. */
  readonly files: readonly string[];
  readonly summary: RecordSetSummary;
  readonly records: readonly RecordReport[];
  /** Absent for one file, which is not a set. */
  readonly checks?: RecordSetReport["checks"];
}

const LABEL_WIDTH = 15;
const LISTED_FAILURES = 5;

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

function checkLine(label: string, id: RecordCheckId, report: CommandReport): string {
  const counts: Readonly<Record<CheckStatus, number>> = report.summary.checks[id];
  const parts = [
    ...(counts.passed > 0 ? [`${number(counts.passed)} passed`] : []),
    ...(counts.failed > 0 ? [`${number(counts.failed)} failed`] : []),
    ...(counts.skipped > 0 ? [`${number(counts.skipped)} skipped (${skipReasons(report.records, id)})`] : []),
  ];
  return line(label, parts.join(", "));
}

function signaturesLine(signatures: SignatureCounts, records: readonly RecordReport[]): string {
  if (signatures.total === 0) return line("Signatures", "none in these files");
  const ownKey = signatures.verified - signatures.verifiedWithSuppliedKey;
  const ofUnknownKind = records
    .filter(({ kind }) => kind === UNKNOWN_KIND)
    .reduce((total, record) => total + record.signatures.unverified, 0);
  const noKey = signatures.unverified - ofUnknownKind;
  const why = [
    ...(noKey > 0 ? [{ times: noKey, phrase: "no key" }] : []),
    ...(ofUnknownKind > 0 ? [{ times: ofUnknownKind, phrase: "kind unknown" }] : []),
  ];
  const reason = why.length === 1 ? why[0]!.phrase : why.map(({ times, phrase }) => `${number(times)} ${phrase}`).join(", ");
  return line("Signatures", [
    ...(ownKey > 0 ? [`${number(ownKey)} verified by the key in their own id`] : []),
    ...(signatures.verifiedWithSuppliedKey > 0 ? [`${number(signatures.verifiedWithSuppliedKey)} verified against keys you supplied`] : []),
    ...(signatures.invalid > 0 ? [`${number(signatures.invalid)} failed`] : []),
    signatures.unverified === 0 ? "none unverified" : `${number(signatures.unverified)} not verified (${reason})`,
  ].join(", "));
}

function referencesLine(result: ReferencesResult): string {
  const resolved = number(result.resolved + result.resolvedPublished);
  const published = result.resolvedPublished === 0
    ? ""
    : `, ${count(result.resolvedPublished, "by a published document", "by published documents")}`;
  const unavailable = result.unavailable === 0 ? "" : `, ${number(result.unavailable)} unavailable`;
  if (result.status === "failed") return line("References", `failed: ${number(result.dangling)} dangling, ${resolved} resolved${published}${unavailable}`);
  return line("References", `${result.opaque > 0 ? "passed for known kinds" : "passed"}: ${resolved} resolved${published}${unavailable}`);
}

function lifecycleLine(result: LifecycleResult): string {
  if (result.status === "skipped") return line("Lifecycle", "skipped: no observations here");
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
  const fromRecords = report.records.flatMap((record, index) => record.checks
    .filter(({ status }) => status === "failed")
    .flatMap(({ id, findings }) => findings
      .filter(({ code }) => !NOTES.has(code))
      .map(({ path, detail }) => `  ${report.files[index]!}: ${id}:${path === undefined ? "" : ` ${path}:`} ${detail}`)));
  const fromSet = (report.checks ?? [])
    .filter(({ status }) => status === "failed")
    .flatMap(({ id, findings }) => findings
      .filter(({ code }) => !NOTES.has(code))
      .map(({ subject, path, detail }) => `  ${id}:${subject === undefined ? "" : ` ${subject}`}${path === undefined ? "" : ` ${path}`}: ${detail}`));
  const failures = [...fromRecords, ...fromSet];
  return [
    ...failures.slice(0, LISTED_FAILURES),
    ...(failures.length > LISTED_FAILURES ? [`  and ${number(failures.length - LISTED_FAILURES)} more; --json has them all`] : []),
  ];
}

function conclusion(report: CommandReport): string {
  const failedChecks = (report.checks ?? []).filter(({ status }) => status === "failed").map(({ id }) => `${id} failed`);
  const failures = [...(report.summary.failed > 0 ? [`${count(report.summary.failed, "record")} failed`] : []), ...failedChecks];
  return `${failures.length === 0 ? "Nothing failed" : failures.join(", ")}. Skipped and unknown are not passes.`;
}

/** Whether anything failed, which is what the exit code answers. */
export function reportFailed(report: CommandReport): boolean {
  return report.summary.failed > 0 || (report.checks ?? []).some(({ status }) => status === "failed");
}

/**
 * The report as a person reads it. Each line prints `passed` only for what ran, and says what did
 * not and why. The last line stays a statement about failures, because that is all the counts
 * above it can support.
 */
export function renderReport(report: CommandReport): string {
  const { summary } = report;
  const unknown = summary.kinds[UNKNOWN_KIND] ?? 0;
  const unread = report.notRead === 0 ? "" : `, and did not read ${count(report.notRead, "entry that is not a file", "entries that are not files")}`;
  const NOT_A_SET = "not checked: one file is not a set";
  const failures = failureLines(report);
  return [
    `Read ${count(summary.records, "file")} from ${report.target}${unread}.`,
    "",
    line("Kinds", `${number(summary.records - unknown)} known, ${number(unknown - summary.namingNoType)} unknown naming a type, ${number(summary.namingNoType)} naming no type`),
    checkLine("Digest", "digest", report),
    checkLine("Encoding", "encoding", report),
    checkLine("Schema", "schema", report),
    signaturesLine(summary.signatures, report.records),
    line("Trust binding", "skipped: no key was tied to an identity"),
    report.checks === undefined ? line("References", NOT_A_SET) : referencesLine(report.checks[0]),
    report.checks === undefined ? line("Lifecycle", NOT_A_SET) : lifecycleLine(report.checks[1]),
    report.checks === undefined ? line("Anchors", NOT_A_SET) : anchorsLine(report.checks[2]),
    "",
    ...(failures.length === 0 ? [] : [...failures, ""]),
    conclusion(report),
    "",
  ].join("\n");
}
