/**
 * Task-creator compatibility facade over harness-layer's canonical
 * ContributionStore. New jinn-layer and daemon callers therefore share one
 * cacheless schema, migration, lock, and atomic read-modify-write path.
 */
import type { ContributionCandidateV1 } from '@jinn-network/plugin';
import {
  CONTRIBUTION_STORE_SCHEMA_VERSION,
  ContributionStore,
  resolveContributionStateDir,
  type ContributionStoreRecord,
} from '@jinn-network/core';

export const MINEABLE_TRACE_STORE_SCHEMA_VERSION = CONTRIBUTION_STORE_SCHEMA_VERSION;
export const resolveMineableStateDir = resolveContributionStateDir;

export interface MineableTestRun {
  cmd: string;
  exitCode: number;
  at: string;
}

export interface MineableSkillEvent {
  skill: string;
  action: 'loaded' | 'invoked';
}

/** Legacy task-creator view. Persisted v2 candidates use the canonical names. */
export interface MineableTraceRecord {
  sourceId: string;
  kind: 'solvernet-execution' | 'harness-session';
  repo: string;
  baseCommit: string;
  acceptedDiff: string;
  testRuns: MineableTestRun[];
  intermediateFailureDiffs: string[];
  skillEvents: MineableSkillEvent[];
  sourceInstanceId?: string;
  publishMinedTasksConsent: boolean;
  createdAt: string;
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

export function mineableTraceRecordFromStored(record: ContributionStoreRecord): MineableTraceRecord {
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

export class MineableTraceStore extends ContributionStore {
  constructor(options: { stateDir: string }) {
    super(options);
  }

  async append(record: MineableTraceRecord): Promise<void> {
    await this.record(toCandidate(record), {
      kind: record.kind,
      ...(record.sourceInstanceId ? { sourceInstanceId: record.sourceInstanceId } : {}),
    });
  }

  async listUnmined(): Promise<MineableTraceRecord[]> {
    return (await this.listRecorded()).map(mineableTraceRecordFromStored);
  }

  /** Legacy alias: session mining completed locally, whether admitted or not. */
  async markMined(sourceId: string): Promise<void> {
    await this.markMinted(sourceId);
  }
}

/**
 * Stage 2 keeps the contribution substrate local while preserving local
 * candidate mining. Revoke retained Stage 1 queue authorization and return
 * the only candidate-consent value production may stamp in this stage.
 */
export async function enforceStage2ParkedPublication(
  store: MineableTraceStore,
): Promise<false> {
  await store.disableUnpublished();
  return false;
}
