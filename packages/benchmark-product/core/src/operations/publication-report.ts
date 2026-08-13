/**
 * Signed Report v2 publication is deliberately separate from the legacy `report` lifecycle
 * operation.  The latter remains a Report-v1 payload/claim-package workflow; this operation
 * consumes the already-public accounting closure and announces only the signed v2 envelope.
 *
 * All policy/evidence work happens before anything new is persisted.  Once the deterministic
 * payload/envelope has independently verified, the neutral executor stores the payload and
 * authorship proof before its single owned envelope announcement.  Its journal is the durable
 * crash-resume checkpoint; RunState is updated only after that append is recoverable.
 */

import {
  BENCHMARKING_METHOD_IDS,
  REPORT_MEDIA_TYPE,
  REPORT_V2_RECORD_KIND,
  SIGNED_REPORT_MEDIA_TYPE,
  type BenchmarkAccountingRecord,
  parseBenchmarkAccounting,
  parseMatrix,
  parseRun,
  parseSignedReportRecord,
} from "@jinn-network/benchmarking-records";
import { produceReportV2, verifyReportV2 } from "@jinn-network/benchmarking-aggregate";
import { executePublicationPlan, type PublicationArtifact, type PublicationPlan, type PublicationRecord } from "@jinn-network/record-publication";
import { resolveAssurance } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { buildMethodPorts } from "../report/ports.js";
import { createReportDsseSigner, loadOrCreateReportSigningKey } from "../report/signing.js";
import { buildWorkspaceTrustDeps } from "../report/trust.js";
import { previewDisclosureLine, readPreviewLog } from "../run/preview-log.js";
import { recordWorkspaceAuthorship, requireWorkspaceAuthorship, WORKSPACE_AUTHORSHIP_ROLE } from "../run/publication-authority.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import { createWorkspacePublicationJournal, createWorkspacePublicationSource, recordPath, withWorkspacePublicationSourceLock } from "../run/publication-source.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { LOCAL_VENUE_LIMITS } from "./run-results.js";

export interface PublicationReportInput { readonly draftId: string; }
export interface PublicationReportDeps {
  /** Test-only crash seam after the durable source append, before the RunState checkpoint. */
  readonly afterAppendBeforeCheckpoint?: () => Promise<void>;
}
export interface PublicationReportResult {
  readonly reportPayloadSha256: string;
  readonly reportRecordSha256: string;
  readonly source: { readonly agent: string; readonly name: string };
  readonly receipt: { readonly sourceSequence: string; readonly entrySha256: string };
  readonly preregistered: boolean;
}

const REPORT_PAYLOAD_ROLE = "https://spec.jinn.network/artifact-roles/benchmark-report-payload/v1";
const PAIRED_ESTIMATE_LIMITATION =
  "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function publicUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function probeRecord(base: string, digest: string, bytes: Uint8Array, label: string): Promise<void> {
  const response = await fetch(publicUrl(base, recordPath(`sha256:${digest}`)));
  if (!response.ok) throw new Error(`public ${label} probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (!bytesEqual(observed, bytes)) throw new Error(`public ${label} probe did not return the exact sealed bytes`);
}

async function probeArtifact(base: string, digest: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(publicUrl(base, `/publication-artifacts/sha256/${digest}`));
  if (!response.ok) throw new Error(`public Report payload probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (!bytesEqual(observed, bytes)) throw new Error("public Report payload probe did not return exact payload bytes");
}

/** Accounting owns the disclosure of its support. A Report may use it only while every disclosed
 * exact dependency still resolves byte-for-byte from the public source (record or mirror path). */
async function probeAccountingSupport(base: string, workspaceDir: string, accounting: BenchmarkAccountingRecord): Promise<void> {
  const probeEither = async (digest: string, label: string) => {
    const bytes = getSealedBytes(workspaceDir, digest);
    try {
      await probeRecord(base, digest, bytes, label);
      return;
    } catch {
      await probeArtifact(base, digest, bytes);
    }
  };
  for (const cell of accounting.cells) for (const dispatch of cell.dispatches) {
    const recordReferences = [dispatch.submission, dispatch.delivery, ...(dispatch.evidence ?? []), ...(dispatch.evaluations ?? [])]
      .filter((reference): reference is NonNullable<typeof reference> => reference !== undefined);
    for (const reference of recordReferences) await probeEither(reference.record.digest.sha256, "accounting support record");
    if (dispatch.observations !== undefined) await probeEither(dispatch.observations.digest.sha256, "observation archive");
    for (const correlation of dispatch.correlations ?? []) await probeEither(correlation.artifact.digest.sha256, "accounting correlation");
    for (const native of dispatch.nativeArtifacts ?? []) {
      if (native.availability === "public" && native.artifact !== undefined) await probeEither(native.artifact.digest.sha256, "native evidence");
    }
  }
}

function receiptFor(source: Awaited<ReturnType<typeof createWorkspacePublicationSource>>, digest: string) {
  return source.writer.readState().then((state) => {
    const receipt = Object.values(state?.announcements ?? {}).find((entry) => entry.receipt.record?.digest === `sha256:${digest}`)?.receipt;
    if (receipt === undefined) throw new Error("report publication completed without a durable signed-envelope receipt");
    return receipt;
  });
}

/**
 * Announces the v2 envelope only after accounting and Matrix v2 are complete and retrievable.
 * It never invokes a backend or venue, so it is equally valid for post-hoc managed-run closure.
 */
export function publicationReport(
  context: OperationContext,
  input: PublicationReportInput,
  deps: PublicationReportDeps = {},
): Promise<OperationResult<PublicationReportResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "publication.report", subject: input.draftId, inputs: input, run: async () => {
    const lock = await acquirePublicationLock(context.workspaceDir, input.draftId);
    try {
      let state = requireRunState(context.workspaceDir, input.draftId);
      const publication = state.publication;
      if (publication === undefined || state.runSha256 === undefined || state.accountingSha256 === undefined || state.matrixV2Sha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "a managed Run with complete BenchmarkAccounting and Matrix v2 is required before signed report publication");
      }
      if (publication.registration.state !== "complete" || publication.accounting.state !== "complete" || publication.matrixV2.state !== "complete") {
        refuse("conflict", `runs.${input.draftId}.publication`, "registration, accounting, and Matrix v2 publication must complete before signed report publication");
      }
      if (publication.report.state === "complete") {
        if (state.reportPayloadSha256 === undefined || state.reportRecordSha256 === undefined || publication.report.receipt === undefined) {
          refuse("record-integrity", `runs.${input.draftId}.publication.report`, "completed report stage is missing its identities or durable receipt");
        }
        const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
        return {
          reportPayloadSha256: state.reportPayloadSha256,
          reportRecordSha256: state.reportRecordSha256,
          source: source.source,
          receipt: publication.report.receipt,
          preregistered: parseSignedReportRecord(getSealedBytes(context.workspaceDir, state.reportRecordSha256)).payload.preregistered ?? false,
        };
      }
      const publicBaseUrl = publication.source.publicBaseUrl;
      if (publicBaseUrl === undefined) refuse("validation", "publicBaseUrl", "configure a publicBaseUrl before signed report publication");
      const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
      if (source.source.agent !== publication.source.agentKeyRef || source.source.agent !== state.owner) {
        refuse("conflict", `runs.${input.draftId}.publication.source`, "Run owner and publication source must remain the same workspace did:key");
      }

      // These exact-public probes are a report policy gate, not a best-effort presentation check.
      const accountingBytes = getSealedBytes(context.workspaceDir, state.accountingSha256);
      const matrixBytes = getSealedBytes(context.workspaceDir, state.matrixV2Sha256);
      try {
        const accounting = parseBenchmarkAccounting(accountingBytes);
        parseMatrix(matrixBytes);
        await probeRecord(publicBaseUrl, state.accountingSha256, accountingBytes, "BenchmarkAccounting");
        await probeRecord(publicBaseUrl, state.matrixV2Sha256, matrixBytes, "Matrix v2");
        await probeAccountingSupport(publicBaseUrl, context.workspaceDir, accounting);
      } catch (cause) {
        refuse("record-integrity", "publication.report.dependencies", cause instanceof Error ? cause.message : String(cause));
      }

      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (document.spec.taskSet.kind !== "benchmark") refuse("conflict", `drafts.${input.draftId}.taskSet`, "signed report publication requires a benchmark run");
      const run = parseRun(getSealedBytes(context.workspaceDir, state.runSha256));
      const selected = run.analysisPlan?.[run.analysisPlan.length - 1];
      if (selected === undefined) refuse("record-integrity", "run", "sealed Run carries no analysisPlan entry to report from");
      const previewLog = readPreviewLog(context.workspaceDir, input.draftId);
      const previewLimitation = previewLog !== undefined && previewLog.count > 0 ? previewDisclosureLine(previewLog) : undefined;
      const limitations = selected.method === BENCHMARKING_METHOD_IDS.pairedDelta
        ? [...LOCAL_VENUE_LIMITS, PAIRED_ESTIMATE_LIMITATION, ...(previewLimitation === undefined ? [] : [previewLimitation])]
        : previewLimitation === undefined ? LOCAL_VENUE_LIMITS : [...LOCAL_VENUE_LIMITS, previewLimitation];

      // Produce and independently verify before writing payload/envelope/authorship bytes or
      // advancing the report stage. An unsupported/partial method leaves accounting honestly complete.
      const signer = createReportDsseSigner(loadOrCreateReportSigningKey(context.workspaceDir));
      let produced: Awaited<ReturnType<typeof produceReportV2>>;
      try {
        produced = await produceReportV2({
          ...buildMethodPorts(context.workspaceDir),
          subjects: [matrixBytes],
          method: { id: selected.method, version: selected.version, parameters: selected.parameters },
          verdictRule: resolveAssurance(document.spec.assurance).verdictRule,
          limitations,
          author: state.owner,
          publicRegistration: { accountingBytes: [accountingBytes] },
        }, signer);
      } catch (cause) {
        refuse("conflict", "publication.report.policy", cause instanceof Error ? cause.message : String(cause));
      }
      const verified = await verifyReportV2({
        envelopeBytes: produced.envelope,
        subjects: [matrixBytes],
        effectiveTime: at,
        recordKind: REPORT_V2_RECORD_KIND,
        recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
        publicRegistration: { accountingBytes: [accountingBytes] },
      }, {
        ...buildMethodPorts(context.workspaceDir),
        trust: buildWorkspaceTrustDeps({ workspaceDir: context.workspaceDir, author: state.owner }),
      });
      if (!verified.ok) refuse("record-integrity", "publication.report.verify", `${verified.check}: ${verified.detail}`);
      if (verified.reportPayloadSha256 !== produced.reportPayloadSha256 || verified.reportRecordSha256 !== produced.reportRecordSha256) {
        refuse("record-integrity", "publication.report.verify", "independent v2 verification returned different payload or envelope identities");
      }
      for (const [field, value] of [["reportPayloadSha256", state.reportPayloadSha256], ["reportRecordSha256", state.reportRecordSha256]] as const) {
        if (value !== undefined && value !== (field === "reportPayloadSha256" ? produced.reportPayloadSha256 : produced.reportRecordSha256)) {
          refuse("conflict", `runs.${input.draftId}.${field}`, "report identity is immutable once established");
        }
      }

      const stageAt = publication.report.announcedAt ?? at;
      if (publication.report.state === "not-started") {
        state = { ...state, publication: { ...publication, report: { state: "in-progress", announcedAt: stageAt } } };
        writeRunState(context.workspaceDir, input.draftId, state);
      }
      const payloadSha256 = putSealedBytes(context.workspaceDir, produced.bytes);
      const recordSha256 = putSealedBytes(context.workspaceDir, produced.envelope);
      if (payloadSha256 !== produced.reportPayloadSha256 || recordSha256 !== produced.reportRecordSha256) {
        refuse("record-integrity", "publication.report", "sealed-store identities differ from Report v2 identities");
      }
      const proof = recordWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256, recordKind: REPORT_V2_RECORD_KIND, authoredAt: stageAt });
      // The payload is a public dependency of the envelope record.  Make it durable and prove
      // exact retrieval before the neutral plan reaches its sole `announce` action.
      await source.artifactStore.putExact({ digest: `sha256:${payloadSha256}`, bytes: produced.bytes, mediaType: REPORT_MEDIA_TYPE });
      await probeArtifact(publicBaseUrl, payloadSha256, produced.bytes);
      const members: readonly (PublicationArtifact | PublicationRecord)[] = [
        { id: "report-payload", role: REPORT_PAYLOAD_ROLE, digest: `sha256:${payloadSha256}`, bytes: produced.bytes, mediaType: REPORT_MEDIA_TYPE, actions: ["store"] },
        { id: "report-authorship", role: WORKSPACE_AUTHORSHIP_ROLE, digest: `sha256:${proof.digestHex}`, bytes: proof.bytes, mediaType: proof.mediaType, actions: ["store"] },
        { id: "signed-report-v2", kind: REPORT_V2_RECORD_KIND, digest: `sha256:${recordSha256}`, bytes: produced.envelope, mediaType: SIGNED_REPORT_MEDIA_TYPE, authority: { mode: "owner" }, actions: ["store", "announce"], announcementTimestamp: stageAt, dependsOn: ["report-payload", "report-authorship"] },
      ];
      const plan: PublicationPlan = { id: `benchmark-report-v2:${input.draftId}:${payloadSha256}:${recordSha256}`, stages: [{ stage: "report", members }] };
      await withWorkspacePublicationSourceLock(context.workspaceDir, async () => {
        await source.writer.recover();
        await executePublicationPlan(plan, {
          objects: source.artifactStore,
          journal: createWorkspacePublicationJournal(context.workspaceDir, input.draftId, "report"),
          authority: { async authorizeAnnouncement({ record }) {
            if (record.kind !== REPORT_V2_RECORD_KIND || record.digest !== `sha256:${recordSha256}` || source.source.agent !== state.owner) {
              throw new Error("only this workspace owner's exact signed Report v2 envelope may be announced");
            }
            requireWorkspaceAuthorship({ workspaceDir: context.workspaceDir, recordSha256, recordKind: REPORT_V2_RECORD_KIND, author: state.owner });
          } },
          announce: { async announce(value) { return source.writer.append({
            timestamp: value.record.announcementTimestamp!,
            announcement: { announcementId: `benchmark-report-v2:${input.draftId}:${recordSha256}`, action: "available", record: { kind: value.record.kind, digest: value.record.digest, mediaType: value.record.mediaType } },
            record: { bytes: value.record.bytes, contentType: value.record.mediaType },
          }); } },
        });
      });
      await probeRecord(publicBaseUrl, recordSha256, produced.envelope, "signed Report v2");
      const receipt = await receiptFor(source, recordSha256);
      await deps.afterAppendBeforeCheckpoint?.();
      const latest = requireRunState(context.workspaceDir, input.draftId);
      writeRunState(context.workspaceDir, input.draftId, {
        ...latest,
        reportPayloadSha256: payloadSha256,
        reportRecordSha256: recordSha256,
        publication: { ...latest.publication!, report: {
          ...latest.publication!.report,
          state: "complete",
          announcedAt: latest.publication!.report.announcedAt ?? stageAt,
          receipt: { sourceSequence: receipt.sequence, entrySha256: receipt.entryDigest.slice(7) },
          digests: { payload: payloadSha256, record: recordSha256 },
        } },
      });
      return { reportPayloadSha256: payloadSha256, reportRecordSha256: recordSha256, source: source.source,
        receipt: { sourceSequence: receipt.sequence, entrySha256: receipt.entryDigest.slice(7) }, preregistered: produced.record.preregistered ?? false };
    } finally { lock.release(); }
  } });
}
