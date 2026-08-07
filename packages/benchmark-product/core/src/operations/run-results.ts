/**
 * `run.results` (spec §4.6 Results (Matrix) row): reads the sealed Matrix, builds a
 * human/agent-legible results document — plain English, no protocol-specific terms, no emoji
 * (spec §9) — writes it to the workspace's derived-artifacts area (`resultsArtifactPath`, spec
 * §4.5), and returns it. Available once the run has closed (spec §4.1's "closed" state and
 * every state after it — `report`/`publish` are later packets, but the Matrix itself never
 * changes once sealed, so results stay readable from those states too).
 *
 * `venueHonesty` carries the local-venue limits spec §7.1 requires "in the product and in every
 * report produced from a local run" — plain-language statements, never hidden behind a claim of
 * stronger guarantees than a self-run local venue actually has.
 *
 * BP-22: each cell also carries an optional `failure` block, sourced from the run journal's own
 * fold (`../run/journal.ts`'s `CellJournalFold`) rather than the sealed Matrix — the Matrix's
 * `outcome` field stays the platform's frozen six-value vocabulary (judged / unjudged /
 * unscorable / expired / invalidated / excluded) and carries no blame field at all (design
 * decision: failure detail is product state, never folded into a score). `failure` is present
 * exactly when the journal fold's solve-side status for that cell is "failed", "expired", or
 * "cancelled" — never for a judged or merely-delivered (unjudged) cell.
 */

import { readFileSync } from "node:fs";
import {
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
  type MatrixCell,
  type MatrixRecord,
  type Outcome,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { ClaimPackageSchema, type ClaimPackage } from "../report/claim.js";
import { foldRunJournal, readRunJournalEntries, type CellJournalFold } from "../run/journal.js";
import { requireRunState } from "../run/state.js";
import { claimPackageArtifactPath, resultsArtifactPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readVerdictEnvelope } from "../venue/signing.js";
import type { OperationContext } from "./context.js";
import type { PublicBundleVerificationCheck } from "../bundle/verify.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

const CLOSED_OR_LATER_STATES = new Set(["closed", "reported", "published-bundle"]);

export interface RunResultsVerdict {
  readonly sha256: string;
  readonly verdict: string;
  /** The verdict statement's own claimed evaluator IRI (BP-21) — one per verdict, since a
   * multi-verdict cell's verdicts each carry their own evaluator identity. */
  readonly evaluator: string;
  readonly measurements: Readonly<Record<string, boolean | number | string>>;
}

export interface RunResultsCell {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskSha256: string;
  readonly outcome: Outcome;
  readonly verification: {
    readonly harness: MatrixCell["verification"]["harness"];
    readonly model: MatrixCell["verification"]["model"];
    readonly loadout: MatrixCell["verification"]["loadout"];
    readonly isolation: MatrixCell["verification"]["isolation"];
    readonly checksFailed: readonly string[];
  };
  readonly integrityTier: MatrixCell["integrityTier"];
  readonly verdicts: readonly RunResultsVerdict[];
  /** The matrix cell's own `validVerdicts` (BP-21), verbatim, in the same bare-hex form as
   * `verdicts` — the subset of stored verdicts that passed the platform's per-verdict checks. */
  readonly validVerdicts: readonly string[];
  readonly cost?: MatrixCell["cost"];
  readonly latencyMs?: number;
  /** Present exactly when the run journal's own solve-side fold status for this cell is
   * "failed" / "expired" / "cancelled" (BP-22) — sourced from product state (the run journal),
   * never from the sealed Matrix, which carries no blame field at all. */
  readonly failure?: {
    readonly kind: "failed" | "expired" | "cancelled";
    readonly blame?: "task" | "infrastructure";
    readonly detail?: string;
  };
}

export interface VenueHonesty {
  readonly venue: "self-run";
  readonly preRegistration: "structural-and-append-order-only";
  readonly limits: readonly string[];
  readonly unverifiableAxisCounts: {
    readonly harness: number;
    readonly model: number;
    readonly loadout: number;
    readonly isolation: number;
  };
}

/** A read-only projection of the exact Report and claim artifacts already sealed by
 * `runReport`. `runResults` does not authenticate or recompute them; the explicit status keeps
 * that distinction visible until the caller invokes `runVerify`. */
export interface RunResultsReport {
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly record: ReportRecord;
  readonly claimPackage: ClaimPackage;
  readonly verification: {
    readonly status: "not-run";
    readonly detail: string;
  };
}

export interface RunResultsDocument {
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly closeBoundary: MatrixRecord["closeBoundary"];
  readonly runOutcome: MatrixRecord["completeness"]["runOutcome"];
  readonly completeness: MatrixRecord["completeness"];
  readonly attrition: MatrixRecord["attrition"];
  readonly cells: readonly RunResultsCell[];
  /** Cells whose STORED verdicts disagree — more than one distinct verdict value among them
   * (BP-21, spec §9.2: dissenting verdicts remain referenced and visible). Dissent here is
   * distinct from the report-stage "conflicted" reduction outcome (design §9.2), which lives in
   * the Report's own results and in the claim package. */
  readonly dissentCells: readonly string[];
  readonly venueHonesty: VenueHonesty;
  readonly publication?: {
    readonly identity: string;
    readonly relativePath: string;
    readonly publishedAt: string;
    readonly checks: readonly PublicBundleVerificationCheck[];
  };
  /** Present only once the draft is durably `reported` (or later). Exact stored facts only: no
   * scores, claims, signatures, or verification outcomes are derived by this read operation. */
  readonly report?: RunResultsReport;
}

/** Plain-language statements of what a local, self-run venue does and does not prove (spec §7.1).
 * Never hidden, never softened into a stronger claim — this is the disclosure the design
 * requires "in the product and in every report produced from a local run". Exported (BP-13) so
 * `../operations/report.ts` can pass the same limits into every sealed Report, and
 * `../report/claim.ts` into every claim package's `venueHonesty` block — one list, never
 * duplicated. */
export const LOCAL_VENUE_LIMITS: readonly string[] = [
  "This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.",
  "Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.",
  "Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.",
  "Cost figures, where present, are self-reported by this venue and were never independently settled.",
  "Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.",
];

function bareSha256(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function verdictsFor(workspaceDir: string, digests: readonly string[]): RunResultsVerdict[] {
  return digests.map((prefixedDigest) => {
    const sha256 = bareSha256(prefixedDigest);
    const envelopeBytes = getSealedBytes(workspaceDir, sha256);
    const view = readVerdictEnvelope(envelopeBytes);
    return { sha256, verdict: view.verdict, evaluator: view.evaluatorId, measurements: view.measurements };
  });
}

/** BP-22: the journal-fold-sourced failure block for one cell, or `undefined` when the fold's
 * solve-side status isn't one of "failed" / "expired" / "cancelled" (module header). A cell the
 * fold has no entry for at all (never touched by any journal write) also reports `undefined` —
 * there is no fact to surface, honestly, not a failure. */
function failureFor(fold: CellJournalFold | undefined): RunResultsCell["failure"] {
  if (fold === undefined) return undefined;
  if (fold.status !== "failed" && fold.status !== "expired" && fold.status !== "cancelled") return undefined;
  return {
    kind: fold.status,
    ...(fold.blame !== undefined ? { blame: fold.blame } : {}),
    ...(fold.detail !== undefined ? { detail: fold.detail } : {}),
  };
}

function toResultsCell(workspaceDir: string, cell: MatrixCell, journalFold: CellJournalFold | undefined): RunResultsCell {
  const failure = failureFor(journalFold);
  return {
    cellKey: cell.cellKey,
    armId: cell.armId,
    replicate: cell.replicate,
    taskSha256: cell.taskDigest,
    outcome: cell.outcome,
    verification: {
      harness: cell.verification.harness,
      model: cell.verification.model,
      loadout: cell.verification.loadout,
      isolation: cell.verification.isolation,
      checksFailed: cell.verification.checksFailed,
    },
    integrityTier: cell.integrityTier,
    verdicts: verdictsFor(workspaceDir, cell.verdicts),
    validVerdicts: cell.validVerdicts.map(bareSha256),
    ...(cell.cost !== undefined ? { cost: cell.cost } : {}),
    ...(cell.latencyMs !== undefined ? { latencyMs: cell.latencyMs } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** Exported (BP-13) so `../report/claim.ts` builds its `venueHonesty` block from the same
 * per-axis tally, rather than duplicating this walk over the matrix's cells. */
export function unverifiableAxisCounts(cells: readonly MatrixCell[]): VenueHonesty["unverifiableAxisCounts"] {
  const axes = ["harness", "model", "loadout", "isolation"] as const;
  const counts = { harness: 0, model: 0, loadout: 0, isolation: 0 };
  for (const cell of cells) {
    for (const axis of axes) {
      if (cell.verification[axis] === "unverifiable") counts[axis] += 1;
    }
  }
  return counts;
}

/** The exact venue-honesty block carried by every claim; shared by report production and
 * independent claim re-derivation. */
export function buildLocalVenueHonesty(cells: readonly MatrixCell[]): VenueHonesty {
  return {
    venue: "self-run",
    preRegistration: "structural-and-append-order-only",
    limits: LOCAL_VENUE_LIMITS,
    unverifiableAxisCounts: unverifiableAxisCounts(cells),
  };
}

/** Dissent (spec §9.2: "Dissenting verdicts remain referenced in the matrix and visible in the
 * report") = a cell whose STORED verdicts carry more than one distinct verdict value — mere
 * multiplicity is agreement, not dissent (BP-21: an evaluator-panel cell whose verdicts all say
 * "pass" carries none). Distinct from the report-stage "conflicted" reduction outcome (design
 * §9.2), which lives in the Report's own results and in the claim package. */
function dissentCellKeys(cells: readonly RunResultsCell[]): string[] {
  return cells
    .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
    .map((cell) => cell.cellKey);
}

const REPORT_NOT_VERIFIED_DETAIL =
  "Run verification to authenticate the sealed envelope and independently re-derive its Matrix, Report, and claim facts.";

function readReportedProjection(
  workspaceDir: string,
  draftId: string,
  runState: ReturnType<typeof requireRunState>,
): RunResultsReport {
  if (runState.reportSha256 === undefined || runState.reportEnvelopeSha256 === undefined) {
    refuse(
      "conflict",
      `runs.${draftId}`,
      `draft ${draftId} is reported but its RunState does not name both sealed Report payload and envelope digests`,
    );
  }

  let record: ReportRecord;
  try {
    record = parseReport(getSealedBytes(workspaceDir, runState.reportSha256));
    // This read does not authenticate the signature, but it does re-hash the envelope bytes so
    // the projection never advertises a missing or digest-corrupt sealed object.
    getSealedBytes(workspaceDir, runState.reportEnvelopeSha256);
  } catch (cause) {
    refuse(
      "record-integrity",
      `reports.${draftId}`,
      `the sealed Report projection is not readable as exact stored records: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let claimRaw: unknown;
  try {
    claimRaw = JSON.parse(readFileSync(claimPackageArtifactPath(workspaceDir, draftId), "utf8"));
  } catch {
    refuse("conflict", `claims.${draftId}`, `draft ${draftId} is reported but its stored claim package is not readable JSON`);
  }
  const parsedClaim = ClaimPackageSchema.safeParse(claimRaw);
  if (!parsedClaim.success) {
    refuse(
      "record-integrity",
      `claims.${draftId}`,
      `draft ${draftId}'s stored claim package does not satisfy its public schema: ${parsedClaim.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  return {
    reportSha256: runState.reportSha256,
    reportEnvelopeSha256: runState.reportEnvelopeSha256,
    record,
    claimPackage: parsedClaim.data,
    verification: { status: "not-run", detail: REPORT_NOT_VERIFIED_DETAIL },
  };
}

export function runResults(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<RunResultsDocument> {
  return operate({
    context,
    action: "run.results",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!CLOSED_OR_LATER_STATES.has(document.state)) {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — results are available from "closed" on`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.matrixSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, `draft ${input.draftId} has no sealed Matrix yet — run.collect first`);
      }

      // Re-parsed for completeness's sake — every referenced record is re-verified on read
      // (getSealedBytes's own digest check) rather than trusted from RunState alone.
      parseRun(getSealedBytes(context.workspaceDir, runState.runSha256));
      parseBenchmark(getSealedBytes(context.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const matrix = parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256));

      // BP-22: the journal fold is the SOURCE of each cell's optional `failure` block — read
      // once here, alongside the Matrix, never re-derived per cell.
      const journalFold = foldRunJournal(readRunJournalEntries(context.workspaceDir, input.draftId));
      const cells = matrix.cells.map((cell) => toResultsCell(context.workspaceDir, cell, journalFold.get(cell.cellKey)));

      const results: RunResultsDocument = {
        draftId: input.draftId,
        benchmarkSha256: document.spec.taskSet.benchmarkSha256,
        runSha256: runState.runSha256,
        matrixSha256: runState.matrixSha256,
        closeBoundary: matrix.closeBoundary,
        runOutcome: matrix.completeness.runOutcome,
        completeness: matrix.completeness,
        attrition: matrix.attrition,
        cells,
        dissentCells: dissentCellKeys(cells),
        venueHonesty: buildLocalVenueHonesty(matrix.cells),
        ...(document.state === "reported" || document.state === "published-bundle"
          ? { report: readReportedProjection(context.workspaceDir, input.draftId, runState) }
          : {}),
        ...(document.state === "published-bundle"
          ? (() => {
              if (
                runState.bundleIdentity === undefined || runState.bundleRelativePath === undefined
                || runState.bundleChecks === undefined || runState.publishedAt === undefined
              ) refuse("record-integrity", "publication", "published draft is missing its durable bundle receipt");
              return {
                publication: {
                  identity: runState.bundleIdentity,
                  relativePath: runState.bundleRelativePath,
                  publishedAt: runState.publishedAt,
                  checks: runState.bundleChecks,
                },
              };
            })()
          : {}),
      };

      atomicWriteFileSync(resultsArtifactPath(context.workspaceDir, input.draftId), JSON.stringify(results, null, 2));

      return results;
    },
  });
}
