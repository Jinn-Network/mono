import type { BenchmarkAccountingDispatch, DigestBearingResourceDescriptor } from "@jinn-network/benchmarking-records";
import { join } from "node:path";
import { z } from "zod";
import { artifactsDir } from "../../workspace/layout.js";
import { readFileIfExistsSync } from "../../fs/atomic.js";
import { getSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";

export const HARBOR_SELECTION_ROLE = "https://harborframework.com/artifact-roles/selection-manifest/v1";
export const HARBOR_CORRELATION_ROLE = "https://harborframework.com/artifact-roles/job-trial-correlation/v1";
export const HARBOR_JOB_CONFIG_ROLE = "https://harborframework.com/artifact-roles/job-config/v1";
export const HARBOR_INVOCATION_CONFIG_ROLE = "https://harborframework.com/artifact-roles/invocation-job-config/v1";
export const HARBOR_JOB_RESULT_ROLE = "https://harborframework.com/artifact-roles/job-result/v1";
export const HARBOR_TRIAL_CONFIG_ROLE = "https://harborframework.com/artifact-roles/trial-config/v1";
export const HARBOR_TRIAL_RESULT_ROLE = "https://harborframework.com/artifact-roles/trial-result/v1";
export const HARBOR_REWARD_ROLE = "https://harborframework.com/artifact-roles/reward/v1";
export const HARBOR_ATIF_ROLE = "https://harborframework.com/artifact-roles/atif-trajectory/v1";
export const HARBOR_CTRF_ROLE = "https://harborframework.com/artifact-roles/ctrf/v1";
export const HARBOR_LOGS_ROLE = "https://harborframework.com/artifact-roles/logs/v1";
export const HARBOR_ARTIFACT_MANIFEST_ROLE = "https://harborframework.com/artifact-roles/artifact-manifest/v1";
export const HARBOR_COLLECTED_ARTIFACTS_ROLE = "https://harborframework.com/artifact-roles/collected-artifacts/v1";
export const HARBOR_NATIVE_PATH_ROLE_PREFIX = "https://harborframework.com/artifact-roles/native-path/";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactSchema = z.object({
  role: z.string().url(), path: z.string().min(1), sha256: DigestSchema, bytes: z.number().int().nonnegative(),
  availability: z.enum(["public", "digest-only", "source-absent", "collection-failed"]).default("public"),
  reason: z.string().min(1).optional(),
}).strict();
export const HarborDispatchArchiveSchema = z.object({
  schema: z.literal("jinn.network/benchmark-product/harbor-dispatch-archive/2"),
  selectionManifestSha256: DigestSchema,
  lineage: z.object({ runSha256: DigestSchema, cellKey: z.string().min(1), dispatchIndex: z.number().int().positive(), submissionSha256: DigestSchema, attemptUri: z.string().min(1) }).strict(),
  harbor: z.object({ jobName: z.string().min(1), jobId: z.string().min(1).optional(), trialId: z.string().min(1).optional(), status: z.enum(["completed", "failed", "cancelled", "collection-failed"]) }).strict(),
  nativeArtifacts: z.array(ArtifactSchema),
}).strict();
export type HarborDispatchArchive = z.infer<typeof HarborDispatchArchiveSchema>;

const HarborArchiveIndexSchema = z.object({
  schema: z.literal("jinn.network/benchmark-product/harbor-archive-index/1"),
  runSha256: DigestSchema,
  cellKey: z.string().min(1),
  dispatchIndex: z.number().int().positive(),
  submissionSha256: DigestSchema,
  attemptUri: z.string().min(1),
  archiveSha256: DigestSchema,
}).strict();

/** Resolves only the immutable by-dispatch index written by the Harbor provisioner. */
export function readHarborDispatchArchiveFor(
  workspaceDir: string,
  input: { readonly runSha256: string; readonly cellKey: string; readonly dispatchIndex: number; readonly submissionSha256: string },
): { readonly archiveSha256: string; readonly archive: HarborDispatchArchive } {
  const identity = `${input.runSha256}:${input.cellKey}:${input.dispatchIndex}`;
  const path = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch", `${sha256Hex(new TextEncoder().encode(identity))}.json`);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) throw new Error(`Harbor dispatch archive index is missing for ${input.cellKey}/${input.dispatchIndex}`);
  const index = HarborArchiveIndexSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  if (index.runSha256 !== input.runSha256 || index.cellKey !== input.cellKey || index.dispatchIndex !== input.dispatchIndex || index.submissionSha256 !== input.submissionSha256) {
    throw new Error(`Harbor dispatch archive index does not bind ${input.cellKey}/${input.dispatchIndex}`);
  }
  const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
  if (archive.lineage.runSha256 !== input.runSha256 || archive.lineage.cellKey !== input.cellKey || archive.lineage.dispatchIndex !== input.dispatchIndex || archive.lineage.submissionSha256 !== input.submissionSha256 || archive.lineage.attemptUri !== index.attemptUri) {
    throw new Error(`Harbor dispatch archive lineage does not bind ${input.cellKey}/${input.dispatchIndex}`);
  }
  return { archiveSha256: index.archiveSha256, archive };
}

export function readHarborDispatchArchive(workspaceDir: string, digest: string): HarborDispatchArchive {
  return HarborDispatchArchiveSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, digest))));
}

/** Publication consumes only the product CAS archive; it can never rerun Harbor. */
export function harborEvidenceContributionFromArchive(workspaceDir: string, archiveSha256: string): Pick<BenchmarkAccountingDispatch, "correlations" | "nativeArtifacts"> {
  const archive = readHarborDispatchArchive(workspaceDir, archiveSha256);
  getSealedBytes(workspaceDir, archive.selectionManifestSha256);
  for (const item of archive.nativeArtifacts) if (item.availability === "public" || item.availability === "digest-only") getSealedBytes(workspaceDir, item.sha256);
  const archiveArtifact: DigestBearingResourceDescriptor = { name: "harbor-correlation-and-native-archive.json", mediaType: "application/json", digest: { sha256: archiveSha256 } };
  return {
    correlations: [
      { role: HARBOR_SELECTION_ROLE, artifact: { name: "harbor-selection-manifest.json", mediaType: "application/json", digest: { sha256: archive.selectionManifestSha256 } } },
      { role: HARBOR_CORRELATION_ROLE, artifact: archiveArtifact },
    ],
    nativeArtifacts: archive.nativeArtifacts.map((item) => ({
      role: item.role,
      availability: item.availability,
      ...(item.availability === "public" || item.availability === "digest-only" ? { artifact: { name: item.path, mediaType: item.path.endsWith(".json") ? "application/json" : "application/octet-stream", digest: { sha256: item.sha256 } } } : {}),
      ...(item.availability === "public" ? {} : { reason: item.reason ?? `Harbor declared ${item.path} ${item.availability}` }),
    })) as BenchmarkAccountingDispatch["nativeArtifacts"],
  };
}
