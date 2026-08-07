/**
 * Shared assembly-port construction for the official run path (BP-13 deliverable 3): extracted,
 * verbatim, from `../operations/run-collect.ts`, which used to build this inline.
 *
 * `run.collect` seals a Matrix by assembling `InScopeCell[]` from durable state (the run journal
 * plus the sealed-bytes store) and wiring `@jinn-network/benchmarking-local`'s
 * `localAssemblyPorts` over it. The skeptic's `run.verify` operation (`../operations/verify.ts`)
 * needs to rebuild EXACTLY the same ports from the same durable facts to re-derive the Matrix and
 * byte-compare it against what collect sealed. Two independently written constructions could
 * silently drift from each other — and a drift here is not a cosmetic bug: it would either make
 * verify reject a Matrix collect genuinely and honestly sealed, or (worse) make verify accept a
 * Matrix collect never would have produced. One shared implementation, called from both sites, is
 * the only construction that cannot drift. `run-collect.ts` and `verify.ts` both call
 * `buildRunAssemblyPorts` with the same durable inputs (the sealed Run record, the expected cell
 * set, the run-journal fold, the workspace's admission receipts, and the run owner) and get back
 * the identical `AssemblyPorts` bundle `assembleMatrix`/`verifyMatrix` require.
 *
 * Originally a pure code motion out of `run-collect.ts`. BP-21 changed two behaviors INSIDE the
 * shared construction (so collect and verify still cannot drift): every stored verdict of a cell
 * flows into assembly (not just the first — the pre-BP-21 single-verdict bridge), and the trust
 * resolver's evaluator resolution is signature-verified fail-closed (see the resolver comment in
 * `buildRunAssemblyPorts`).
 *
 * BP-22 adds a third fact this construction is now the ONE place that derives:
 * `completeness.runOutcome: "cancelled"` (`@jinn-network/benchmarking-run`'s `assembleMatrix`
 * reads `ports.inputScope.runCancelled === true`). The durable source of that fact is the cancel
 * valid marker (`./cancel-marker.ts`'s `cancelRequested`), so `buildRunAssemblyPorts`
 * reads it itself from the now-required `draftId` input rather than trusting each caller to pass
 * it — `run.collect`, `run.verify`, and `run.cancel` all call this one function and so can never
 * drift on the one fact that flips a Matrix's run outcome to cancelled.
 */

import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { CellCoord, RunRecord } from "@jinn-network/benchmarking-records";
import { localAssemblyPorts } from "@jinn-network/benchmarking-local";
import type { AssemblyPorts, InScopeCell, InScopeVerdict } from "@jinn-network/benchmarking-run";
import { dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { parseEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { readEvaluatorPublicKeys, readVerdictEnvelope } from "../venue/signing.js";
import { VENUE_ISOLATION_INVENTORY } from "../venue/venue.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { LocalAdmissionReceiptFact } from "./admission-receipts.js";
import { cancelRequested } from "./cancel-marker.js";
import type { CellJournalFold } from "./journal.js";

/**
 * `InScopeCell.evaluationSpecDigest` is the `sha256:<hex>`-PREFIXED form (verified against
 * `@jinn-network/benchmarking-local`'s own `miniature-run.test.ts` fixture — `checkVerdictSpecMatch`
 * compares it byte-for-byte against a verdict's `record.evaluationSpecification`, which
 * `readVerdictEnvelope`'s `evaluationSpecificationSha256` is turned into with the same prefix
 * below) — distinct from the bare-hex form the workspace's sealed-bytes store and the Task
 * document's own `evaluation.digest.sha256` field use.
 */
function subjectEvaluationSpecRef(
  workspaceDir: string,
  taskDigestHex: string,
): { evaluationSpecDigest?: `sha256:${string}`; evaluationSpec?: EvaluationSpec } {
  const subjectTaskBytes = getSealedBytes(workspaceDir, taskDigestHex);
  const subjectTaskDoc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(subjectTaskBytes)) as {
    readonly evaluation?: { readonly digest?: { readonly sha256?: string } };
  };
  const evaluationSpecSha256 = subjectTaskDoc.evaluation?.digest?.sha256;
  if (evaluationSpecSha256 === undefined) return {};
  const evaluationSpecDigest = `sha256:${evaluationSpecSha256}` as const;
  try {
    const evaluationSpec = parseEvaluationSpec(getSealedBytes(workspaceDir, evaluationSpecSha256));
    return { evaluationSpecDigest, evaluationSpec };
  } catch {
    return { evaluationSpecDigest };
  }
}

/** ONE `InScopeVerdict` per stored verdict, in journal order (BP-21) — a multi-leg cell's
 * verdicts all flow to assembly, dissent included; dropping any would let the sealed Matrix be
 * more flattering than the journal. */
function buildVerdicts(workspaceDir: string, cell: CellJournalFold, evaluationSpec: EvaluationSpec | undefined): InScopeVerdict[] {
  return cell.verdicts.map((verdict) => {
    const envelopeBytes = getSealedBytes(workspaceDir, verdict.sha256);
    const view = readVerdictEnvelope(envelopeBytes);
    return {
      digest: `sha256:${verdict.sha256}` as const,
      record: {
        evaluationSpecification: `sha256:${view.evaluationSpecificationSha256}`,
        evaluator: view.evaluatorId,
        verdict: view.verdict,
      },
      measurements: view.measurements,
      ...(evaluationSpec !== undefined ? { evaluationSpec } : {}),
    };
  });
}

/**
 * Fail-closed evaluator resolution (BP-21): the claimed evaluator IRI resolves ONLY when the
 * verdict envelope's own DSSE signature verifies against that identity's workspace-registered
 * public key (`readEvaluatorPublicKeys` — per-evaluator slots plus the legacy pair). Anything
 * else — a claim outside the registry, missing or unreadable envelope bytes, a parse failure, no
 * verifying signature, any thrown error — returns `"unresolved"`, NEVER throws: assembly must
 * proceed and derive the honest outcome from an unresolved identity, not crash.
 */
function resolveEvaluatorClaim(
  workspaceDir: string,
  evidenceRef: unknown,
  loadEvaluatorKeys: () => ReadonlyMap<string, KeyObject>,
): string | "unresolved" {
  try {
    const ref = evidenceRef as { claim?: unknown; verdictDigest?: unknown } | undefined;
    const claim = ref?.claim;
    const verdictDigest = ref?.verdictDigest;
    if (typeof claim !== "string" || claim.length === 0) return "unresolved";
    if (typeof verdictDigest !== "string" || !verdictDigest.startsWith("sha256:")) return "unresolved";
    const publicKey = loadEvaluatorKeys().get(claim);
    if (publicKey === undefined) return "unresolved";
    const envelope = parseDsseEnvelope(getSealedBytes(workspaceDir, verdictDigest.slice("sha256:".length)));
    const preAuthEncoding = Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes));
    const signed = envelope.signatures.some((signature) => {
      try {
        return cryptoVerify(null, preAuthEncoding, publicKey, Buffer.from(signature.sig, "base64"));
      } catch {
        return false;
      }
    });
    return signed ? claim : "unresolved";
  } catch {
    return "unresolved";
  }
}

/** Builds one `InScopeCell` per expected coordinate, entirely from the journal fold + sealed
 * bytes store — no backend call anywhere in this function (module header). */
function buildInScopeCells(
  workspaceDir: string,
  expected: readonly CellCoord[],
  fold: ReadonlyMap<string, CellJournalFold>,
): InScopeCell[] {
  return expected.map((coord) => {
    const cell = fold.get(coord.cellKey);
    if (cell === undefined) {
      return { cellKey: coord.cellKey, armId: coord.armId, replicate: coord.replicate, taskDigest: coord.taskDigest, dispatches: 0, verdicts: [] };
    }

    const { evaluationSpecDigest, evaluationSpec } = subjectEvaluationSpecRef(workspaceDir, coord.taskDigest);
    const verdicts = buildVerdicts(workspaceDir, cell, evaluationSpec);

    return {
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      taskDigest: coord.taskDigest,
      dispatches: cell.dispatches,
      ...(cell.dispatches > 0 ? { accounted: cell.dispatches } : {}),
      ...(cell.submissionSha256 !== undefined ? { submissionDigest: `sha256:${cell.submissionSha256}` as const } : {}),
      ...(cell.attempt !== undefined ? { attempt: cell.attempt } : {}),
      ...(cell.deliverySha256 !== undefined
        ? { deliveryBytes: getSealedBytes(workspaceDir, cell.deliverySha256), deliveryDigest: `sha256:${cell.deliverySha256}` as const }
        : {}),
      ...(evaluationSpecDigest !== undefined ? { evaluationSpecDigest } : {}),
      ...(evaluationSpec !== undefined ? { evaluationSpec } : {}),
      ...(cell.evaluationTerminal !== undefined ? { evaluationTerminal: cell.evaluationTerminal } : {}),
      verdicts,
    } satisfies InScopeCell;
  });
}

export interface BuildRunAssemblyPortsInput {
  readonly workspaceDir: string;
  /** The draft this run belongs to (BP-22) — used ONLY to derive `runCancelled` from a valid
   * cancel marker (`./cancel-marker.ts`'s `cancelRequested`); no other port reads it. */
  readonly draftId: string;
  readonly runRecord: RunRecord;
  /** The full expected cell coordinate set (`expectedCellSet(benchRecord, runRecord)`). */
  readonly expected: readonly CellCoord[];
  /** The run journal folded to one status per cell (`foldRunJournal`). */
  readonly fold: ReadonlyMap<string, CellJournalFold>;
  /** The run's deterministic owner IRI (`RunState.owner`). */
  readonly owner: string;
  /** Prediction-snapshot admission receipts keyed by admitted Task digest (bare hex),
   * `scanPredictionSnapshotAdmissionReceipts(workspaceDir)`. */
  readonly receiptsByTaskDigest: ReadonlyMap<string, LocalAdmissionReceiptFact>;
}

/**
 * Builds the exact `AssemblyPorts` bundle `assembleMatrix`/`verifyMatrix` require, entirely from
 * durable run state (module header). Both `run.collect` (the original sealer) and `run.verify`
 * (the independent re-derivation) call this with the same inputs and get back byte-identical
 * ports.
 */
export function buildRunAssemblyPorts(input: BuildRunAssemblyPortsInput): AssemblyPorts {
  const { workspaceDir, draftId, runRecord, expected, fold, owner, receiptsByTaskDigest } = input;
  const cells = buildInScopeCells(workspaceDir, expected, fold);

  // Loaded lazily and memoized: the registry scan itself can refuse on a broken key slot, and
  // that failure must resolve THIS claim "unresolved" (inside resolveEvaluatorClaim's try/catch),
  // never crash port construction.
  let evaluatorKeys: Map<string, KeyObject> | undefined;
  const loadEvaluatorKeys = (): ReadonlyMap<string, KeyObject> =>
    (evaluatorKeys ??= readEvaluatorPublicKeys(workspaceDir));

  // The ONE derivation of `completeness.runOutcome: "cancelled"` (module header, BP-22): the
  // valid cancel marker, read straight from durable state — never threaded through as
  // a caller-supplied flag that `run.collect`/`run.verify`/`run.cancel` could each get wrong.
  const runCancelled = cancelRequested(workspaceDir, draftId);

  return localAssemblyPorts({
    inputScope: { cellsForRun: () => cells, ...(runCancelled ? { runCancelled: true } : {}) },
    pinning: {
      submissionBaseline: runRecord.policy.submissionBaseline as Record<string, unknown>,
      isolationInventory: VENUE_ISOLATION_INVENTORY,
      evidenceFor: (cellKey) => {
        const cell = fold.get(cellKey);
        if (cell === undefined || cell.dispatches === 0) return { dispatches: 0 };
        // The backend's launcherDeployments admission gate (verifyRunPinning) ran at
        // `submit` for every accepted dispatch — a dispatched cell genuinely passed it.
        return { dispatches: cell.dispatches, admission: { ready: true } };
      },
    },
    admission: {
      receiptFor: (cell) => receiptsByTaskDigest.get(cell.taskDigest),
    },
    cost: {
      costFor: () => undefined,
      latencyFor: () => undefined,
    },
    trust: {
      // Solver identity is this run's own owner (the product's deterministic run-owner IRI).
      // Evaluator identity (BP-21): the verdict's claimed evaluator IRI (`evidenceRef.claim` —
      // `assemble.ts` passes `verdict.record.evaluator` alongside `verdictDigest`) resolves
      // ONLY after this resolver verifies the verdict envelope's DSSE signature against that
      // identity's workspace-registered public key — proof the claimed evaluator identity
      // actually signed THIS verdict with a workspace-registered key, i.e. genuine
      // AGENT-distinctness, fail-closed to "unresolved" otherwise. It still cannot and does
      // not claim party-independence: the same operator mints and holds every evaluator key on
      // this self-run venue — disclosed rather than dressed up as third-party verification.
      resolveAgent: async (evidenceRef) => {
        const role = (evidenceRef as { role?: string } | undefined)?.role;
        if (role === "solver") return owner;
        if (role === "evaluator") return resolveEvaluatorClaim(workspaceDir, evidenceRef, loadEvaluatorKeys);
        return "unresolved";
      },
    },
  });
}
