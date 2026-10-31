// SPDX-License-Identifier: Apache-2.0

import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { ANCHOR_EVIDENCE_KIND, compareCodeUnitStrings } from "@jinn-network/trust-core";
import {
  ATTEMPT_OBSERVATION_TYPES,
  ConflictingObservationError,
  foldObservations,
} from "@jinn-network/task-execution-protocol";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";

import { evaluateAnchors } from "./anchor/evaluate.js";
import type { AnchorSubject, AnchorTrustMaterial, AnchorsReport } from "./anchor/evaluate.js";
import { inspectRecord } from "./check-record.js";
import type { InspectedRecord, RecordTrustOptions } from "./check-record.js";
import { OBSERVATION_KIND } from "./kinds/index.js";
import type { RecordKinds, RecordReference } from "./kinds/index.js";
import { failed, passed, skipped, UNKNOWN_KIND } from "./results.js";
import type {
  CheckResult,
  CheckStatus,
  Finding,
  RecordCheckId,
  RecordReport,
  SignatureCounts,
} from "./results.js";

export interface RecordSetInputRecord {
  readonly bytes: Uint8Array;
  /** The digest these bytes were held under. It is compared, and never resolves a reference. */
  readonly digest?: string;
}

export interface RecordSetTrustOptions extends RecordTrustOptions {
  /** Material for evaluating an anchor's time. Without it an anchor is `present` at best. */
  readonly anchors?: AnchorTrustMaterial;
}

export interface CheckRecordSetInput {
  /** Records and any artifacts they cite by digest. */
  readonly records: readonly RecordSetInputRecord[];
  /** The `sha256:` digests the walk starts from. Pass every digest to walk everything. */
  readonly roots: readonly string[];
  readonly kinds?: RecordKinds;
  readonly trust?: RecordSetTrustOptions;
}

export interface ReferencesResult extends CheckResult<"references"> {
  /** Records the walk arrived at. */
  readonly reached: number;
  /** Records held that no root reaches. Their references were not followed. */
  readonly unreached: number;
  /** Citations whose target is held. */
  readonly resolved: number;
  /** Citations of a record the set must hold and does not. */
  readonly dangling: number;
  /** Citations of bytes the family lets a reader lack, not held. */
  readonly unavailable: number;
  /** Reached records whose references could not be read: unknown kind, or failed schema. */
  readonly opaque: number;
}

export interface AttemptLifecycle {
  readonly attempt: string;
  /** Whether an `attempt-engaged` pinned the authoritative source. Without one, `state` is unattributed. */
  readonly engaged: boolean;
  readonly state: string;
  readonly terminal: boolean;
  readonly contradictory: boolean;
  /** Digests of the Deliveries the log records. */
  readonly deliveries: readonly string[];
}

export interface LifecycleResult extends CheckResult<"lifecycle"> {
  /** The Attempts that folded. One whose log the fold refuses is a finding instead. */
  readonly attempts: readonly AttemptLifecycle[];
  /** Deliveries held for an Attempt no observation in the set speaks about. */
  readonly deliveriesWithoutObservations: number;
}

export interface AnchorsResult extends CheckResult<"anchors"> {
  /** Absent when the set held no anchor record to evaluate. */
  readonly report?: AnchorsReport;
}

export interface RecordSetSummary {
  readonly records: number;
  /** Records with at least one failed check. Set checks fail on their own, so this is not a verdict. */
  readonly recordsFailed: number;
  /** Records per kind id, with those no kind claims under `unknown`. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Of the `unknown` records, how many name each type no kind is registered for. */
  readonly unknownTypes: Readonly<Record<string, number>>;
  /** Of the `unknown` records, how many name no type at all. These may be artifacts. */
  readonly namingNoType: number;
  /** What actually ran across the records. A kind's count is not a claim that all of these passed. */
  readonly checks: Readonly<Record<RecordCheckId, Readonly<Record<CheckStatus, number>>>>;
  readonly signatures: SignatureCounts;
}

export interface RecordSetReport {
  readonly summary: RecordSetSummary;
  /** One per input, in input order. */
  readonly records: readonly RecordReport[];
  readonly checks: readonly [ReferencesResult, LifecycleResult, AnchorsResult];
}

type Held = ReadonlyMap<string, InspectedRecord>;

function schemaPassed({ report }: InspectedRecord): boolean {
  return report.checks.some(({ id, status }) => id === "schema" && status === "passed");
}

function isKind(entry: InspectedRecord, kind: string): boolean {
  return entry.report.kind === kind && schemaPassed(entry);
}

function referencesOf(entry: InspectedRecord): readonly RecordReference[] | undefined {
  if (entry.kind === undefined || !schemaPassed(entry)) return undefined;
  try {
    return entry.kind.references?.(entry.view) ?? [];
  } catch {
    return undefined;
  }
}

function checkReferences(roots: readonly string[], held: Held): ReferencesResult {
  const counts = { reached: 0, unreached: 0, resolved: 0, dangling: 0, unavailable: 0, opaque: 0 };
  if (roots.length === 0) {
    return { ...skipped("references", "no-roots", "No roots were given, so no reference was followed."), ...counts, unreached: held.size };
  }

  const refusals: Finding[] = [];
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const root of roots) {
    if (!held.has(root)) refusals.push({ code: "root-missing", subject: root, detail: `The set does not hold root ${root}.` });
    else if (!seen.has(root)) {
      seen.add(root);
      pending.push(root);
    }
  }

  while (pending.length > 0) {
    const digest = pending.pop()!;
    const references = referencesOf(held.get(digest)!);
    if (references === undefined) {
      counts.opaque += 1;
      continue;
    }
    for (const reference of references) {
      if (held.has(reference.digest)) {
        counts.resolved += 1;
        if (!seen.has(reference.digest)) {
          seen.add(reference.digest);
          pending.push(reference.digest);
        }
      } else if (reference.mayBeUnavailable === true) {
        counts.unavailable += 1;
      } else {
        counts.dangling += 1;
        refusals.push({
          code: "dangling-reference",
          subject: digest,
          path: reference.path,
          detail: `${reference.field} cites ${reference.digest}, which the set does not hold.`,
        });
      }
    }
  }

  counts.reached = seen.size;
  counts.unreached = held.size - seen.size;
  const notes: Finding[] = [];
  if (counts.unreached > 0) {
    notes.push({ code: "records-not-reached", detail: `${counts.unreached} held records were not reached from the roots, so their references were not followed.` });
  }
  if (counts.opaque > 0) {
    notes.push({ code: "references-not-read", detail: `${counts.opaque} reached records are of unknown kind or failed their schema, so any references they carry were not read.` });
  }
  if (refusals.length === 0 && counts.opaque === counts.reached) {
    return { ...skipped("references", "no-references-read", notes.map(({ detail }) => detail).join(" ")), ...counts };
  }
  if (counts.unavailable > 0) {
    notes.push({ code: "references-unavailable", detail: `${counts.unavailable} references name bytes the family lets a reader lack and the set does not hold, so those bytes were not looked at.` });
  }
  return { ...(refusals.length > 0 ? failed("references", [...refusals, ...notes]) : passed("references", notes)), ...counts };
}

function documentOf(entry: InspectedRecord): Record<string, unknown> {
  return entry.view.document as Record<string, unknown>;
}

interface LoggedObservation {
  readonly observation: ProtocolObservation;
  readonly digest: string;
}

/**
 * Each Attempt's log, in (`sequence`, record digest) order, and the Attempts in code-unit order.
 * `foldObservations` needs no order from its caller, but the first engagement below and the order
 * of the findings do, and neither may come from the order of the input (§10.4 rule 3).
 */
function attemptLogs(records: readonly InspectedRecord[]): ReadonlyMap<string, readonly LoggedObservation[]> {
  const attemptTypes: readonly string[] = ATTEMPT_OBSERVATION_TYPES;
  const logs = new Map<string, LoggedObservation[]>();
  for (const entry of records) {
    if (!isKind(entry, OBSERVATION_KIND)) continue;
    const observation = entry.view.document as ProtocolObservation;
    if (!attemptTypes.includes(observation.type)) continue;
    const logged = { observation, digest: entry.report.digest };
    const log = logs.get(observation.subject);
    if (log === undefined) logs.set(observation.subject, [logged]);
    else log.push(logged);
  }
  for (const log of logs.values()) {
    log.sort((left, right) =>
      compareCodeUnitStrings(left.observation.sequence, right.observation.sequence)
      || compareCodeUnitStrings(left.digest, right.digest));
  }
  return new Map([...logs].sort(([left], [right]) => compareCodeUnitStrings(left, right)));
}


function checkLifecycle(records: readonly InspectedRecord[], held: Held): LifecycleResult {
  const deliveries = records.filter((entry) => isKind(entry, RECORD_KINDS.delivery));
  const superseding = deliveries
    .filter((entry) => typeof documentOf(entry)["supersedes"] === "string")
    .sort((left, right) => compareCodeUnitStrings(left.report.digest, right.report.digest));
  const logs = attemptLogs(records);
  if (logs.size === 0 && superseding.length === 0) {
    const reason = "The set holds no Lifecycle Observations and no superseding Delivery, so no lifecycle was folded.";
    return { ...skipped("lifecycle", "no-lifecycle-records", reason), attempts: [], deliveriesWithoutObservations: deliveries.length };
  }

  const refusals: Finding[] = [];
  // §11.3 rule 1, "checkable whenever both records are held": it needs no log.
  for (const entry of superseding) {
    const target = held.get(documentOf(entry)["supersedes"] as string);
    if (target !== undefined && !isKind(target, RECORD_KINDS.delivery)) {
      refusals.push({
        code: "supersedes-not-a-delivery",
        subject: entry.report.digest,
        detail: `This Delivery supersedes ${target.report.digest}, which is not a valid Delivery (Task Execution Protocol §11.3 rule 1).`,
      });
    } else if (target !== undefined && documentOf(target)["attempt"] !== documentOf(entry)["attempt"]) {
      refusals.push({
        code: "supersedes-other-attempt",
        subject: entry.report.digest,
        detail: `This Delivery supersedes ${target.report.digest}, a Delivery of another Attempt (Task Execution Protocol §11.3 rule 1).`,
      });
    }
  }

  const attempts: AttemptLifecycle[] = [];
  const unattributed: Finding[] = [];
  for (const [attempt, log] of logs) {
    let derived;
    try {
      derived = foldObservations(log.map(({ observation }) => observation));
    } catch (cause) {
      if (!(cause instanceof ConflictingObservationError)) throw cause;
      refusals.push({ code: "conflicting-observations", subject: attempt, detail: `${cause.message}.` });
      continue;
    }
    const recorded = derived.deliveries.map(({ digest }) => digest);
    // §10.1: "Consumers establish authority from the engagement event". Without one, any source counts.
    const engagements = log.filter(({ observation }) => observation.type === "network.jinn.task-execution.attempt-engaged.v1");
    const [first] = engagements;
    const engaged = first !== undefined;
    if (!engaged) {
      unattributed.push({ code: "attempt-not-engaged", subject: attempt, detail: "The set holds no attempt-engaged for this Attempt, so nothing pins whose observations these are." });
    }
    attempts.push({ attempt, engaged, state: derived.state, terminal: derived.terminal, contradictory: derived.contradictory, deliveries: recorded });
    if (derived.contradictory) {
      refusals.push({ code: "contradictory-terminals", subject: attempt, detail: `The authoritative log holds contradictory terminals; the first in sequence is ${derived.state} (§10.4 rule 4).` });
    }
    // §10.4 orders engagements by `sequence`, and a tie gives it nothing to order them by.
    if (engagements.some(({ observation, digest }) => observation.sequence === first?.observation.sequence && digest !== first.digest)) {
      refusals.push({ code: "first-engagement-tied", subject: attempt, detail: `More than one attempt-engaged holds the first sequence, ${first!.observation.sequence}, so nothing says which is the engagement (§10.4).` });
    }
    const task = (first?.observation.data as { readonly task?: string } | undefined)?.task;
    for (const digest of recorded) {
      const delivery = held.get(digest);
      if (delivery === undefined || !isKind(delivery, RECORD_KINDS.delivery)) {
        refusals.push({ code: "recorded-delivery-missing", subject: attempt, detail: `The log records Delivery ${digest}, which the set does not hold as a valid Delivery.` });
        continue;
      }
      const document = documentOf(delivery);
      if (document["attempt"] !== attempt) {
        refusals.push({ code: "delivery-attempt-mismatch", subject: attempt, detail: `The log records Delivery ${digest}, which names Attempt ${String(document["attempt"])}.` });
      }
      if (task !== undefined && document["task"] !== task) {
        refusals.push({ code: "delivery-task-mismatch", subject: attempt, detail: `The Attempt engaged Task ${task}, and Delivery ${digest} names Task ${String(document["task"])}.` });
      }
    }
  }

  const deliveriesWithoutObservations = deliveries.filter((entry) => !logs.has(documentOf(entry)["attempt"] as string)).length;
  const uncompared = superseding.flatMap((entry): readonly Finding[] => {
    const target = documentOf(entry)["supersedes"] as string;
    return held.has(target)
      ? []
      : [{ code: "supersedes-target-not-held", subject: entry.report.digest, detail: `This Delivery supersedes ${target}, which the set does not hold, so §11.3 rule 1 was not compared.` }];
  });
  const notes: Finding[] = [...unattributed, ...uncompared, ...(deliveriesWithoutObservations === 0 ? [] : [{
    code: "deliveries-without-observations",
    detail: `${deliveriesWithoutObservations} Deliveries belong to Attempts with no observation in the set, so no lifecycle covers them.`,
  }])];
  // With no log, the only thing to compare is a supersession both of whose records are held.
  const supersessionCompared = uncompared.length < superseding.length;
  if (refusals.length === 0 && attempts.every(({ engaged }) => !engaged) && (attempts.length > 0 || !supersessionCompared)) {
    return { id: "lifecycle", status: "skipped", findings: notes, attempts, deliveriesWithoutObservations };
  }
  const result = refusals.length > 0 ? failed("lifecycle", [...refusals, ...notes]) : passed("lifecycle", notes);
  return { ...result, attempts, deliveriesWithoutObservations };
}

function checkAnchors(records: readonly InspectedRecord[], held: Held, trust: AnchorTrustMaterial | undefined): AnchorsResult {
  const carried = records.filter((entry) => entry.report.kind === ANCHOR_EVIDENCE_KIND);
  if (carried.length === 0) return skipped("anchors", "no-anchor-records", "The set holds no AnchorEvidence records.");

  const named = new Set(carried.flatMap((entry) => (referencesOf(entry) ?? []).map(({ digest }) => digest)));
  const subjects = [...named].flatMap((digest): readonly AnchorSubject[] => {
    const subject = held.get(digest);
    if (subject === undefined) return [];
    const { kind } = subject.report;
    return [{ id: digest, sha256: digest.slice("sha256:".length), ...(kind === UNKNOWN_KIND ? {} : { kind }) }];
  });
  const report = evaluateAnchors({
    records: carried.map(({ report: { digest }, view: { bytes } }) => ({ recordSha256: digest.slice("sha256:".length), bytes })),
    subjects,
    ...(trust === undefined ? {} : { trust }),
  });

  const refusals = report.invalid.map(({ recordSha256, reason }): Finding => ({
    code: "anchor-invalid",
    subject: `sha256:${recordSha256}`,
    detail: reason ?? "The proof is invalid.",
  }));
  const notes = report.anchors.flatMap(({ recordSha256, status, reason, subject }): readonly Finding[] => {
    const record = `sha256:${recordSha256}`;
    return [
      ...(status === "present" ? [{ code: "anchor-time-not-evaluated", subject: record, detail: "The proof is internally consistent; no trust material was supplied, so its time was not evaluated." }] : []),
      ...(status === "pending" ? [{ code: "anchor-pending", subject: record, detail: reason ?? "The proof is not complete." }] : []),
      ...(subject !== undefined && status !== "invalid" && held.get(subject)?.report.kind === UNKNOWN_KIND
        ? [{ code: "anchor-subject-kind-unchecked", subject: record, detail: `The anchored record ${subject} is of unknown kind, so the kind the anchor states was not compared.` }]
        : []),
    ];
  });
  return { ...(refusals.length > 0 ? failed("anchors", [...refusals, ...notes]) : passed("anchors", notes)), report };
}

export function summarizeRecords(reports: readonly RecordReport[]): RecordSetSummary {
  const kinds: Record<string, number> = {};
  const unknownTypes: Record<string, number> = {};
  let namingNoType = 0;
  const checks = Object.fromEntries((["digest", "encoding", "schema", "signature", "trust-binding"] as const)
    .map((id) => [id, { passed: 0, failed: 0, skipped: 0 }])) as Record<RecordCheckId, Record<CheckStatus, number>>;
  const signatures = { total: 0, verified: 0, verifiedWithSuppliedKey: 0, invalid: 0, unverified: 0 };
  for (const report of reports) {
    for (const key of Object.keys(signatures) as (keyof SignatureCounts)[]) signatures[key] += report.signatures[key];
    kinds[report.kind] = (kinds[report.kind] ?? 0) + 1;
    if (report.kind === UNKNOWN_KIND) {
      if (report.names === undefined) namingNoType += 1;
      else unknownTypes[report.names] = (unknownTypes[report.names] ?? 0) + 1;
    }
    for (const { id, status } of report.checks) checks[id][status] += 1;
  }
  return {
    records: reports.length,
    recordsFailed: reports.filter(({ outcome }) => outcome === "failed").length,
    kinds,
    unknownTypes,
    namingNoType,
    checks,
    signatures,
  };
}

/**
 * Checks each record with `checkRecord`, then what only a set can show: that references by digest
 * resolve from the roots, that each Attempt's lifecycle folds and agrees with the Deliveries held,
 * and that anchor evidence stands up for the records it names.
 *
 * `summary` counts what ran, by check and by kind. It carries no overall verdict, because a set of
 * records of unknown kind, or of known kinds with no key to verify, must not read as passed.
 */
export async function checkRecordSet(input: CheckRecordSetInput): Promise<RecordSetReport> {
  const records: InspectedRecord[] = [];
  for (const { bytes, digest } of input.records) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: a resolver may be remote.
    records.push(await inspectRecord(bytes, {
      ...(digest === undefined ? {} : { digest }),
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.trust === undefined ? {} : { trust: input.trust }),
    }));
  }
  const held: Held = new Map(records.map((entry) => [entry.report.digest, entry]));
  const reports = records.map(({ report }) => report);
  return {
    summary: summarizeRecords(reports),
    records: reports,
    checks: [
      checkReferences(input.roots, held),
      checkLifecycle(records, held),
      checkAnchors(records, held, input.trust?.anchors),
    ],
  };
}
