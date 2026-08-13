/**
 * Product-owned direct Harbor venue. It never shells out: each command is an argv vector, and
 * the runner is injectable so conformance tests can use a fake Harbor executable.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkAccountingDispatch, DigestBearingResourceDescriptor } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { assertSupportedHarborVersion, harborSelectionManifestBytes, type HarborSelectionManifest } from "./manifest.js";

export const HARBOR_SELECTION_ROLE = "https://harborframework.com/artifact-roles/selection-manifest/v1";
export const HARBOR_CORRELATION_ROLE = "https://harborframework.com/artifact-roles/job-trial-correlation/v1";
export const HARBOR_JOB_CONFIG_ROLE = "https://harborframework.com/artifact-roles/job-config/v1";
export const HARBOR_JOB_RESULT_ROLE = "https://harborframework.com/artifact-roles/job-result/v1";
export const HARBOR_TRIAL_CONFIG_ROLE = "https://harborframework.com/artifact-roles/trial-config/v1";
export const HARBOR_TRIAL_RESULT_ROLE = "https://harborframework.com/artifact-roles/trial-result/v1";
export const HARBOR_REWARD_ROLE = "https://harborframework.com/artifact-roles/reward/v1";
export const HARBOR_ATIF_ROLE = "https://harborframework.com/artifact-roles/atif-trajectory/v1";
export const HARBOR_CTRF_ROLE = "https://harborframework.com/artifact-roles/ctrf/v1";
export const HARBOR_LOGS_ROLE = "https://harborframework.com/artifact-roles/logs/v1";
export const HARBOR_ARTIFACT_MANIFEST_ROLE = "https://harborframework.com/artifact-roles/artifact-manifest/v1";
export const HARBOR_COLLECTED_ARTIFACTS_ROLE = "https://harborframework.com/artifact-roles/collected-artifacts/v1";

export interface HarborCommandRunner {
  run(command: string, args: readonly string[], input?: Uint8Array, signal?: AbortSignal): Promise<{ readonly code: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array }>;
}

export const processHarborCommandRunner: HarborCommandRunner = {
  async run(command, args, input, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], signal, env: { PATH: process.env.PATH ?? "" } });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      child.stdin.end(input);
    });
  },
};

const Base64ArtifactSchema = z.object({ role: z.string().url(), name: z.string().min(1), mediaType: z.string().min(1), base64: z.string() }).strict();
const HarborRunOutputSchema = z.object({
  job: z.object({ id: z.string().min(1), config: Base64ArtifactSchema, result: Base64ArtifactSchema }).strict(),
  trial: z.object({ id: z.string().min(1), config: Base64ArtifactSchema, result: Base64ArtifactSchema }).strict(),
  reward: Base64ArtifactSchema,
  atif: Base64ArtifactSchema.optional(), ctrf: Base64ArtifactSchema.optional(), logs: Base64ArtifactSchema.optional(),
  artifactManifest: Base64ArtifactSchema.optional(), artifacts: Base64ArtifactSchema.optional(),
  collectionFailures: z.array(z.object({ role: z.string().url(), reason: z.string().min(1) }).strict()).default([]),
}).strict();

export interface HarborDispatchLineage {
  readonly jinnManaged: true;
  readonly submissionSha256: string;
  readonly attemptUri: string;
  readonly runSha256: string;
  readonly cellKey: string;
  readonly dispatchIndex: number;
}

export interface HarborArchivedArtifact {
  readonly role: string;
  readonly availability: "public" | "digest-only" | "source-absent" | "collection-failed";
  readonly artifact?: DigestBearingResourceDescriptor;
  readonly reason?: string;
}
export interface HarborDispatchArchive {
  readonly selectionManifestSha256: string;
  readonly correlation: DigestBearingResourceDescriptor;
  readonly nativeArtifacts: readonly HarborArchivedArtifact[];
  readonly jobId: string;
  readonly trialId: string;
}

function descriptor(name: string, mediaType: string, bytes: Uint8Array): DigestBearingResourceDescriptor {
  return { name, mediaType, digest: { sha256: sha256Hex(bytes) } };
}
function decode(artifact: z.infer<typeof Base64ArtifactSchema>): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(artifact.base64, "base64"));
  if (Buffer.from(bytes).toString("base64").replace(/=+$/u, "") !== artifact.base64.replace(/=+$/u, "")) throw new TypeError(`Harbor artifact ${artifact.name} has invalid base64 bytes`);
  return bytes;
}

function archiveArtifact(workspaceDir: string, artifact: z.infer<typeof Base64ArtifactSchema>, expectedRole?: string): HarborArchivedArtifact {
  if (expectedRole !== undefined && artifact.role !== expectedRole) throw new TypeError(`Harbor artifact ${artifact.name} must use role ${expectedRole}`);
  const bytes = decode(artifact);
  const digest = putSealedBytes(workspaceDir, bytes);
  return { role: artifact.role, availability: "public", artifact: { name: artifact.name, mediaType: artifact.mediaType, digest: { sha256: digest } } };
}

/** The direct mode intentionally owns one Job containing exactly one Trial. */
export class HarborDirectVenue {
  constructor(private readonly options: { readonly workspaceDir: string; readonly executable: string; readonly runner?: HarborCommandRunner }) {}

  async dispatch(input: { readonly manifest: HarborSelectionManifest; readonly lineage: HarborDispatchLineage; readonly deliver: (archive: HarborDispatchArchive) => Promise<void>; readonly signal?: AbortSignal }): Promise<HarborDispatchArchive> {
    if (input.lineage.jinnManaged !== true || !input.lineage.attemptUri || !input.lineage.submissionSha256) {
      throw new TypeError("refuses arbitrary historical Harbor jobs: contemporaneous Jinn Submission and Attempt lineage is required");
    }
    if (!Number.isInteger(input.lineage.dispatchIndex) || input.lineage.dispatchIndex < 1) throw new TypeError("Harbor dispatch index must be a positive integer");
    const runner = this.options.runner ?? processHarborCommandRunner;
    const version = await runner.run(this.options.executable, ["--version"], undefined, input.signal);
    if (version.code !== 0) throw new Error("Harbor version probe failed");
    const actualVersion = new TextDecoder().decode(version.stdout).trim().replace(/^harbor\s+/iu, "");
    assertSupportedHarborVersion(actualVersion);
    assertSupportedHarborVersion(input.manifest.harbor.version);
    const selectionBytes = harborSelectionManifestBytes(input.manifest);
    const selectionDigest = putSealedBytes(this.options.workspaceDir, selectionBytes);
    if (selectionDigest !== sha256Hex(selectionBytes)) throw new Error("selection archive digest changed while storing");
    const staging = await mkdtemp(join(tmpdir(), "jinn-harbor-job-"));
    try {
      const configPath = join(staging, "job.json");
      // The config carries the immutable selection plus the only allowed retry/concurrency values.
      await writeFile(configPath, canonicalJsonBytes({ selection: input.manifest, retryPolicy: input.manifest.retryPolicy } as never));
      const run = await runner.run(this.options.executable, ["jobs", "run", "--config", configPath, "--n-attempts", "1", "--n-concurrent", "1", "--max-retries", "0", "--json"], undefined, input.signal);
      if (run.code !== 0) throw new Error(`Harbor job failed (${run.code})`);
      const output = HarborRunOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(run.stdout)));
      const nativeArtifacts = [
        archiveArtifact(this.options.workspaceDir, output.job.config, HARBOR_JOB_CONFIG_ROLE),
        archiveArtifact(this.options.workspaceDir, output.job.result, HARBOR_JOB_RESULT_ROLE),
        archiveArtifact(this.options.workspaceDir, output.trial.config, HARBOR_TRIAL_CONFIG_ROLE),
        archiveArtifact(this.options.workspaceDir, output.trial.result, HARBOR_TRIAL_RESULT_ROLE),
        archiveArtifact(this.options.workspaceDir, output.reward, HARBOR_REWARD_ROLE),
      ];
      for (const [artifact, role] of [[output.atif, HARBOR_ATIF_ROLE], [output.ctrf, HARBOR_CTRF_ROLE], [output.logs, HARBOR_LOGS_ROLE], [output.artifactManifest, HARBOR_ARTIFACT_MANIFEST_ROLE], [output.artifacts, HARBOR_COLLECTED_ARTIFACTS_ROLE]] as const) {
        if (artifact !== undefined) nativeArtifacts.push(archiveArtifact(this.options.workspaceDir, artifact, role));
      }
      for (const failure of output.collectionFailures) {
        if (!HARBOR_ALLOWED_COLLECTION_FAILURE_ROLES.has(failure.role)) throw new TypeError(`unrecognised Harbor collection failure role ${failure.role}`);
        nativeArtifacts.push({ role: failure.role, availability: "collection-failed", reason: failure.reason });
      }
      const correlationBytes = canonicalJsonBytes({
        schema: "jinn.network/benchmark-product/harbor-correlation/1", lineage: input.lineage,
        harbor: { jobId: output.job.id, trialId: output.trial.id }, selectionManifestSha256: selectionDigest,
      } as never);
      const correlationDigest = putSealedBytes(this.options.workspaceDir, correlationBytes);
      const archive: HarborDispatchArchive = {
        selectionManifestSha256: selectionDigest,
        correlation: descriptor("harbor-correlation.json", "application/json", correlationBytes),
        nativeArtifacts, jobId: output.job.id, trialId: output.trial.id,
      };
      // No terminal Delivery may become visible before every captured byte is sealed in product CAS.
      await input.deliver(archive);
      return archive;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

/** Post-hoc publication reads captured CAS only; it has no runner or executable dependency. */
export function readHarborArchiveOnly(workspaceDir: string, archive: HarborDispatchArchive): Uint8Array[] {
  const values = [getSealedBytes(workspaceDir, archive.selectionManifestSha256), getSealedBytes(workspaceDir, archive.correlation.digest.sha256)];
  for (const item of archive.nativeArtifacts) if (item.artifact !== undefined) values.push(getSealedBytes(workspaceDir, item.artifact.digest.sha256));
  return values;
}

const HARBOR_ALLOWED_COLLECTION_FAILURE_ROLES = new Set([
  HARBOR_ATIF_ROLE, HARBOR_CTRF_ROLE, HARBOR_LOGS_ROLE, HARBOR_ARTIFACT_MANIFEST_ROLE, HARBOR_COLLECTED_ARTIFACTS_ROLE,
]);

/** Converts only archived CAS descriptors into the reusable runtime-contributor shape. */
export function harborEvidenceContribution(workspaceDir: string, archive: HarborDispatchArchive): Pick<BenchmarkAccountingDispatch, "correlations" | "nativeArtifacts"> {
  // Read verifies the stored selection bytes before exposing its descriptor.
  getSealedBytes(workspaceDir, archive.selectionManifestSha256);
  return {
    correlations: [
      { role: HARBOR_SELECTION_ROLE, artifact: { name: "harbor-selection-manifest.json", mediaType: "application/json", digest: { sha256: archive.selectionManifestSha256 } } },
      { role: HARBOR_CORRELATION_ROLE, artifact: archive.correlation },
    ],
    nativeArtifacts: [...archive.nativeArtifacts] as BenchmarkAccountingDispatch["nativeArtifacts"],
  };
}
