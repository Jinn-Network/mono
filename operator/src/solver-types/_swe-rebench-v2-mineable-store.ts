/**
 * Task-creator compatibility facade over harness-layer's canonical
 * ContributionStore. New jinn-layer and daemon callers therefore share one
 * cacheless schema, migration, lock, and atomic read-modify-write path.
 */
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ContributionCandidateV1ProjectionSchema,
  ContributionCandidateV1Schema,
  type ContributionCandidateV1,
} from '@jinn-network/plugin';
import {
  CONTRIBUTION_STORE_SCHEMA_VERSION,
  ContributionStore,
  createEvidenceAdapter,
  resolveContributionStateDir,
  type ContributionStoreRecord,
} from '@jinn-network/core';
import type {
  MineableSkillEvent,
  MineableTestRun,
  MineableTraceRecord,
  MineableTraceStorePort,
  StoredMineableTraceRecord,
} from './_swe-rebench-v2-mineable-store-port.js';

export type {
  MineableSkillEvent,
  MineableTestRun,
  MineableTraceRecord,
  MineableTraceStorePort,
  StoredMineableTraceRecord,
} from './_swe-rebench-v2-mineable-store-port.js';

export const MINEABLE_TRACE_STORE_SCHEMA_VERSION = CONTRIBUTION_STORE_SCHEMA_VERSION;
export const resolveMineableStateDir = resolveContributionStateDir;

function defaultEpisodesDir(): string {
  return process.env['JINN_LAYER_EPISODES_DIR']
    ?? join(homedir(), '.jinn-client', 'harness-layer', 'episodes');
}

function toCandidate(record: MineableTraceRecord): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId: record.sourceId,
    repositorySlug: record.repo,
    baseCommit: record.baseCommit,
    acceptedDiff: record.acceptedDiff,
    testRuns: record.testRuns.map((run) => ({
      command: run.cmd,
      exitCode: run.exitCode,
      at: run.at,
    })),
    intermediateFailureDiffs: record.intermediateFailureDiffs,
    skillEvents: record.skillEvents.map((event) => ({
      skillRef: event.skill,
      action: event.action,
    })),
    publishMinedTasksConsent: record.publishMinedTasksConsent,
    createdAt: record.createdAt,
  };
}

export function mineableTraceRecordFromStored(record: StoredMineableTraceRecord): MineableTraceRecord {
  const candidate = record.candidate;
  return {
    sourceId: candidate.sourceId,
    kind: record.localMetadata?.kind ?? 'harness-session',
    repo: candidate.repositorySlug,
    baseCommit: candidate.baseCommit,
    acceptedDiff: candidate.acceptedDiff,
    testRuns: candidate.testRuns.map((run) => ({
      cmd: run.command,
      exitCode: run.exitCode,
      at: run.at,
    })),
    intermediateFailureDiffs: candidate.intermediateFailureDiffs,
    skillEvents: candidate.skillEvents.map((event) => ({
      skill: event.skillRef,
      action: event.action,
    })),
    ...(record.localMetadata?.sourceInstanceId
      ? { sourceInstanceId: record.localMetadata.sourceInstanceId }
      : {}),
    publishMinedTasksConsent: candidate.publishMinedTasksConsent,
    createdAt: candidate.createdAt,
  };
}

export function buildMineableRecord(ctx: {
  sourceId: string;
  kind: MineableTraceRecord['kind'];
  repo: string;
  baseCommit: string;
  acceptedDiff: string;
  testRuns?: MineableTestRun[];
  intermediateFailureDiffs?: string[];
  skillEvents?: MineableSkillEvent[];
  sourceInstanceId?: string;
  publishMinedTasksConsent: boolean;
  now: () => string;
}): MineableTraceRecord {
  return {
    sourceId: ctx.sourceId,
    kind: ctx.kind,
    repo: ctx.repo,
    baseCommit: ctx.baseCommit,
    acceptedDiff: ctx.acceptedDiff,
    testRuns: ctx.testRuns ?? [],
    intermediateFailureDiffs: ctx.intermediateFailureDiffs ?? [],
    skillEvents: ctx.skillEvents ?? [],
    ...(ctx.sourceInstanceId !== undefined ? { sourceInstanceId: ctx.sourceInstanceId } : {}),
    publishMinedTasksConsent: ctx.publishMinedTasksConsent,
    createdAt: ctx.now(),
  };
}

/**
 * Safe read of harness-emitted failed diffs for §10 field 4 assemblers (#1643).
 * Source column is written at RUNNING → POST_SNAPSHOT from
 * Solution.intermediateFailureDiffs — not from solution overwrite archaeology.
 * Returns [] for null, empty, malformed, or non-array JSON.
 */
export function intermediateFailureDiffsFromTaskRun(run: {
  intermediateFailureDiffsJson: string | null;
}): string[] {
  if (run.intermediateFailureDiffsJson == null || run.intermediateFailureDiffsJson === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(run.intermediateFailureDiffsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

export class MineableTraceStore implements MineableTraceStorePort {
  private readonly store: ContributionStore;
  private readonly evidence: ReturnType<typeof createEvidenceAdapter>;

  constructor(options: { stateDir: string; episodesDir?: string }) {
    this.store = new ContributionStore({ stateDir: options.stateDir });
    this.evidence = createEvidenceAdapter({
      capturesDir: options.episodesDir ?? defaultEpisodesDir(),
    });
  }

  async append(record: MineableTraceRecord): Promise<void> {
    const candidate = ContributionCandidateV1Schema.parse(toCandidate(record));
    const evidence = await this.evidence.get(record.sourceId);
    const episode = evidence.status === 'ok' ? evidence.value : undefined;
    const canonicalCandidate = episode
      ? ContributionCandidateV1ProjectionSchema.safeParse(episode.contributionCandidate)
      : undefined;
    if (
      !episode
      || !canonicalCandidate?.success
      || episode.episodeId !== record.sourceId
      || canonicalCandidate.data.sourceId !== record.sourceId
      || !isDeepStrictEqual(canonicalCandidate.data, candidate)
      || (record.sourceInstanceId !== undefined && episode.task.instanceId !== record.sourceInstanceId)
    ) {
      throw new Error(
        `cannot register contribution reference ${record.sourceId}: matching canonical episode is required`,
      );
    }
    await this.store.recordReference(record.sourceId, {
      publishMinedTasksConsent: candidate.publishMinedTasksConsent,
    });
  }

  private async resolve(
    record: ContributionStoreRecord,
  ): Promise<StoredMineableTraceRecord | undefined> {
    const evidence = await this.evidence.get(record.recordId);
    const episode = evidence.status === 'ok' ? evidence.value : undefined;
    if (!episode || episode.episodeId !== record.recordId) return undefined;
    const candidate = ContributionCandidateV1ProjectionSchema.safeParse(episode.contributionCandidate);
    if (!candidate.success || candidate.data.sourceId !== record.recordId) return undefined;
    return {
      ...record,
      candidate: candidate.data,
      localMetadata: {
        kind: 'harness-session',
        ...(episode.task.instanceId ? { sourceInstanceId: episode.task.instanceId } : {}),
      },
    };
  }

  async get(recordId: string): Promise<StoredMineableTraceRecord | undefined> {
    const record = await this.store.get(recordId);
    return record ? this.resolve(record) : undefined;
  }

  async list(): Promise<StoredMineableTraceRecord[]> {
    const resolved = await Promise.all((await this.store.list()).map((record) => this.resolve(record)));
    return resolved.filter((record): record is StoredMineableTraceRecord => record !== undefined);
  }

  async listUnmined(): Promise<MineableTraceRecord[]> {
    return (await this.list())
      .filter((record) => record.localState === 'recorded')
      .map(mineableTraceRecordFromStored);
  }

  async authorize(recordId: string, acknowledgedAt: string): Promise<unknown> {
    return this.store.authorize(recordId, acknowledgedAt);
  }

  async markMinted(recordId: string, mintRef?: string): Promise<unknown> {
    return this.store.markMinted(recordId, mintRef);
  }

  async markRejected(recordId: string, reason?: string): Promise<unknown> {
    return this.store.markRejected(recordId, reason);
  }

  async veto(recordId: string): Promise<unknown> {
    return this.store.veto(recordId);
  }

  async publishAuthorized<T>(
    recordId: string,
    operation: () => Promise<{ value: T; mintRef: string; publicationRef: string }>,
  ): Promise<T> {
    return this.store.publishAuthorized(recordId, operation);
  }

  async markPublished(recordId: string, publicationRef: string): Promise<unknown> {
    return this.store.markPublished(recordId, publicationRef);
  }

  async disableUnpublished(): Promise<string[]> {
    return this.store.disableUnpublished();
  }

  /** Legacy alias: session mining completed locally, whether admitted or not. */
  async markMined(sourceId: string): Promise<void> {
    await this.store.markMinted(sourceId);
  }
}

/**
 * Stage 2 keeps the contribution substrate local while preserving local
 * candidate mining. Revoke retained Stage 1 queue authorization and return
 * the only candidate-consent value production may stamp in this stage.
 */
export async function enforceStage2ParkedPublication(
  store: Pick<MineableTraceStore, 'disableUnpublished'>,
): Promise<false> {
  await store.disableUnpublished();
  return false;
}
