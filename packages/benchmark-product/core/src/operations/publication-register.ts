/** Prospective/public-after-the-fact Run registration through the neutral publication executor. */

import {
  BENCHMARK_MEDIA_TYPE,
  BENCHMARK_RECORD_KIND,
  RUN_MEDIA_TYPE,
  RUN_RECORD_KIND,
  itemTaskDigest,
  parseBenchmark,
  parseRun,
  readRunPublicationExtension,
} from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { createDiscoverySourceAnnouncementPort } from "@jinn-network/record-publication";
import { executePublicationPlan, sha256, type PublicationArtifact, type PublicationPlan, type PublicationRecord } from "@jinn-network/record-publication";
import { TASK_MEDIA_TYPE, TaskSpecificationSchema, sealTask, type TaskSpecification } from "@jinn-network/task-execution-protocol";
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  TASK_PROFILE_MEDIA_TYPE,
  parseEvaluationSpec,
  parseTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { refuse } from "../errors.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import {
  createWorkspacePublicationJournal,
  createWorkspacePublicationSource,
  recordPath,
  withWorkspacePublicationSourceLock,
} from "../run/publication-source.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import { requireRunState, writeRunState } from "../run/state.js";
import type { OperationContext } from "./context.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface PublicationConfigureInput {
  readonly draftId: string;
  readonly publicBaseUrl: string;
}

export interface PublicationRegisterInput {
  readonly draftId: string;
  /** Location only. Replacing it never changes the source's did:key/name identity. */
  readonly publicBaseUrl?: string;
}

export interface PublicationRegistrationResult {
  readonly source: { readonly agent: string; readonly name: string };
  readonly postHoc: boolean;
  readonly sourceSequence: string;
  readonly recordSha256: string;
}

function publicUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function probeExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  let response: Response;
  try { response = await fetch(publicUrl(base, recordPath(digest))); } catch (cause) {
    throw new Error(`public record probe failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw new Error(`public record probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (sha256(observed) !== digest || observed.length !== bytes.length || !observed.every((byte, index) => byte === bytes[index])) {
    throw new Error("public record probe did not return the exact announced bytes");
  }
}

async function probeArtifactExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  const path = `/publication-artifacts/sha256/${digest.slice(7)}`;
  const response = await fetch(publicUrl(base, path));
  if (!response.ok) throw new Error(`public artifact probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (sha256(observed) !== digest || observed.length !== bytes.length || !observed.every((byte, index) => byte === bytes[index])) {
    throw new Error("public artifact probe did not return the exact stored bytes");
  }
}

function artifact(id: string, role: string, digestHex: string, bytes: Uint8Array, mediaType: string, dependsOn: readonly string[] = []): PublicationArtifact {
  return { id, role, digest: `sha256:${digestHex}`, bytes, mediaType, actions: ["store"], dependsOn };
}

function ownedRecord(
  id: string,
  kind: string,
  digestHex: string,
  bytes: Uint8Array,
  mediaType: string,
  at: string,
  dependsOn: readonly string[] = [],
): PublicationRecord {
  return {
    id, kind, digest: `sha256:${digestHex}`, bytes, mediaType,
    authority: { mode: "owner" }, actions: ["store", "announce"],
    announcementTimestamp: at, dependsOn,
  };
}

interface ExactTaskDependency {
  readonly digestHex: string;
  readonly role: string;
  readonly mediaType: string;
  readonly prefix: string;
}

/** Explicit Task schema descriptors only; no generic digest-shaped-object inference. */
function taskDependencies(task: TaskSpecification): ExactTaskDependency[] {
  const output: ExactTaskDependency[] = [];
  const push = (descriptor: unknown, role: string, mediaType: string, prefix: string) => {
    const digestHex = ((descriptor as { digest?: { sha256?: unknown } } | undefined)?.digest?.sha256);
    if (typeof digestHex === "string" && /^[a-f0-9]{64}$/.test(digestHex)) output.push({ digestHex, role, mediaType, prefix });
  };
  push(task.profile, RECORD_KINDS.profileDocument, TASK_PROFILE_MEDIA_TYPE, "profile");
  push(task.evaluation, RECORD_KINDS.evaluationSpec, EVALUATION_SPEC_MEDIA_TYPE, "evaluation");
  for (const input of Array.isArray(task.inputs) ? task.inputs : []) {
    push(input, "https://spec.jinn.network/artifacts/task-input/v1", (input as { mediaType?: string }).mediaType ?? "application/octet-stream", "input");
  }
  push(task.supersedes, RECORD_KINDS.task, TASK_MEDIA_TYPE, "superseded-task");
  for (const outputSlot of Array.isArray(task.outputs) ? task.outputs : []) {
    push((outputSlot as { schema?: unknown }).schema, "https://spec.jinn.network/artifacts/output-schema/v1", "application/schema+json", "output-schema");
  }
  return output;
}

function parseExactTask(bytes: Uint8Array): TaskSpecification {
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const task = TaskSpecificationSchema.parse(decoded);
  const canonical = sealTask(task);
  if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new Error("Task bytes are valid structurally but are not the exact canonical Task encoding");
  }
  return task;
}

export function buildRegistrationClosure(
  workspaceDir: string,
  runBytes: Uint8Array,
  runSha256: string,
  at: string,
): PublicationPlan["stages"][number]["members"] {
  const run = parseRun(runBytes);
  const benchmarkSha256 = run.benchmark.digest.sha256;
  const benchmarkBytes = getSealedBytes(workspaceDir, benchmarkSha256);
  const benchmark = parseBenchmark(benchmarkBytes);
  const members: Array<PublicationArtifact | PublicationRecord> = [];
  const ids = new Set<string>();
  const add = (member: PublicationArtifact | PublicationRecord) => { if (!ids.has(member.id)) { ids.add(member.id); members.push(member); } };
  const taskIds: string[] = [];
  for (const item of benchmark.items) {
    const taskSha256 = itemTaskDigest(item);
    const taskBytes = getSealedBytes(workspaceDir, taskSha256);
    const task = parseExactTask(taskBytes);
    const dependencyIds: string[] = [];
    for (const dependency of taskDependencies(task)) {
      const { digestHex } = dependency;
      let bytes: Uint8Array;
      try { bytes = getSealedBytes(workspaceDir, digestHex); } catch {
        refuse("record-integrity", `registration.${taskSha256}.${digestHex}`, "profile-required Task material is missing from the sealed workspace");
      }
      if (dependency.prefix === "profile") parseTaskProfile(bytes);
      if (dependency.prefix === "evaluation") parseEvaluationSpec(bytes);
      const id = `${dependency.prefix}:${digestHex}`;
      add(artifact(id, dependency.role, digestHex, bytes, dependency.mediaType));
      dependencyIds.push(id);
    }
    const taskId = `task:${taskSha256}`;
    add(task.author === run.owner
      ? ownedRecord(taskId, RECORD_KINDS.task, taskSha256, taskBytes, TASK_MEDIA_TYPE, at, dependencyIds.sort())
      : artifact(taskId, RECORD_KINDS.task, taskSha256, taskBytes, TASK_MEDIA_TYPE, dependencyIds.sort()));
    taskIds.push(taskId);
  }
  const extension = readRunPublicationExtension(run as unknown as Record<string, unknown>);
  const runtimeIds: string[] = [];
  for (const entry of extension?.registrationArtifacts ?? []) {
    const digestHex = entry.artifact.digest.sha256;
    const id = `runtime:${entry.role}:${digestHex}`;
    add(artifact(id, entry.role, digestHex, getSealedBytes(workspaceDir, digestHex), entry.artifact.mediaType ?? "application/octet-stream"));
    runtimeIds.push(id);
  }
  const benchmarkId = `benchmark:${benchmarkSha256}`;
  add(benchmark.author === run.owner
    ? ownedRecord(benchmarkId, BENCHMARK_RECORD_KIND, benchmarkSha256, benchmarkBytes, BENCHMARK_MEDIA_TYPE, at, [...taskIds, ...runtimeIds].sort())
    : artifact(benchmarkId, BENCHMARK_RECORD_KIND, benchmarkSha256, benchmarkBytes, BENCHMARK_MEDIA_TYPE, [...taskIds, ...runtimeIds].sort()));
  members.push(ownedRecord("run", RUN_RECORD_KIND, runSha256, runBytes, RUN_MEDIA_TYPE, at, [benchmarkId]));
  return members;
}

/** Configure the mutable public locator independently of immutable source identity. */
export function publicationConfigure(
  context: OperationContext,
  input: PublicationConfigureInput,
): Promise<OperationResult<{ publicBaseUrl: string }>> {
  return operateAsync({
    context,
    action: "publication.configure",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const operationLock = await acquirePublicationLock(context.workspaceDir, input.draftId);
      try {
      const parsed = new URL(input.publicBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") refuse("validation", "publicBaseUrl", "publicBaseUrl must be http(s)");
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.publication === undefined) refuse("conflict", `runs.${input.draftId}`, "run has no prospective publication state");
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        publication: {
          ...state.publication,
          // Configuring before execution is explicit public-before-run intent. A closed run stays
          // local and may be registered truthfully as post-hoc.
          mode: state.closedAt === undefined && state.launchedAt === undefined ? "prospective" : (state.publication.mode ?? "local"),
          source: { ...state.publication.source, publicBaseUrl: parsed.toString().replace(/\/$/, "") },
        },
      });
      return { publicBaseUrl: parsed.toString().replace(/\/$/, "") };
      } finally {
        operationLock.release();
      }
    },
  });
}

export function publicationRegister(
  context: OperationContext,
  input: PublicationRegisterInput,
): Promise<OperationResult<PublicationRegistrationResult>> {
  return operateAsync({
    context,
    action: "publication.register",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const operationLock = await acquirePublicationLock(context.workspaceDir, input.draftId);
      try {
      let state = requireRunState(context.workspaceDir, input.draftId);
      if (state.publication === undefined || state.runSha256 === undefined || state.closeAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "lock the run before registering its exact public record");
      }
      const lockedRunSha256 = state.runSha256;
      let publication = state.publication;
      if (state.launchedAt !== undefined && state.closedAt === undefined) {
        refuse("conflict", `runs.${input.draftId}.publication`, "a running local run cannot be retroactively represented as public-before-dispatch");
      }
      if (input.publicBaseUrl !== undefined) {
        const configured = new URL(input.publicBaseUrl);
        publication = { ...publication, source: { ...publication.source, publicBaseUrl: configured.toString().replace(/\/$/, "") } };
        state = { ...state, publication };
        writeRunState(context.workspaceDir, input.draftId, state);
      }
      const base = publication.source.publicBaseUrl;
      if (base === undefined) refuse("validation", "publicBaseUrl", "configure a publicBaseUrl before registration so exact records can be retrieved");

      const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
      if (source.source.agent !== publication.source.agentKeyRef || state.owner !== source.source.agent) {
        refuse("conflict", "publication.source.agentKeyRef", "workspace signing key changed; source identity cannot be re-attributed");
      }
      const runBytes = getSealedBytes(context.workspaceDir, lockedRunSha256);

      const postHoc = state.closedAt !== undefined;
      const timestamp = publication.registration.announcedAt ?? context.clock();
      publication = { ...publication, mode: postHoc ? "local" : "prospective" };
      if (publication.registration.state === "not-started") {
        publication = { ...publication, registration: { ...publication.registration, state: "in-progress", announcedAt: timestamp, postHoc } };
        state = {
          ...state,
          publication,
        };
        writeRunState(context.workspaceDir, input.draftId, state);
      }
      const members = buildRegistrationClosure(context.workspaceDir, runBytes, lockedRunSha256, timestamp);
      const plan: PublicationPlan = {
        id: `benchmark-registration:${input.draftId}:${lockedRunSha256}`,
        stages: [{ stage: "registration", members }],
      };
      let receipt: { sequence: string; entryDigest: `sha256:${string}` } | undefined;
      const announcement = createDiscoverySourceAnnouncementPort({ writer: source.writer });
      await withWorkspacePublicationSourceLock(context.workspaceDir, async () => {
        await source.writer.recover();
        await executePublicationPlan(plan, {
          objects: source.artifactStore,
          journal: createWorkspacePublicationJournal(context.workspaceDir, input.draftId),
          authority: { async authorizeAnnouncement({ record }) {
            if (record.authority.mode !== "owner" || state.owner !== source.source.agent) {
              throw new Error("only records authored by this source did:key may be announced");
            }
          } },
          announce: { async announce(value) {
            const announced = await announcement.announce(value);
            const durable = announced as { sequence: string; entryDigest: `sha256:${string}` };
            receipt = durable;
            return durable;
          } },
        });
      });
      // A completed executor journal can be replayed without calling announce, so recover the
      // original receipt from the signed writer state on retry.
      if (receipt === undefined) {
        const durable = await source.writer.readState();
        const match = Object.values(durable?.announcements ?? {}).find((entry) => entry.receipt.record?.digest === `sha256:${lockedRunSha256}`);
        if (match === undefined) throw new Error("registration journal completed without a durable Run announcement receipt");
        receipt = { sequence: match.receipt.sequence, entryDigest: match.receipt.entryDigest };
      }
      for (const member of members) {
        if ("kind" in member) await probeExact(base, member.digest, member.bytes);
        else await probeArtifactExact(base, member.digest, member.bytes);
      }
      const digests = Object.fromEntries(members.map((member) => [member.id, member.digest.slice(7)]));
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        publication: {
          ...publication,
          registration: {
            state: "complete",
            receipt: { sourceSequence: receipt.sequence, entrySha256: receipt.entryDigest.slice("sha256:".length) },
            announcedAt: timestamp,
            postHoc,
            digests,
          },
        },
      });
      return { source: source.source, postHoc, sourceSequence: receipt.sequence, recordSha256: lockedRunSha256 };
      } finally {
        operationLock.release();
      }
    },
  });
}
