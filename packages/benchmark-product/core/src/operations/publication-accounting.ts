/**
 * Accounting-only benchmark publication.  This operation is deliberately a reader of the
 * sealed workspace: Run/Benchmark, RunState, append-only journal, CAS, and the local Harbor
 * archive format are its entire authority.  It never creates a venue, calls a backend, or asks
 * Harbor to reconstruct history; a post-hoc call is therefore a publication operation, not a
 * rerun disguised as one.
 */

import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE,
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE,
  MATRIX_MEDIA_TYPE,
  MATRIX_RECORD_KIND,
  RUN_MEDIA_TYPE,
  compareCodeUnitStrings,
  expectedCellSet,
  parseBenchmark,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { buildBenchmarkAccounting, verifyBenchmarkAccounting } from "@jinn-network/benchmarking-publication";
import { assembleMatrixV2, verifyMatrixV2 } from "@jinn-network/benchmarking-run";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { createDiscoverySourceAnnouncementPort } from "@jinn-network/record-publication";
import { executePublicationPlan, type PublicationArtifact, type PublicationPlan, type PublicationRecord } from "@jinn-network/record-publication";
import { DELIVERY_MEDIA_TYPE, SUBMISSION_MEDIA_TYPE, SubmissionRecordSchema } from "@jinn-network/task-execution-protocol";
import { refuse } from "../errors.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { foldRunJournal, foldRunJournalLineage, readRunJournalEntries, type RunJournalEntry } from "../run/journal.js";
import { requireWorkspaceAuthorship, recordWorkspaceAuthorship, WORKSPACE_AUTHORSHIP_ROLE } from "../run/publication-authority.js";
import { assessPublicationCompatibility } from "../run/publication-compatibility.js";
import { createWorkspacePublicationJournal, createWorkspacePublicationSource, recordPath, withWorkspacePublicationSourceLock } from "../run/publication-source.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface PublicationAccountingInput { readonly draftId: string; }
export interface PublicationAccountingResult {
  readonly accountingSha256: string;
  readonly matrixV2Sha256: string;
  readonly source: { readonly agent: string; readonly name: string };
}

type Receipt = { readonly sequence: string; readonly entryDigest: `sha256:${string}` };
const authorship = (id: string, digest: string, bytes: Uint8Array): PublicationArtifact => ({
  id, role: WORKSPACE_AUTHORSHIP_ROLE, digest: `sha256:${digest}`, bytes, mediaType: "application/vnd.jinn.colophon.workspace-authorship.v1+json", actions: ["store"],
});

function timestamp(at: string, offset: number): string { return new Date(Date.parse(at) + offset).toISOString(); }
function publicUrl(base: string, path: string): string { return new URL(path, base.endsWith("/") ? base : `${base}/`).toString(); }
async function probeExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  const response = await fetch(publicUrl(base, recordPath(digest)));
  if (!response.ok) throw new Error(`public accounting input probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (observed.length !== bytes.length || !observed.every((value, index) => value === bytes[index])) {
    throw new Error("public accounting input probe did not return the exact Submission bytes");
  }
}
function receiptPosition(source: { agent: string; name: string }, receipt: Receipt) {
  return { kind: "record-discovery" as const, source, position: { sequence: receipt.sequence, entry: receipt.entryDigest } };
}

/** Store all non-record closure bytes and append every Submission before fixing the scope cutoff. */
async function publishInputs(input: {
  workspaceDir: string; draftId: string; at: string; sourceName: string; publicBaseUrl: string;
  dispatches: readonly { cellKey: string; index: number; submissionSha256: string; supporting: readonly { digest: string; mediaType: string }[] }[];
}): Promise<{ source: { agent: string; name: string }; cutoff: Receipt }> {
  return withWorkspacePublicationSourceLock(input.workspaceDir, async () => {
    const source = createWorkspacePublicationSource(input.workspaceDir, input.sourceName);
    await source.writer.recover();
    let ordinal = 0;
    for (const dispatch of input.dispatches) {
      for (const supporting of dispatch.supporting) {
        await source.artifactStore.putExact({ digest: `sha256:${supporting.digest}`, bytes: getSealedBytes(input.workspaceDir, supporting.digest), mediaType: supporting.mediaType });
      }
      const bytes = getSealedBytes(input.workspaceDir, dispatch.submissionSha256);
      await source.writer.append({
        timestamp: timestamp(input.at, ordinal++),
        announcement: {
          announcementId: `accounting-input:${input.draftId}:${dispatch.submissionSha256}`,
          action: "available",
          record: { kind: RECORD_KINDS.submission, digest: `sha256:${dispatch.submissionSha256}`, mediaType: SUBMISSION_MEDIA_TYPE },
        },
        record: { bytes, contentType: SUBMISSION_MEDIA_TYPE },
      });
      // A stored/announced input is not part of the accounting scope until it has passed the
      // same public exact-byte retrieval check used by registration.  A failure leaves the stage
      // recoverably in-progress and refuses before the cutoff is frozen.
      await probeExact(input.publicBaseUrl, `sha256:${dispatch.submissionSha256}`, bytes);
    }
    const state = await source.writer.readState();
    const last = state?.last;
    if (last === null || last === undefined) throw new Error("accounting input publication produced no durable source cutoff");
    return { source: source.source, cutoff: { sequence: last.sequence, entryDigest: last.entryDigest } };
  });
}

export function publicationAccounting(
  context: OperationContext,
  input: PublicationAccountingInput,
): Promise<OperationResult<PublicationAccountingResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "publication.accounting", subject: input.draftId, inputs: input, run: async () => {
    const lock = await acquirePublicationLock(context.workspaceDir, input.draftId);
    try {
      let state = requireRunState(context.workspaceDir, input.draftId);
      let publication = state.publication;
      if (publication === undefined || state.runSha256 === undefined || state.closeAt === undefined || state.closedAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "a closed managed run with publication state is required before accounting publication");
      }
      const runSha256 = state.runSha256;
      const closedAt = state.closedAt;
      if (publication.accounting.state === "complete" && publication.matrixV2.state === "complete" && state.accountingSha256 !== undefined && state.matrixV2Sha256 !== undefined) {
        const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
        return { accountingSha256: state.accountingSha256, matrixV2Sha256: state.matrixV2Sha256, source: source.source };
      }
      const publicBaseUrl = publication.source.publicBaseUrl;
      if (publicBaseUrl === undefined) refuse("validation", "publicBaseUrl", "configure a publicBaseUrl before accounting publication");
      if (publication.registration.state !== "complete") refuse("conflict", `runs.${input.draftId}.publication.registration`, "registration must complete before accounting publication");
      const configuredSource = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
      if (configuredSource.source.agent !== publication.source.agentKeyRef || configuredSource.source.agent !== state.owner) {
        refuse("conflict", `runs.${input.draftId}.publication.source`, "Run owner and publication source must remain the same workspace did:key");
      }
      const compatible = assessPublicationCompatibility(context.workspaceDir, input.draftId);
      if (compatible.status !== "ready") refuse("record-integrity", `runs.${input.draftId}.publication`, compatible.reasons.join("; "));

      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (document.spec.taskSet.kind !== "benchmark") refuse("conflict", `drafts.${input.draftId}.taskSet`, "accounting publication requires a benchmark run");
      const runBytes = getSealedBytes(context.workspaceDir, state.runSha256);
      const run = parseRun(runBytes);
      const benchmark = parseBenchmark(getSealedBytes(context.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchmark, run);
      const lineage = foldRunJournalLineage(readRunJournalEntries(context.workspaceDir, input.draftId));
      const dispatches = [...lineage.values()].flat().map((line) => {
        if (line.submissionSha256 === undefined) refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}`, "dispatch has no pre-submit exact Submission capture");
        if (line.acceptedSubmissionSha256 !== undefined && line.acceptedSubmissionSha256 !== line.submissionSha256) {
          refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}`, "accepted Submission differs from the pre-submit captured Submission");
        }
        const supporting = [
          ...(line.observationArchiveSha256 === undefined ? [] : [{ digest: line.observationArchiveSha256, mediaType: BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE }]),
          ...(line.deliverySha256 === undefined ? [] : [{ digest: line.deliverySha256, mediaType: DELIVERY_MEDIA_TYPE }]),
          ...line.verdicts.map((value) => ({ digest: value.sha256, mediaType: "application/vnd.dsse.envelope.v1+json" })),
        ];
        return { cellKey: line.cellKey, index: line.dispatch, submissionSha256: line.submissionSha256, supporting };
      }).sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey) || left.index - right.index);

      // Phase one is replay-safe: source announcement ids are exact/deterministic.  Only after
      // every input is durable do we persist the immutable scope cutoff used to seal accounting.
      if (publication.accounting.sourceCutoff === undefined && publication.accounting.state === "not-started") {
        state = { ...state, publication: { ...publication, accounting: { ...publication.accounting, state: "in-progress", announcedAt: at } } };
        writeRunState(context.workspaceDir, input.draftId, state);
        publication = state.publication!;
      }
      const inputStageAt = publication.accounting.announcedAt ?? at;
      const frozen = publication.accounting.sourceCutoff === undefined
        ? await publishInputs({ workspaceDir: context.workspaceDir, draftId: input.draftId, at: inputStageAt, sourceName: publication.source.name, publicBaseUrl, dispatches })
        : { source: createWorkspacePublicationSource(context.workspaceDir, publication.source.name).source, cutoff: { sequence: publication.accounting.sourceCutoff.sourceSequence, entryDigest: `sha256:${publication.accounting.sourceCutoff.entrySha256}` as const } };
      if (publication.accounting.sourceCutoff === undefined) {
        state = { ...state, publication: { ...publication, accounting: { ...publication.accounting, state: "in-progress", announcedAt: publication.accounting.announcedAt ?? at, sourceCutoff: { sourceSequence: frozen.cutoff.sequence, entrySha256: frozen.cutoff.entryDigest.slice(7) } } } };
        writeRunState(context.workspaceDir, input.draftId, state);
        publication = state.publication!;
      }
      // This timestamp is a plan input, not a wall-clock observation. Retrying after a crash
      // must replay the identical source append fingerprint and publication-plan fingerprint.
      const stageAt = inputStageAt;
      if (publication.matrixV2.state === "not-started") {
        state = { ...state, publication: { ...publication, matrixV2: { state: "in-progress", announcedAt: stageAt } } };
        writeRunState(context.workspaceDir, input.draftId, state);
        publication = state.publication!;
      }

      const registrationReceipt = publication.registration.receipt;
      const firstSubmission = readRunJournalEntries(context.workspaceDir, input.draftId)
        .filter((entry): entry is Extract<RunJournalEntry, { kind: "submission-captured" }> => entry.kind === "submission-captured" && entry.publicationSourceSequence !== undefined)
        .sort((left, right) => left.publicationSourceSequence!.localeCompare(right.publicationSourceSequence!))[0];
      const prospective = publication.mode === "prospective" && publication.registration.postHoc !== true && registrationReceipt !== undefined && firstSubmission?.publicationSourceSequence !== undefined && firstSubmission.publicationEntrySha256 !== undefined;
      const { record: accounting, sealed: sealedAccounting } = buildBenchmarkAccounting({
        run: { name: "run", mediaType: RUN_MEDIA_TYPE, digest: { sha256: runSha256 } }, runOwner: state.owner, publisher: state.owner,
        publisherAuthority: { kind: "run-owner" },
        scope: [{ role: "https://spec.jinn.network/accounting-scopes/managed-submissions/v1", kind: "record-discovery", source: frozen.source, through: { sequence: frozen.cutoff.sequence, entry: frozen.cutoff.entryDigest } }],
        publicRegistration: prospective
          ? { status: "pre-dispatch", runBoundary: receiptPosition(frozen.source, { sequence: registrationReceipt.sourceSequence, entryDigest: `sha256:${registrationReceipt.entrySha256}` }), firstDispatchBoundary: receiptPosition(frozen.source, { sequence: firstSubmission.publicationSourceSequence!, entryDigest: `sha256:${firstSubmission.publicationEntrySha256!}` }) }
          : { status: "post-hoc" },
        closeBoundary: { at: closedAt }, expectedCellKeys: expected.map((cell) => cell.cellKey).sort(compareCodeUnitStrings),
        dispatches: dispatches.map((line) => ({
          cellKey: line.cellKey, index: line.index,
          submission: { kind: RECORD_KINDS.submission, record: { name: "submission", mediaType: SUBMISSION_MEDIA_TYPE, digest: { sha256: line.submissionSha256 } } },
          submissionBytes: getSealedBytes(context.workspaceDir, line.submissionSha256),
          ...(line.supporting.find((item) => item.mediaType === BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE) === undefined ? {} : { observations: { name: "observations", mediaType: BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE, digest: { sha256: line.supporting.find((item) => item.mediaType === BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE)!.digest } } }),
          ...(line.supporting.find((item) => item.mediaType === DELIVERY_MEDIA_TYPE) === undefined ? {} : {
            delivery: {
              kind: RECORD_KINDS.delivery,
              record: { name: "delivery", mediaType: DELIVERY_MEDIA_TYPE, digest: { sha256: line.supporting.find((item) => item.mediaType === DELIVERY_MEDIA_TYPE)!.digest } },
            },
          }),
          evaluations: line.supporting.filter((item) => item.mediaType === "application/vnd.dsse.envelope.v1+json").map((item) => ({ kind: RECORD_KINDS.resultEvaluation, record: { name: "evaluation", mediaType: item.mediaType, digest: { sha256: item.digest } } })),
        })),
      });
      const accountingSha256 = putSealedBytes(context.workspaceDir, sealedAccounting.bytes);
      const basePorts = buildRunAssemblyPorts({ workspaceDir: context.workspaceDir, draftId: input.draftId, runRecord: run, expected, fold: foldRunJournal(readRunJournalEntries(context.workspaceDir, input.draftId)), owner: state.owner, receiptsByTaskDigest: scanPredictionSnapshotAdmissionReceipts(context.workspaceDir) });
      const accountingInput = { bytes: sealedAccounting.bytes, record: accounting };
      const accountingChecks = async () => verifyBenchmarkAccounting({
        runOwner: state.owner, expectedCellKeys: expected.map((cell) => cell.cellKey), accounting,
        submissions: new Map(dispatches.map((line) => [`sha256:${line.submissionSha256}` as const, { bytes: getSealedBytes(context.workspaceDir, line.submissionSha256) }])),
        references: { async getExact({ digest }) { try { return getSealedBytes(context.workspaceDir, digest.slice(7)); } catch { return undefined; } } },
        // The durable source state is the authoritative local projection.  It is deliberately
        // filtered by the sealed Run annotation, not by a backend/venue query, so one workspace
        // source may safely carry multiple runs without widening this Run's accounting scope.
        scope: { async enumerate({ through }) {
          if (through === null || typeof through !== "object" || !("sequence" in through) || typeof through.sequence !== "string") {
            return { status: "incomplete" as const, detail: "managed Submission scope requires a record-discovery source cutoff" };
          }
          const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
          const durable = await source.writer.readState();
          const discovered: { cellKey: string; submissionDigest: `sha256:${string}` }[] = [];
          for (const announcement of Object.values(durable?.announcements ?? {})) {
            const receipt = announcement.receipt;
            if (receipt.sequence > through.sequence || receipt.record?.digest === undefined || receipt.record.digest === `sha256:${state.runSha256}`) continue;
            try {
              const bytes = await source.artifactStore.getExact(receipt.record.digest);
              if (bytes === undefined) return { status: "incomplete" as const, detail: `source record ${receipt.record.digest} is unavailable` };
              const submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
              if (submission.annotations?.run === `sha256:${state.runSha256}` && typeof submission.annotations.cellKey === "string") {
                discovered.push({ cellKey: submission.annotations.cellKey, submissionDigest: receipt.record.digest });
              }
            } catch {
              // Other source records are not accounting submissions. A record that *claims* the
              // Run but is malformed would have matched only after parse, so it remains safely
              // outside this typed Submission scope rather than being guessed into it.
            }
          }
          return { status: "complete" as const, dispatches: discovered };
        } },
      });
      const v2Ports = {
        ...basePorts,
        accountingVerification: { async verifyAccounting() { const verified = await accountingChecks(); return verified.status === "fail" ? { ok: false as const, detail: "BenchmarkAccounting validation failed" } : { ok: true as const }; } },
        accountingCompleteness: { async verifyCompleteness() { const verified = await accountingChecks(); return verified.status === "fail" ? { ok: false as const, detail: "BenchmarkAccounting scope completeness failed" } : { ok: true as const }; } },
      };
      const assembled = await assembleMatrixV2(benchmark, run, v2Ports, accountingInput);
      const verifiedMatrix = await verifyMatrixV2(assembled.record, benchmark, run, v2Ports, accountingInput, assembled.bytes);
      if (!verifiedMatrix.ok) refuse("record-integrity", "matrixV2", `${verifiedMatrix.check}: ${verifiedMatrix.detail}`);
      const matrixV2Sha256 = putSealedBytes(context.workspaceDir, assembled.bytes);

      const accountingProof = recordWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: accountingSha256, recordKind: BENCHMARK_ACCOUNTING_RECORD_KIND, authoredAt: stageAt });
      const matrixProof = recordWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: matrixV2Sha256, recordKind: MATRIX_RECORD_KIND, authoredAt: stageAt });
      const accountingRecord: PublicationRecord = { id: "benchmark-accounting", kind: BENCHMARK_ACCOUNTING_RECORD_KIND, digest: `sha256:${accountingSha256}`, bytes: sealedAccounting.bytes, mediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE, authority: { mode: "owner" }, actions: ["store", "announce"], announcementTimestamp: timestamp(stageAt, dispatches.length + 1), dependsOn: ["accounting-authorship"] };
      const matrixRecord: PublicationRecord = { id: "matrix-v2", kind: MATRIX_RECORD_KIND, digest: `sha256:${matrixV2Sha256}`, bytes: assembled.bytes, mediaType: MATRIX_MEDIA_TYPE, authority: { mode: "owner" }, actions: ["store", "announce"], announcementTimestamp: timestamp(stageAt, dispatches.length + 2), dependsOn: ["benchmark-accounting", "matrix-authorship"] };
      const plan: PublicationPlan = { id: `benchmark-accounting:${input.draftId}:${accountingSha256}:${matrixV2Sha256}`, stages: [{ stage: "accounting", members: [authorship("accounting-authorship", accountingProof.digestHex, accountingProof.bytes), accountingRecord, authorship("matrix-authorship", matrixProof.digestHex, matrixProof.bytes), matrixRecord] }] };
      const receipts = new Map<string, Receipt>();
      await withWorkspacePublicationSourceLock(context.workspaceDir, async () => {
        const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
        await source.writer.recover();
        await executePublicationPlan(plan, {
          objects: source.artifactStore, journal: createWorkspacePublicationJournal(context.workspaceDir, input.draftId, "accounting"),
          authority: { async authorizeAnnouncement({ record }) { requireWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: record.digest.slice(7), recordKind: record.kind, author: state.owner }); } },
          announce: { async announce(value) { const receipt = await createDiscoverySourceAnnouncementPort({ writer: source.writer }).announce(value) as Receipt; receipts.set(value.record.id, receipt); return receipt; } },
        });
      });
      const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
      await probeExact(publicBaseUrl, `sha256:${accountingSha256}`, sealedAccounting.bytes);
      await probeExact(publicBaseUrl, `sha256:${matrixV2Sha256}`, assembled.bytes);
      const durable = await source.writer.readState();
      const receiptFor = (id: string, digest: string) => receipts.get(id) ?? (() => {
        const match = Object.values(durable?.announcements ?? {}).find((item) => item.receipt.record?.digest === `sha256:${digest}`);
        if (match === undefined) throw new Error(`accounting publication journal completed without ${id} receipt`);
        return { sequence: match.receipt.sequence, entryDigest: match.receipt.entryDigest };
      })();
      const accountingReceipt = receiptFor("benchmark-accounting", accountingSha256);
      const matrixReceipt = receiptFor("matrix-v2", matrixV2Sha256);
      writeRunState(context.workspaceDir, input.draftId, { ...state, accountingSha256, matrixV2Sha256, publication: { ...publication,
        accounting: { ...publication.accounting, state: "complete", announcedAt: publication.accounting.announcedAt ?? at, sourceCutoff: publication.accounting.sourceCutoff, receipt: { sourceSequence: accountingReceipt.sequence, entrySha256: accountingReceipt.entryDigest.slice(7) }, digests: { accounting: accountingSha256 } },
        matrixV2: { ...publication.matrixV2, state: "complete", announcedAt: publication.matrixV2.announcedAt ?? stageAt, receipt: { sourceSequence: matrixReceipt.sequence, entrySha256: matrixReceipt.entryDigest.slice(7) }, digests: { matrixV2: matrixV2Sha256 } },
      } });
      return { accountingSha256, matrixV2Sha256, source: source.source };
    } finally { lock.release(); }
  } });
}
