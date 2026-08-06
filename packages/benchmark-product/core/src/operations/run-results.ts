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
 */

import {
  parseBenchmark,
  parseMatrix,
  parseRun,
  type MatrixCell,
  type MatrixRecord,
  type Outcome,
} from "@jinn-network/benchmarking-records";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { requireRunState } from "../run/state.js";
import { resultsArtifactPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readVerdictEnvelope } from "../venue/signing.js";
import type { OperationContext } from "./context.js";
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

function toResultsCell(workspaceDir: string, cell: MatrixCell): RunResultsCell {
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

      const cells = matrix.cells.map((cell) => toResultsCell(context.workspaceDir, cell));

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
        venueHonesty: {
          venue: "self-run",
          preRegistration: "structural-and-append-order-only",
          limits: LOCAL_VENUE_LIMITS,
          unverifiableAxisCounts: unverifiableAxisCounts(matrix.cells),
        },
      };

      atomicWriteFileSync(resultsArtifactPath(context.workspaceDir, input.draftId), JSON.stringify(results, null, 2));

      return results;
    },
  });
}
