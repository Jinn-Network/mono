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
  type AccountingScopeStream,
  type BenchmarkAccountingDispatch,
  type TypedRecordReference,
} from "@jinn-network/benchmarking-records";
import { buildBenchmarkAccounting, verifyBenchmarkAccounting, type PublicationCheck } from "@jinn-network/benchmarking-publication";
import { assembleMatrixV2, verifyMatrixV2 } from "@jinn-network/benchmarking-run";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { createDiscoverySourceAnnouncementPort } from "@jinn-network/record-publication";
import { executePublicationPlan, type OriginVerificationPort, type PublicationArtifact, type PublicationPlan, type PublicationRecord } from "@jinn-network/record-publication";
import { DELIVERY_MEDIA_TYPE, SUBMISSION_MEDIA_TYPE, DeliveryRecordSchema, SubmissionRecordSchema } from "@jinn-network/task-execution-protocol";
import { refuse } from "../errors.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { foldRunJournal, foldRunJournalLineage, readRunJournalEntries, type RunJournalEntry } from "../run/journal.js";
import { readPublicationOrigin, requireWorkspaceAuthorship, recordWorkspaceAuthorship, WORKSPACE_AUTHORSHIP_ROLE } from "../run/publication-authority.js";
import { assessPublicationCompatibility } from "../run/publication-compatibility.js";
import { createWorkspacePublicationJournal, createWorkspacePublicationSource, publicArchiveUrl, recordPath, withWorkspacePublicationSourceLock } from "../run/publication-source.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import {
  createRuntimeEvidenceAdapter,
  INSPECT_EVAL_LOG_ARTIFACT_ROLE,
  INSPECT_SELECTION_CORRELATION_ROLE,
} from "../runtime/adapter.js";
import { harborEvidenceContributionFromArchive, readHarborDispatchArchiveFor } from "../runtime/harbor/venue.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface PublicationAccountingInput { readonly draftId: string; }
export interface PublicationAccountingDeps {
  /** Required for every Delivery/evaluation record whose durable origin is not this source. */
  readonly verifyOrigin?: OriginVerificationPort;
  /** Test-only crash seam after input appends/probes and before cutoff checkpoint. */
  readonly afterInputsBeforeCutoff?: () => Promise<void>;
  /** Test-only sealed-scope tampering seam; production callers always omit it. */
  readonly transformAccountingScope?: (stream: AccountingScopeStream) => AccountingScopeStream;
}
export interface PublicationAccountingResult {
  readonly accountingSha256: string;
  readonly matrixV2Sha256: string;
  readonly source: { readonly agent: string; readonly name: string };
  readonly runtimeChecks: readonly PublicationCheck[];
}

type Receipt = { readonly sequence: string; readonly entryDigest: `sha256:${string}` };
type PublicationMember = PublicationArtifact | PublicationRecord;
const ACCOUNTING_REFERENCE_AUTHORITY_ROLE = "https://product.jinn.network/artifact-roles/accounting-reference-authority/v1";
const authorship = (id: string, digest: string, bytes: Uint8Array): PublicationArtifact => ({
  id, role: WORKSPACE_AUTHORSHIP_ROLE, digest: `sha256:${digest}`, bytes, mediaType: "application/vnd.jinn.colophon.workspace-authorship.v1+json", actions: ["store"],
});

function timestamp(at: string, offset: number): string { return new Date(Date.parse(at) + offset).toISOString(); }
async function probeExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  const response = await fetch(publicArchiveUrl(base, recordPath(digest)));
  if (!response.ok) throw new Error(`public accounting input probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (observed.length !== bytes.length || !observed.every((value, index) => value === bytes[index])) {
    throw new Error("public accounting input probe did not return the exact Submission bytes");
  }
}
async function probeArtifactExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  const response = await fetch(publicArchiveUrl(base, `/publication-artifacts/sha256/${digest.slice(7)}`));
  if (!response.ok) throw new Error(`public accounting artifact probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (observed.length !== bytes.length || !observed.every((value, index) => value === bytes[index])) {
    throw new Error(`public accounting artifact probe did not return exact bytes for ${digest}`);
  }
}
function receiptPosition(source: { agent: string; name: string }, receipt: Receipt) {
  return { kind: "record-discovery" as const, source, position: { sequence: receipt.sequence, entry: receipt.entryDigest } };
}

async function probePublishedInputs(input: {
  workspaceDir: string; publicBaseUrl: string;
  dispatches: readonly { submissionSha256: string; supporting: readonly { digest: string }[] }[];
  supportMembers: readonly PublicationMember[];
}): Promise<void> {
  for (const member of input.supportMembers) {
    if ("kind" in member && member.actions.includes("announce")) await probeExact(input.publicBaseUrl, member.digest, member.bytes);
    else await probeArtifactExact(input.publicBaseUrl, member.digest, member.bytes);
  }
  for (const dispatch of input.dispatches) {
    for (const supporting of dispatch.supporting) {
      const bytes = getSealedBytes(input.workspaceDir, supporting.digest);
      await probeArtifactExact(input.publicBaseUrl, `sha256:${supporting.digest}`, bytes);
    }
    const bytes = getSealedBytes(input.workspaceDir, dispatch.submissionSha256);
    await probeExact(input.publicBaseUrl, `sha256:${dispatch.submissionSha256}`, bytes);
  }
}

/** Store all non-record closure bytes and append every Submission before fixing the scope cutoff. */
async function publishInputs(input: {
  workspaceDir: string; draftId: string; at: string; sourceName: string; publicBaseUrl: string;
  dispatches: readonly { cellKey: string; index: number; submissionSha256: string; supporting: readonly { digest: string; mediaType: string }[] }[];
  supportMembers: readonly PublicationMember[];
  verifyOrigin?: OriginVerificationPort;
  owner: string;
}): Promise<{ source: { agent: string; name: string }; cutoff: Receipt }> {
  return withWorkspacePublicationSourceLock(input.workspaceDir, async () => {
    const source = createWorkspacePublicationSource(input.workspaceDir, input.sourceName);
    await source.writer.recover();
    let ordinal = 0;
    if (input.supportMembers.length > 0) {
      const members = [...input.supportMembers]
        .sort((left, right) => compareCodeUnitStrings(left.id, right.id))
        .map((member) => "kind" in member && member.actions.includes("announce")
          ? { ...member, announcementTimestamp: timestamp(input.at, ordinal++) }
          : member);
      const plan: PublicationPlan = { id: `benchmark-accounting-input-authority:${input.draftId}`, stages: [{ stage: "accounting", members }] };
      // Registration has already sealed its independent receipt. Reusing the neutral executor
      // here gives support provenance its own durable journal without replaying registration or
      // coupling either receipt to the later Accounting/Matrix product stage.
      await executePublicationPlan(plan, {
        objects: source.artifactStore,
        journal: createWorkspacePublicationJournal(input.workspaceDir, input.draftId, "accounting-inputs"),
        verifyOrigin: input.verifyOrigin,
        authority: { async authorizeAnnouncement({ record }) {
          requireWorkspaceAuthorship({ workspaceDir: input.workspaceDir, recordSha256: record.digest.slice(7), recordKind: record.kind, author: input.owner });
        } },
        announce: createDiscoverySourceAnnouncementPort({ writer: source.writer }),
      });
      for (const member of members) {
        if ("kind" in member && member.actions.includes("announce")) await probeExact(input.publicBaseUrl, member.digest, member.bytes);
        else await probeArtifactExact(input.publicBaseUrl, member.digest, member.bytes);
      }
    }
    let cutoff: Receipt | undefined;
    for (const dispatch of input.dispatches) {
      for (const supporting of dispatch.supporting) {
        const bytes = getSealedBytes(input.workspaceDir, supporting.digest);
        await source.artifactStore.putExact({ digest: `sha256:${supporting.digest}`, bytes, mediaType: supporting.mediaType });
        await probeArtifactExact(input.publicBaseUrl, `sha256:${supporting.digest}`, bytes);
      }
      const bytes = getSealedBytes(input.workspaceDir, dispatch.submissionSha256);
      const digest = `sha256:${dispatch.submissionSha256}` as const;
      const durable = await source.writer.readState();
      const existing = Object.values(durable?.announcements ?? {}).find((entry) => entry.receipt.record?.digest === digest);
      const receipt = existing?.receipt ?? await source.writer.append({
          timestamp: timestamp(input.at, ordinal++),
          announcement: {
            announcementId: `accounting-input:${input.draftId}:${dispatch.submissionSha256}`,
            action: "available",
            record: { kind: RECORD_KINDS.submission, digest, mediaType: SUBMISSION_MEDIA_TYPE },
          },
          record: { bytes, contentType: SUBMISSION_MEDIA_TYPE },
        });
      if (cutoff === undefined || receipt.sequence > cutoff.sequence) cutoff = { sequence: receipt.sequence, entryDigest: receipt.entryDigest };
      // A stored/announced input is not part of the accounting scope until it has passed the
      // same public exact-byte retrieval check used by registration.  A failure leaves the stage
      // recoverably in-progress and refuses before the cutoff is frozen.
      await probeExact(input.publicBaseUrl, digest, bytes);
    }
    if (cutoff === undefined) {
      const state = await source.writer.readState();
      if (state?.last === null || state?.last === undefined) throw new Error("accounting input publication produced no durable source cutoff");
      cutoff = { sequence: state.last.sequence, entryDigest: state.last.entryDigest };
    }
    return { source: source.source, cutoff };
  });
}

export function publicationAccounting(
  context: OperationContext,
  input: PublicationAccountingInput,
  deps: PublicationAccountingDeps = {},
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
      if (publication.accounting.state === "complete" && publication.matrixV2.state === "complete" && state.accountingSha256 !== undefined && state.matrixV2Sha256 !== undefined) {
        const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
        return { accountingSha256: state.accountingSha256, matrixV2Sha256: state.matrixV2Sha256, source: source.source, runtimeChecks: [] };
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
      const binding = document.spec.evaluationRuntime;
      const selectionBytes = binding === undefined ? undefined : getSealedBytes(context.workspaceDir, binding.selectionManifestSha256);
      const runtime = createRuntimeEvidenceAdapter(binding, selectionBytes === undefined ? {} : {
        selectionManifest: { digest: `sha256:${binding!.selectionManifestSha256}`, bytes: selectionBytes, mediaType: "application/json" },
      });
      const runtimeChecks: PublicationCheck[] = [];
      const supportMembers = new Map<string, PublicationMember>();
      const dispatches = [] as Array<{
        cellKey: string; index: number; submissionSha256: string;
        supporting: { digest: string; mediaType: string }[];
        attempt?: string; observations?: BenchmarkAccountingDispatch["observations"];
        delivery?: TypedRecordReference; evidence: TypedRecordReference[]; evaluations: TypedRecordReference[];
        correlations: BenchmarkAccountingDispatch["correlations"];
        nativeArtifacts: BenchmarkAccountingDispatch["nativeArtifacts"];
      }>;
      for (const line of [...lineage.values()].flat()) {
        if (line.submissionSha256 === undefined) refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}`, "dispatch has no pre-submit exact Submission capture");
        if (line.acceptedSubmissionSha256 !== undefined && line.acceptedSubmissionSha256 !== line.submissionSha256) {
          refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}`, "accepted Submission differs from the pre-submit captured Submission");
        }
        const supporting: { digest: string; mediaType: string }[] = [
          ...(line.observationArchiveSha256 === undefined ? [] : [{ digest: line.observationArchiveSha256, mediaType: BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE }]),
        ];
        const authorityEntries: Array<Record<string, unknown>> = [];
        const publicationReference = (kind: string, digestHex: string, mediaType: string, name: string): TypedRecordReference => {
          const bytes = getSealedBytes(context.workspaceDir, digestHex);
          try {
            const proof = requireWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: digestHex, recordKind: kind, author: state.owner });
            const proofId = `input-authorship:${digestHex}`;
            supportMembers.set(proofId, { ...authorship(proofId, proof.digestHex, proof.bytes) });
            supportMembers.set(`input-owned:${kind}:${digestHex}`, {
              id: `input-owned:${kind}:${digestHex}`, kind, digest: `sha256:${digestHex}`, bytes, mediaType,
              authority: { mode: "owner" }, actions: ["store", "announce"], dependsOn: [proofId],
            });
            authorityEntries.push({ record: { kind, digest: `sha256:${digestHex}` }, authority: { mode: "owner", author: state.owner, authorship: { digest: `sha256:${proof.digestHex}` } } });
          } catch {
            const origin = readPublicationOrigin(context.workspaceDir, `sha256:${digestHex}`);
            if (origin === undefined) refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}.${name}`, `${name} has neither valid workspace authorship nor a durable origin position`);
            supportMembers.set(`input-origin:${kind}:${digestHex}`, {
              id: `input-origin:${kind}:${digestHex}`, kind, digest: `sha256:${digestHex}`, bytes, mediaType,
              authority: { mode: "origin-reference", origin }, actions: ["verify-origin", "mirror"],
            });
            authorityEntries.push({ record: { kind, digest: `sha256:${digestHex}` }, authority: { mode: "origin-reference", origin } });
          }
          return { kind, record: { name, mediaType, digest: { sha256: digestHex } } };
        };
        const parsedDelivery = line.deliverySha256 === undefined ? undefined : DeliveryRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, line.deliverySha256))));
        const delivery = line.deliverySha256 === undefined ? undefined : publicationReference(RECORD_KINDS.delivery, line.deliverySha256, DELIVERY_MEDIA_TYPE, "delivery");
        // Intentional, and the counterpart of `run/drive.ts`'s local-authorship filter: evaluations
        // are announced from `line.verdicts` on the next line, never from a delivery's evidence
        // reference list. The journal names the exact envelope bytes this product fetched and
        // sealed, and `drive.ts` records their `resultEvaluation` authorship at that same moment;
        // a reference list, by contrast, can name an evaluation whose bytes this workspace never
        // held. Announcing from the journal is what makes every announced evaluation one this
        // workspace can speak for. The managed local venue puts only its execution-evidence
        // receipt in `evidenceRecords`, so today this filter drops nothing -- it is what keeps a
        // future adapter that does list evaluations from announcing one twice, the second time
        // under no authority at all.
        const evidence = (parsedDelivery?.evidenceRecords ?? []).filter((reference) => reference.family !== "result-evaluation").map((reference) => {
          const digestHex = reference.digest.slice("sha256:".length);
          const kind = reference.family === "execution-evidence" ? RECORD_KINDS.executionEvidence : RECORD_KINDS.executionVerification;
          return publicationReference(kind, digestHex, "application/vnd.dsse.envelope.v1+json", reference.family);
        });
        const evaluations = line.verdicts.map((value) => publicationReference(RECORD_KINDS.resultEvaluation, value.sha256, "application/vnd.dsse.envelope.v1+json", "evaluation"));
        const submission: TypedRecordReference = { kind: RECORD_KINDS.submission, record: { name: "submission", mediaType: SUBMISSION_MEDIA_TYPE, digest: { sha256: line.submissionSha256 } } };

        const authorityCorrelation = authorityEntries.length === 0 ? undefined : (() => {
          const bytes = canonicalJsonBytes({
            schema: "jinn.network/benchmark-product/accounting-reference-authority/1",
            references: authorityEntries.sort((left, right) => compareCodeUnitStrings(JSON.stringify(left.record), JSON.stringify(right.record))),
          });
          const digest = putSealedBytes(context.workspaceDir, bytes);
          return { role: ACCOUNTING_REFERENCE_AUTHORITY_ROLE, artifact: { name: "reference-authority.json", mediaType: "application/vnd.jinn.benchmark-accounting-reference-authority.v1+json", digest: { sha256: digest } } };
        })();

        let contributed: Pick<BenchmarkAccountingDispatch, "correlations" | "nativeArtifacts"> = { correlations: [], nativeArtifacts: [] };
        let captureCheck: PublicationCheck | undefined;
        if (binding?.adapterId === "harbor" || binding?.adapterId === "pier") {
          try {
            const indexed = readHarborDispatchArchiveFor(context.workspaceDir, { runSha256, cellKey: line.cellKey, dispatchIndex: line.dispatch, submissionSha256: line.submissionSha256 });
            if (line.attempt !== indexed.archive.lineage.attemptUri) throw new Error("journal Attempt does not match the Harbor archive");
            const harbor = harborEvidenceContributionFromArchive(context.workspaceDir, indexed.archiveSha256);
            contributed = await runtime.dispatch({ submission, attempt: line.attempt, correlations: [...harbor.correlations, ...(authorityCorrelation === undefined ? [] : [authorityCorrelation])], nativeArtifacts: harbor.nativeArtifacts });
            captureCheck = { name: "harbor-durable-dispatch-archive", status: "pass" };
          } catch (cause) {
            // Still run the selected adapter over the incomplete contribution so its required
            // profile checks remain visible as fail/indeterminate facts. Never silently omit a
            // dispatch merely because its durable archive is missing or tampered.
            contributed = await runtime.dispatch({ submission, attempt: line.attempt, correlations: authorityCorrelation === undefined ? [] : [authorityCorrelation], nativeArtifacts: [] });
            captureCheck = { name: "harbor-durable-dispatch-archive", status: "indeterminate", detail: cause instanceof Error ? cause.message : String(cause) };
          }
        } else if (binding?.adapterId === "inspect") {
          let evalLog: BenchmarkAccountingDispatch["nativeArtifacts"][number] = { role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "collection-failed", reason: "sealed Delivery carries no inspect-log output" };
          if (parsedDelivery !== undefined) {
            const output = parsedDelivery.outputs.find((candidate) => candidate.name === "inspect-log" && candidate.digest?.sha256 !== undefined);
            if (output?.digest?.sha256 !== undefined) evalLog = { role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "public", artifact: { name: output.name, mediaType: output.mediaType ?? "application/vnd.inspect-ai.eval", digest: { sha256: output.digest.sha256 } } };
          }
          contributed = await runtime.dispatch({
            submission, attempt: line.attempt,
            correlations: [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: { name: "inspect-selection-manifest.json", mediaType: "application/json", digest: { sha256: binding.selectionManifestSha256 } } }, ...(authorityCorrelation === undefined ? [] : [authorityCorrelation])],
            nativeArtifacts: [evalLog],
          });
        } else {
          contributed = await runtime.dispatch({ submission, attempt: line.attempt, correlations: authorityCorrelation === undefined ? [] : [authorityCorrelation] });
        }
        for (const correlation of contributed.correlations) supporting.push({ digest: correlation.artifact.digest.sha256, mediaType: correlation.artifact.mediaType ?? "application/octet-stream" });
        for (const artifact of contributed.nativeArtifacts) if (artifact.availability === "public" && artifact.artifact !== undefined) supporting.push({ digest: artifact.artifact.digest.sha256, mediaType: artifact.artifact.mediaType ?? "application/octet-stream" });
        const runtimeDispatch: BenchmarkAccountingDispatch = {
          index: line.dispatch, submission, ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
          ...(line.observationArchiveSha256 === undefined ? {} : { observations: { name: "observations", mediaType: BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE, digest: { sha256: line.observationArchiveSha256 } } }),
          ...(delivery === undefined ? {} : { delivery }), evidence, evaluations,
          correlations: contributed.correlations, nativeArtifacts: contributed.nativeArtifacts,
        };
        const checks = await runtime.verify({ dispatch: runtimeDispatch, references: { async getExact({ digest }) { try { return getSealedBytes(context.workspaceDir, digest.slice(7)); } catch { return undefined; } } } });
        const dispatchChecks = [...(captureCheck === undefined ? [] : [captureCheck]), ...checks];
        runtimeChecks.push(...dispatchChecks);
        const blocked = dispatchChecks.find((check) => check.status !== "pass");
        if (blocked !== undefined) refuse("record-integrity", `runs.${input.draftId}.${line.cellKey}.${line.dispatch}.runtime`, `${blocked.name} is ${blocked.status}: ${blocked.detail ?? "runtime evidence is incomplete"}`);
        dispatches.push({
          cellKey: line.cellKey, index: line.dispatch, submissionSha256: line.submissionSha256, supporting,
          ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
          ...(line.observationArchiveSha256 === undefined ? {} : { observations: runtimeDispatch.observations }),
          ...(delivery === undefined ? {} : { delivery }), evidence, evaluations,
          correlations: contributed.correlations, nativeArtifacts: contributed.nativeArtifacts,
        });
      }
      dispatches.sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey) || left.index - right.index);
      if ([...supportMembers.values()].some((member) => "kind" in member && member.authority.mode === "origin-reference") && deps.verifyOrigin === undefined) {
        refuse("record-integrity", `runs.${input.draftId}.publication.origin`, "Delivery/evaluation/evidence references require an injected exact origin verifier");
      }

      // Phase one is replay-safe: source announcement ids are exact/deterministic.  Only after
      // every input is durable do we persist the immutable scope cutoff used to seal accounting.
      if (publication.accounting.sourceCutoff === undefined && publication.accounting.state === "not-started") {
        state = { ...state, publication: { ...publication, accounting: { ...publication.accounting, state: "in-progress", announcedAt: at } } };
        writeRunState(context.workspaceDir, input.draftId, state);
        publication = state.publication!;
      }
      const inputStageAt = publication.accounting.announcedAt ?? at;
      const hadFrozenCutoff = publication.accounting.sourceCutoff !== undefined;
      const frozen = !hadFrozenCutoff
        ? await publishInputs({ workspaceDir: context.workspaceDir, draftId: input.draftId, at: inputStageAt, sourceName: publication.source.name, publicBaseUrl, dispatches, supportMembers: [...supportMembers.values()], verifyOrigin: deps.verifyOrigin, owner: state.owner })
        : { source: createWorkspacePublicationSource(context.workspaceDir, publication.source.name).source, cutoff: { sequence: publication.accounting.sourceCutoff!.sourceSequence, entryDigest: `sha256:${publication.accounting.sourceCutoff!.entrySha256}` as const } };
      if (hadFrozenCutoff) {
        // A cutoff freezes membership, not availability. A retry re-probes every referenced
        // public input and remains in-progress if any byte has disappeared or changed.
        await probePublishedInputs({ workspaceDir: context.workspaceDir, publicBaseUrl, dispatches, supportMembers: [...supportMembers.values()] });
      }
      if (publication.accounting.sourceCutoff === undefined) {
        await deps.afterInputsBeforeCutoff?.();
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
      const managedScope: AccountingScopeStream = {
        role: "https://spec.jinn.network/accounting-scopes/managed-submissions/v1", kind: "record-discovery", source: frozen.source,
        through: { sequence: frozen.cutoff.sequence, entry: frozen.cutoff.entryDigest },
      };
      const { record: accounting, sealed: sealedAccounting } = buildBenchmarkAccounting({
        run: { name: "run", mediaType: RUN_MEDIA_TYPE, digest: { sha256: runSha256 } }, runOwner: state.owner, publisher: state.owner,
        publisherAuthority: { kind: "run-owner" },
        scope: [deps.transformAccountingScope?.(managedScope) ?? managedScope],
        publicRegistration: prospective
          ? { status: "pre-dispatch", runBoundary: receiptPosition(frozen.source, { sequence: registrationReceipt.sourceSequence, entryDigest: `sha256:${registrationReceipt.entrySha256}` }), firstDispatchBoundary: receiptPosition(frozen.source, { sequence: firstSubmission.publicationSourceSequence!, entryDigest: `sha256:${firstSubmission.publicationEntrySha256!}` }) }
          : { status: "post-hoc" },
        // Matrix assembly resolves the effective boundary from the sealed Run. `closedAt` is a
        // product checkpoint and may be later; publishing it here would make v2 unverifiable.
        closeBoundary: { at: run.closeAt }, expectedCellKeys: expected.map((cell) => cell.cellKey).sort(compareCodeUnitStrings),
        dispatches: dispatches.map((line) => ({
          cellKey: line.cellKey, index: line.index,
          submission: { kind: RECORD_KINDS.submission, record: { name: "submission", mediaType: SUBMISSION_MEDIA_TYPE, digest: { sha256: line.submissionSha256 } } },
          submissionBytes: getSealedBytes(context.workspaceDir, line.submissionSha256),
          ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
          ...(line.observations === undefined ? {} : { observations: line.observations }),
          ...(line.delivery === undefined ? {} : { delivery: line.delivery }),
          evidence: line.evidence,
          evaluations: line.evaluations,
          correlations: line.correlations,
          nativeArtifacts: line.nativeArtifacts,
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
        scope: { async enumerate({ stream, through }) {
          const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
          if (stream.kind !== "record-discovery") return { status: "incomplete" as const, detail: "managed Submission scope requires a record-discovery stream" };
          if (stream.source.agent !== source.source.agent || stream.source.name !== source.source.name) {
            return { status: "unavailable" as const, detail: "declared accounting scope source does not equal the configured workspace publication source" };
          }
          if (through === null || typeof through !== "object" || !("sequence" in through) || typeof through.sequence !== "string" || !("entry" in through) || typeof through.entry !== "string") {
            return { status: "incomplete" as const, detail: "managed Submission scope requires an exact record-discovery sequence and entry digest" };
          }
          if (stream.through.sequence !== through.sequence || stream.through.entry !== through.entry) {
            return { status: "incomplete" as const, detail: "scope verifier cutoff does not equal the declared record-discovery cutoff" };
          }
          const durable = await source.writer.readState();
          if (durable === undefined || durable.source.agent !== source.source.agent || durable.source.name !== source.source.name) {
            return { status: "unavailable" as const, detail: "configured workspace publication source state is unavailable or belongs to another source" };
          }
          const cutoffReceipts = Object.values(durable.announcements).filter((announcement) => announcement.receipt.sequence === through.sequence);
          if (cutoffReceipts.length !== 1) {
            return { status: "incomplete" as const, detail: `declared cutoff sequence ${through.sequence} resolves to ${cutoffReceipts.length} durable receipts` };
          }
          if (cutoffReceipts[0]!.receipt.entryDigest !== through.entry) {
            return { status: "incomplete" as const, detail: `declared cutoff entry ${through.entry} does not match durable receipt ${cutoffReceipts[0]!.receipt.entryDigest}` };
          }
          const discovered: { cellKey: string; submissionDigest: `sha256:${string}` }[] = [];
          for (const announcement of Object.values(durable.announcements)) {
            const receipt = announcement.receipt;
            if (receipt.sequence > through.sequence || receipt.record?.digest === undefined || receipt.record.digest === `sha256:${state.runSha256}`) continue;
            let bytes: Uint8Array | undefined;
            try {
              bytes = await source.recordStore.getExact(receipt.record.digest);
            } catch (cause) {
              return { status: "incomplete" as const, detail: `source record ${receipt.record.digest} failed exact retrieval: ${cause instanceof Error ? cause.message : String(cause)}` };
            }
            if (bytes === undefined) return { status: "incomplete" as const, detail: `source record ${receipt.record.digest} is unavailable` };
            try {
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
        accountingVerification: { async verifyAccounting() {
          const verified = await accountingChecks();
          const blocked = verified.checks.find((check) => check.status !== "pass");
          return verified.status === "pass" ? { ok: true as const } : { ok: false as const, detail: `${blocked?.name ?? "benchmark-accounting"} is ${blocked?.status ?? verified.status}: ${blocked?.detail ?? "verification was not conclusive"}` };
        } },
        accountingCompleteness: { async verifyCompleteness() {
          const verified = await accountingChecks();
          const scope = verified.checks.find((check) => check.name === "scope-cutoff-dispatch-completeness");
          return scope?.status === "pass" ? { ok: true as const } : { ok: false as const, detail: `scope-cutoff-dispatch-completeness is ${scope?.status ?? "indeterminate"}: ${scope?.detail ?? "scope was not conclusively enumerated"}` };
        } },
      };
      const assembled = await assembleMatrixV2(benchmark, run, v2Ports, accountingInput);
      const verifiedMatrix = await verifyMatrixV2(assembled.record, benchmark, run, v2Ports, accountingInput, assembled.bytes);
      if (!verifiedMatrix.ok) refuse("record-integrity", "matrixV2", `${verifiedMatrix.check}: ${verifiedMatrix.detail}`);
      const matrixV2Sha256 = putSealedBytes(context.workspaceDir, assembled.bytes);

      const accountingProof = recordWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: accountingSha256, recordKind: BENCHMARK_ACCOUNTING_RECORD_KIND, authoredAt: stageAt });
      const matrixProof = recordWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256: matrixV2Sha256, recordKind: MATRIX_RECORD_KIND, authoredAt: stageAt });
      const inputTimestampUpperBound = dispatches.length + [...supportMembers.values()].filter((member) => "kind" in member && member.actions.includes("announce")).length;
      const accountingRecord: PublicationRecord = { id: "benchmark-accounting", kind: BENCHMARK_ACCOUNTING_RECORD_KIND, digest: `sha256:${accountingSha256}`, bytes: sealedAccounting.bytes, mediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE, authority: { mode: "owner" }, actions: ["store", "announce"], announcementTimestamp: timestamp(stageAt, inputTimestampUpperBound + 1), dependsOn: ["accounting-authorship"] };
      const matrixRecord: PublicationRecord = { id: "matrix-v2", kind: MATRIX_RECORD_KIND, digest: `sha256:${matrixV2Sha256}`, bytes: assembled.bytes, mediaType: MATRIX_MEDIA_TYPE, authority: { mode: "owner" }, actions: ["store", "announce"], announcementTimestamp: timestamp(stageAt, inputTimestampUpperBound + 2), dependsOn: ["benchmark-accounting", "matrix-authorship"] };
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
      return { accountingSha256, matrixV2Sha256, source: source.source, runtimeChecks };
    } finally { lock.release(); }
  } });
}
