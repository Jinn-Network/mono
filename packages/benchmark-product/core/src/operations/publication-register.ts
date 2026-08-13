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
import {
  executePublicationPlan,
  sha256,
  type OriginVerificationPort,
  type PublicationArtifact,
  type PublicationPlan,
  type PublicationRecord,
} from "@jinn-network/record-publication";
import { TASK_MEDIA_TYPE, TaskSpecificationSchema, sealTask, type TaskSpecification } from "@jinn-network/task-execution-protocol";
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  TASK_PROFILE_MEDIA_TYPE,
  parseEvaluationSpec,
  parseTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { refuse } from "../errors.js";
import { runtimeRegistrationPublicationClosure } from "../runtime/adapter.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import {
  createWorkspacePublicationJournal,
  createWorkspacePublicationSource,
  normalizePublicArchiveBaseUrl,
  publicArchiveUrl,
  recordPath,
  withWorkspacePublicationSourceLock,
} from "../run/publication-source.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import {
  WORKSPACE_AUTHORSHIP_ROLE,
  readPublicationOrigin,
  requireWorkspaceAuthorship,
} from "../run/publication-authority.js";
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

export interface PublicationRegisterDeps {
  /** Required for every foreign Task/Benchmark carrying durable origin coordinates. */
  readonly verifyOrigin?: OriginVerificationPort;
  /** Test-only crash seam after the completed registration plan is publicly probed, before its RunState checkpoint. */
  readonly afterPlanBeforeCheckpoint?: () => Promise<void>;
}

async function probeExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  let response: Response;
  try { response = await fetch(publicArchiveUrl(base, recordPath(digest))); } catch (cause) {
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
  const response = await fetch(publicArchiveUrl(base, path));
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

function originRecord(
  id: string,
  kind: string,
  digestHex: string,
  bytes: Uint8Array,
  mediaType: string,
  origin: NonNullable<PublicationRecord["authority"]["origin"]>,
  dependsOn: readonly string[] = [],
): PublicationRecord {
  return {
    id, kind, digest: `sha256:${digestHex}`, bytes, mediaType,
    authority: { mode: "origin-reference", origin }, actions: ["verify-origin", "mirror"], dependsOn,
  };
}

interface ExactTaskDependency {
  readonly digestHex: string;
  readonly role: string;
  readonly mediaType: string;
  readonly prefix: string;
}

/** Explicit Task schema descriptors only; no generic digest-shaped-object inference. */
export function taskDependencies(task: TaskSpecification): ExactTaskDependency[] {
  const output: ExactTaskDependency[] = [];
  const push = (descriptor: unknown, role: string, mediaType: string, prefix: string, required = false) => {
    if (descriptor === undefined) return;
    const digestHex = ((descriptor as { digest?: { sha256?: unknown } } | undefined)?.digest?.sha256);
    if (typeof digestHex !== "string" || !/^[a-f0-9]{64}$/.test(digestHex)) {
      if (required) refuse("record-integrity", `registration.task.${prefix}`, `${prefix} descriptor must carry an exact local sha256 digest; URI-only dependencies cannot be registered`);
      return;
    }
    output.push({ digestHex, role, mediaType, prefix });
  };
  push(task.profile, RECORD_KINDS.profileDocument, TASK_PROFILE_MEDIA_TYPE, "profile", true);
  push(task.evaluation, RECORD_KINDS.evaluationSpec, EVALUATION_SPEC_MEDIA_TYPE, "evaluation", true);
  for (const input of Array.isArray(task.inputs) ? task.inputs : []) {
    push(input, "https://spec.jinn.network/artifacts/task-input/v1", (input as { mediaType?: string }).mediaType ?? "application/octet-stream", "input", true);
  }
  push(task.supersedes, RECORD_KINDS.task, TASK_MEDIA_TYPE, "superseded-task", true);
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
  const authorityDependencies = (
    recordId: string,
    recordKind: string,
    digestHex: string,
    author: string | undefined,
    dependencies: readonly string[],
  ): { owned: true; dependencies: readonly string[] } | { owned: false; origin: NonNullable<PublicationRecord["authority"]["origin"]>; dependencies: readonly string[] } => {
    if (author === run.owner) {
      let proof;
      try {
        proof = requireWorkspaceAuthorship({ workspaceDir, recordSha256: digestHex, recordKind, author });
      } catch (cause) {
        refuse("record-integrity", `registration.${recordId}.authorship`, cause instanceof Error ? cause.message : String(cause));
      }
      const proofId = `authorship:${digestHex}`;
      add(artifact(proofId, WORKSPACE_AUTHORSHIP_ROLE, proof.digestHex, proof.bytes, proof.mediaType));
      return { owned: true, dependencies: [...dependencies, proofId].sort() };
    }
    const origin = readPublicationOrigin(workspaceDir, `sha256:${digestHex}`);
    if (origin === undefined) {
      refuse(
        "record-integrity",
        `registration.${recordId}.origin`,
        "authorless or foreign record has no durable validated origin source position; refusing source-absent dependency",
      );
    }
    return { owned: false, origin, dependencies: [...dependencies].sort() };
  };
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
    const taskAuthority = authorityDependencies(taskId, RECORD_KINDS.task, taskSha256, task.author, dependencyIds);
    add(taskAuthority.owned
      ? ownedRecord(taskId, RECORD_KINDS.task, taskSha256, taskBytes, TASK_MEDIA_TYPE, at, taskAuthority.dependencies)
      : originRecord(taskId, RECORD_KINDS.task, taskSha256, taskBytes, TASK_MEDIA_TYPE, taskAuthority.origin, taskAuthority.dependencies));
    taskIds.push(taskId);
  }
  const extension = readRunPublicationExtension(run as unknown as Record<string, unknown>);
  const runtimeClosure = runtimeRegistrationPublicationClosure(workspaceDir, extension?.registrationArtifacts ?? []);
  for (const entry of runtimeClosure.artifacts) add(artifact(
    entry.id, entry.role, entry.digestHex, entry.bytes, entry.mediaType, entry.dependsOn,
  ));
  const runtimeIds = runtimeClosure.rootIds;
  const benchmarkId = `benchmark:${benchmarkSha256}`;
  const benchmarkAuthority = authorityDependencies(
    benchmarkId,
    BENCHMARK_RECORD_KIND,
    benchmarkSha256,
    benchmark.author,
    [...taskIds, ...runtimeIds],
  );
  add(benchmarkAuthority.owned
    ? ownedRecord(benchmarkId, BENCHMARK_RECORD_KIND, benchmarkSha256, benchmarkBytes, BENCHMARK_MEDIA_TYPE, at, benchmarkAuthority.dependencies)
    : originRecord(benchmarkId, BENCHMARK_RECORD_KIND, benchmarkSha256, benchmarkBytes, BENCHMARK_MEDIA_TYPE, benchmarkAuthority.origin, benchmarkAuthority.dependencies));
  let runProof;
  try {
    runProof = requireWorkspaceAuthorship({
      workspaceDir,
      recordSha256: runSha256,
      recordKind: RUN_RECORD_KIND,
      author: run.owner,
    });
  } catch (cause) {
    refuse("record-integrity", "registration.run.authorship", cause instanceof Error ? cause.message : String(cause));
  }
  const runProofId = `authorship:${runSha256}`;
  add(artifact(runProofId, WORKSPACE_AUTHORSHIP_ROLE, runProof.digestHex, runProof.bytes, runProof.mediaType));
  members.push(ownedRecord("run", RUN_RECORD_KIND, runSha256, runBytes, RUN_MEDIA_TYPE, at, [benchmarkId, runProofId].sort()));
  // Record Discovery requires strictly advancing head timestamps. Derive stable millisecond
  // offsets from the DAG's actual record order while retaining `at` as the one frozen stage time.
  const announcementOrder = members
    .filter((member): member is PublicationRecord => "kind" in member && member.actions.includes("announce"))
    .map((member) => member.id)
    .sort((left, right) => {
      const rank = (id: string) => id === "run" ? 2 : id.startsWith("benchmark:") ? 1 : 0;
      return rank(left) - rank(right) || left.localeCompare(right);
    });
  const rankById = new Map(announcementOrder.map((id, index) => [id, index]));
  const baseTime = Date.parse(at);
  return members.map((member) => {
    const rank = rankById.get(member.id);
    return rank === undefined || !("kind" in member)
      ? member
      : { ...member, announcementTimestamp: new Date(baseTime + rank).toISOString() };
  });
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
      let normalized: string;
      try { normalized = normalizePublicArchiveBaseUrl(input.publicBaseUrl); } catch (cause) {
        refuse("validation", "publicBaseUrl", cause instanceof Error ? cause.message : "invalid public archive base URL");
      }
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.publication === undefined) refuse("conflict", `runs.${input.draftId}`, "run has no prospective publication state");
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        publication: {
          ...state.publication,
          // Configuring before execution is explicit public-before-run intent. A closed run stays
          // local and may be registered truthfully as post-hoc.
          mode: state.closedAt === undefined && state.launchedAt === undefined ? "prospective" : (state.publication.mode ?? "local"),
          source: { ...state.publication.source, publicBaseUrl: normalized },
        },
      });
      return { publicBaseUrl: normalized };
      } finally {
        operationLock.release();
      }
    },
  });
}

export function publicationRegister(
  context: OperationContext,
  input: PublicationRegisterInput,
  deps: PublicationRegisterDeps = {},
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
        let configured: string;
        try { configured = normalizePublicArchiveBaseUrl(input.publicBaseUrl); } catch (cause) {
          refuse("validation", "publicBaseUrl", cause instanceof Error ? cause.message : "invalid public archive base URL");
        }
        publication = { ...publication, source: { ...publication.source, publicBaseUrl: configured } };
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
      if (members.some((member) => "kind" in member && member.authority.mode === "origin-reference") && deps.verifyOrigin === undefined) {
        refuse("record-integrity", `runs.${input.draftId}.publication.origin`, "foreign registration dependencies require an injected exact origin verifier");
      }
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
            let declaredAuthor: string;
            if (record.kind === RUN_RECORD_KIND) declaredAuthor = parseRun(record.bytes).owner;
            else if (record.kind === BENCHMARK_RECORD_KIND) declaredAuthor = parseBenchmark(record.bytes).author ?? "";
            else if (record.kind === RECORD_KINDS.task) declaredAuthor = parseExactTask(record.bytes).author ?? "";
            else throw new Error(`unsupported owned registration record kind ${record.kind}`);
            if (declaredAuthor !== source.source.agent) throw new Error("announced record author/owner does not equal the source did:key");
            requireWorkspaceAuthorship({
              workspaceDir: context.workspaceDir,
              recordSha256: record.digest.slice(7),
              recordKind: record.kind,
              author: declaredAuthor,
            });
          } },
          ...(deps.verifyOrigin === undefined ? {} : { verifyOrigin: deps.verifyOrigin }),
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
        if ("kind" in member && member.actions.includes("announce")) await probeExact(base, member.digest, member.bytes);
        else await probeArtifactExact(base, member.digest, member.bytes);
      }
      // The neutral plan and every exact-byte probe have succeeded at this point, while the
      // durable product checkpoint has not.  Retrying must replay the frozen plan and recover
      // this very Run receipt from the source writer, not append a second registration chain.
      await deps.afterPlanBeforeCheckpoint?.();
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
