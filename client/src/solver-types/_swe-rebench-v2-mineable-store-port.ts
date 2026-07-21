/**
 * Client-owned structural contract for mineable-trace persistence.
 *
 * Public configuration types depend on this port rather than the concrete
 * ContributionStore-backed implementation, keeping private workspace types out
 * of the published declaration graph.
 */

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

/** Resolver-backed view consumed by the dormant session miner. The queue
 * persists only `recordId` and state; candidate/local metadata come from the
 * matching canonical Episode. */
export interface StoredMineableTraceRecord {
  recordId: string;
  candidate: {
    sourceId: string;
    repositorySlug: string;
    baseCommit: string;
    acceptedDiff: string;
    testRuns: Array<{ command: string; exitCode: number; at: string }>;
    intermediateFailureDiffs: string[];
    skillEvents: Array<{ skillRef: string; action: 'loaded' | 'invoked' }>;
    publishMinedTasksConsent: boolean;
    createdAt: string;
  };
  localState: 'recorded' | 'minted' | 'rejected';
  publicationState: 'disabled' | 'preview-required' | 'queued' | 'published' | 'vetoed';
  localMetadata?: {
    kind?: MineableTraceRecord['kind'];
    sourceInstanceId?: string;
  };
}

export interface MineableTraceStorePort {
  /** Compatibility registration for an already-persisted canonical Episode. */
  append(record: MineableTraceRecord): Promise<void>;
  listUnmined(): Promise<MineableTraceRecord[]>;
  list(): Promise<StoredMineableTraceRecord[]>;
  markMinted(recordId: string, mintRef?: string): Promise<unknown>;
  markRejected(recordId: string, reason?: string): Promise<unknown>;
  veto(recordId: string): Promise<unknown>;
  publishAuthorized<T>(
    recordId: string,
    operation: () => Promise<{
      value: T;
      mintRef: string;
      publicationRef: string;
    }>,
  ): Promise<T>;
}
