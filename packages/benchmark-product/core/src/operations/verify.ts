/**
 * `run.verify` (BP-13 deliverable 3, spec §7.1/§12.1): the skeptic's independent check — an
 * UNGATED read any workspace member can invoke (not in `../authority/policy.ts`'s
 * `GATED_OPERATIONS`), and NON-ADVANCING: it never touches draft state or RunState. Where
 * `report` (`./report.ts`) is the author computing and sealing a claim, `verify` is the read path
 * that recomputes it from the workspace's own durable state and refuses to agree with anything it
 * cannot itself re-derive.
 *
 * Three checks, run in order, each named in the returned `checks` list:
 *
 * 1. `matrix-rederivation` — always run once a Matrix is sealed. Rebuilds `expected`
 *    (`expectedCellSet`), the run-journal fold, admission receipts, and the exact assembly ports
 *    through the SHARED `../run/assembly-ports.ts` construction (see that module's own header:
 *    one shared implementation is the only construction that cannot drift from what `run.collect`
 *    built), then calls `@jinn-network/benchmarking-run`'s `verifyMatrix` to byte-compare the
 *    re-derived Matrix against the sealed one. `getSealedBytes` itself re-verifies every
 *    referenced record's digest on read (`../workspace/sealed-store.ts`) — a corrupted-in-place
 *    record surfaces as ITS OWN typed `record-integrity` refusal naming the store path, before
 *    this module ever gets a chance to re-derive anything. That is part of the skeptic story this
 *    operation tells, not a gap in it: two independent layers (the store's own digest check, and
 *    this module's re-derivation) each catch a different class of tamper.
 * 2. `report-verification` — only when the RunState carries a sealed Report envelope. Calls
 *    `@jinn-network/benchmarking-aggregate`'s `verifyReport` over the workspace's own method ports
 *    (`../report/ports.ts`) and workspace-local trust deps (`../report/trust.ts` — see that
 *    module's header for the local-trust-root caveat this inherits unchanged: a passing check
 *    proves the Report was signed by this workspace's own key, nothing more).
 * 3. `claim-consistency` — only alongside `report-verification`. Reads the claim package artifact
 *    (`../report/claim.ts`) and checks every figure it carries against the records this operation
 *    just independently verified, refusing on the first field that disagrees. A claim package
 *    that quietly drifted from its own cited records — the exact failure mode `../report/claim.ts`'s
 *    own header calls out as "worse than one that failed to build" — is caught here, after the
 *    fact, by a party other than whoever built it.
 */

import { readFileSync } from "node:fs";
import {
  expectedCellSet,
  parseBenchmark,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { verifyMatrix } from "@jinn-network/benchmarking-run";
import { verifyReport } from "@jinn-network/benchmarking-aggregate";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { ClaimPackageSchema } from "../report/claim.js";
import { buildMethodPorts } from "../report/ports.js";
import { buildWorkspaceTrustDeps } from "../report/trust.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { foldRunJournal, readRunJournalEntries } from "../run/journal.js";
import { requireRunState } from "../run/state.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunVerifyInput {
  readonly draftId: string;
}

export type RunVerifyCheck = "matrix-rederivation" | "report-verification" | "claim-consistency";

export interface RunVerifyResult {
  readonly draftId: string;
  /** The checks actually performed, in order — `["matrix-rederivation"]` for a closed-but-not-yet-
   * reported run, all three for a reported one. */
  readonly checks: readonly RunVerifyCheck[];
  readonly matrixSha256: string;
  readonly reportEnvelopeSha256?: string;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Exact structural JSON equality via canonical bytes — deliberately not a "deep equal ignoring
 * key order" library semantic. `canonicalJsonBytes` already sorts object keys; requiring the
 * resulting bytes to match exactly is what makes this comparison as strict as the sealed records
 * themselves (module header). */
function jsonEqual(left: unknown, right: unknown): boolean {
  return bytesEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

/** Extracts wilson@1's `results.perSubject[0].results.conflicted` block — the same narrow, local
 * shape check `../report/claim.ts`'s own `wilsonSubjectResults` performs, mirrored rather than
 * imported (that helper is private to claim.ts, and this module only needs the one sub-block). */
function reportConflictedBlock(
  results: unknown,
): { readonly count: number; readonly cellKeys: readonly string[] } | undefined {
  const perSubject = (
    results as
      | { readonly perSubject?: readonly { readonly results?: { readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown } } }[] }
      | undefined
  )?.perSubject;
  const conflicted = perSubject?.[0]?.results?.conflicted;
  if (typeof conflicted?.count !== "number" || !Array.isArray(conflicted.cellKeys)) return undefined;
  return { count: conflicted.count, cellKeys: conflicted.cellKeys as readonly string[] };
}

export function runVerify(
  context: OperationContext,
  input: RunVerifyInput,
): Promise<OperationResult<RunVerifyResult>> {
  return operateAsync({
    context,
    action: "run.verify",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.matrixSha256 === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has no sealed Matrix yet — nothing to verify — run collect first`,
        );
      }

      const checks: RunVerifyCheck[] = [];

      // ── 1. matrix-rederivation ───────────────────────────────────────────────────────────
      const matrixBytes = getSealedBytes(context.workspaceDir, runState.matrixSha256);
      const matrixRecord = parseMatrix(matrixBytes);
      const runRecord = parseRun(getSealedBytes(context.workspaceDir, runState.runSha256));
      const benchRecord = parseBenchmark(getSealedBytes(context.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchRecord, runRecord);
      const fold = foldRunJournal(readRunJournalEntries(context.workspaceDir, input.draftId));
      const receiptsByTaskDigest = scanPredictionSnapshotAdmissionReceipts(context.workspaceDir);
      const ports = buildRunAssemblyPorts({
        workspaceDir: context.workspaceDir,
        draftId: input.draftId,
        runRecord,
        expected,
        fold,
        // The sealed Run record's own owner, not mutable product state — the skeptic re-derives
        // from what was sealed, not from what RunState currently claims.
        owner: runRecord.owner,
        receiptsByTaskDigest,
      });

      const verifiedMatrix = await verifyMatrix(matrixRecord, benchRecord, runRecord, ports, undefined, matrixBytes);
      if (!verifiedMatrix.ok) {
        refuse("record-integrity", "matrix-rederivation", `${verifiedMatrix.check}: ${verifiedMatrix.detail}`);
      }
      checks.push("matrix-rederivation");

      // ── 2 & 3. report-verification + claim-consistency (only alongside a sealed Report) ──
      if (runState.reportEnvelopeSha256 === undefined) {
        if (document.state === "reported" || document.state === "published-bundle") {
          refuse(
            "conflict",
            `runs.${input.draftId}`,
            `draft ${input.draftId} is "${document.state}" but its RunState has no sealed Report envelope`,
          );
        }
        return { draftId: input.draftId, checks, matrixSha256: runState.matrixSha256 };
      }

      if (runState.reportedAt === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has a sealed Report envelope but no reportedAt instant`,
        );
      }

      const envelopeBytes = getSealedBytes(context.workspaceDir, runState.reportEnvelopeSha256);
      const verifiedReport = await verifyReport(
        { envelopeBytes, subjects: [matrixBytes], effectiveTime: runState.reportedAt },
        {
          ...buildMethodPorts(context.workspaceDir),
          // The sealed Run record's own owner, not mutable product state — see the matching
          // comment at the matrix-rederivation ports above.
          trust: buildWorkspaceTrustDeps({ workspaceDir: context.workspaceDir, author: runRecord.owner }),
        },
      );
      if (!verifiedReport.ok) {
        refuse("record-integrity", "report-verification", `${verifiedReport.check}: ${verifiedReport.detail}`);
      }
      checks.push("report-verification");
      const reportRecord = verifiedReport.record;

      const claimPath = claimPackageArtifactPath(context.workspaceDir, input.draftId);
      let claimText: string;
      try {
        claimText = readFileSync(claimPath, "utf8");
      } catch {
        refuse("conflict", claimPath, `draft ${input.draftId} has a sealed Report but no readable claim package at ${claimPath}`);
      }
      let claimRaw: unknown;
      try {
        claimRaw = JSON.parse(claimText);
      } catch {
        refuse("conflict", claimPath, `claim package at ${claimPath} is not valid JSON`);
      }
      const claimParsed = ClaimPackageSchema.safeParse(claimRaw);
      if (!claimParsed.success) {
        refuse(
          "record-integrity",
          "claim-consistency",
          `claim package at ${claimPath} does not satisfy the claim package schema: ${claimParsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
      const claim = claimParsed.data;

      const recordChecks: readonly (readonly [string, string | undefined, string])[] = [
        ["benchmarkSha256", document.spec.taskSet.benchmarkSha256, claim.records.benchmarkSha256],
        ["runSha256", runState.runSha256, claim.records.runSha256],
        ["matrixSha256", runState.matrixSha256, claim.records.matrixSha256],
        ["reportSha256", runState.reportSha256, claim.records.reportSha256],
        ["reportEnvelopeSha256", runState.reportEnvelopeSha256, claim.records.reportEnvelopeSha256],
      ];
      for (const [field, expectedValue, actualValue] of recordChecks) {
        if (expectedValue !== actualValue) {
          refuse(
            "record-integrity",
            "claim-consistency",
            `claim package records.${field} ("${actualValue}") does not match the workspace's own value ("${String(expectedValue)}")`,
          );
        }
      }

      if (!jsonEqual(claim.results, reportRecord.results)) {
        refuse("record-integrity", "claim-consistency", "claim package results do not match the verified Report's own results");
      }

      if (
        claim.method.id !== reportRecord.method.id
        || claim.method.version !== reportRecord.method.version
        || !jsonEqual(claim.method.parameters, reportRecord.method.parameters)
        || claim.method.preregistered !== (reportRecord.preregistered ?? false)
      ) {
        refuse("record-integrity", "claim-consistency", "claim package method/preregistered does not match the verified Report");
      }

      if (!jsonEqual(claim.disclosures.perSubject, reportRecord.disclosures?.perSubject ?? [])) {
        refuse("record-integrity", "claim-consistency", "claim package disclosures do not match the verified Report's own disclosures");
      }
      if (!jsonEqual(claim.limitations, reportRecord.limitations ?? [])) {
        refuse("record-integrity", "claim-consistency", "claim package limitations do not match the verified Report's own limitations");
      }

      if (!jsonEqual(claim.completeness, matrixRecord.completeness)) {
        refuse("record-integrity", "claim-consistency", "claim package completeness does not match the verified Matrix's own completeness");
      }
      if (!jsonEqual(claim.attrition, matrixRecord.attrition)) {
        refuse("record-integrity", "claim-consistency", "claim package attrition does not match the verified Matrix's own attrition");
      }

      const reportConflicted = reportConflictedBlock(reportRecord.results);
      if (
        reportConflicted === undefined
        || claim.conflicted.count !== reportConflicted.count
        || !jsonEqual(claim.conflicted.cellKeys, reportConflicted.cellKeys)
      ) {
        refuse(
          "record-integrity",
          "claim-consistency",
          "claim package conflicted block does not match the verified Report's own results conflicted block",
        );
      }

      checks.push("claim-consistency");

      return {
        draftId: input.draftId,
        checks,
        matrixSha256: runState.matrixSha256,
        reportEnvelopeSha256: runState.reportEnvelopeSha256,
      };
    },
  });
}
