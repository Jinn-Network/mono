import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectSnapshot } from '../../src/dispatcher/project-snapshot.js';
import { fetchProjectSnapshot } from '../../src/dispatcher/project-snapshot.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import { ConditionalRestClient } from '../../src/lifecycle/github-rest.js';
import type {
  GitHubRestDiscoveryReader,
  OpenIssueIndexEntry,
  PullRequestIndexEntry,
} from '../../src/lifecycle/github-rest-discovery.js';
import type { GitHubUsage } from '../../src/lifecycle/github-usage.js';
import {
  IncrementalSnapshotUnavailableError,
  IncrementalLifecycleSnapshotSource,
  type PullRequestEvidenceProbe,
} from '../../src/lifecycle/incremental-snapshot-source.js';
import type {
  LifecycleDiscoveryState,
  LifecycleDiscoveryStateStore,
} from '../../src/lifecycle/lifecycle-cache.js';
import { LifecycleDiscoveryCacheStore } from '../../src/lifecycle/lifecycle-cache.js';
import type {
  GitHubLifecycleReader,
  RawPullRequest,
} from '../../src/lifecycle/snapshot.js';
import { gitOid, type GitOid } from '../../src/lifecycle/types.js';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE = 'cccccccccccccccccccccccccccccccccccccccc';
const HEAD_C = 'dddddddddddddddddddddddddddddddddddddddd';
const HEAD_D = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const FULL_AT = '2026-07-22T10:00:00.000Z';

function project(status: 'Todo' | 'In Review' | 'Done' = 'In Review'): ProjectSnapshot {
  return {
    items: [{
      id: 'PVTI_42',
      number: 42,
      contentType: 'Issue',
      status,
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'feat',
      blockedByIssues: [],
      sprintIterationId: 'sprint',
    }],
    rateLimit: {
      remaining: 4_000,
      used: 1_000,
      resetAt: '2026-07-22T11:00:00.000Z',
    },
    currentSprintIterationId: 'sprint',
  };
}

function issue(status: 'Todo' | 'In Review' | 'Done' = 'In Review'): PolledIssue {
  return {
    number: 42,
    title: 'Incremental lifecycle',
    labels: [],
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Medium',
    priority: 'P1',
    status,
    onBoard: true,
    author: 'oaksprout',
    projectItemId: 'PVTI_42',
    inCurrentSprint: true,
  };
}

function rawPr(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 101,
    title: 'feat: incremental lifecycle',
    body: 'Closes #42',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: HEAD_A,
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanReason: null,
    mergedAt: null,
    mergeCommitOid: null,
    ...overrides,
  };
}

function openIndex(overrides: Partial<PullRequestIndexEntry> = {}): PullRequestIndexEntry {
  return {
    number: 101,
    title: 'feat: incremental lifecycle',
    state: 'OPEN',
    updatedAt: '2026-07-22T09:30:00.000Z',
    headOid: HEAD_A,
    headRefName: 'autopilot/42',
    baseRefName: 'next',
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

function issueIndex(): OpenIssueIndexEntry {
  return {
    number: 42,
    title: 'Incremental lifecycle',
    body: '',
    updatedAt: '2026-07-22T09:00:00.000Z',
    author: 'oaksprout',
    labels: [],
  };
}

const EMPTY_USAGE: GitHubUsage = {
  graphqlRequests: 0,
  graphqlCost: 0,
  graphqlRemaining: null,
  graphqlResetAt: null,
  restRequests: 0,
  restNotModified: 0,
  cacheHits: 0,
  accountingComplete: true,
};

class FakeLifecycleReader implements GitHubLifecycleReader {
  project = project();
  issues = [issue()];
  fullPrs = [rawPr()];
  targeted = new Map<number, RawPullRequest | null>([[101, rawPr()]]);
  reviewClaimRefs = new Map<number, GitOid>();
  hydrationCalls: number[] = [];
  branchReads = 0;
  reviewRefReads = 0;
  quotaRemaining = 3_999;
  quotaProbeCalls = 0;
  closingPullRequestNumbers = new Map<number, readonly number[]>();
  closingRelationCalls: number[][] = [];
  quotaResponses: number[] = [];
  projectGraphQlCost = 2;
  events: string[] = [];
  resetCalls = 0;
  onProjectRead: (() => void) | undefined;
  private usage: GitHubUsage = EMPTY_USAGE;

  resetGitHubUsage(): void {
    this.resetCalls += 1;
    this.usage = EMPTY_USAGE;
  }

  readProjectSnapshot = async (): Promise<ProjectSnapshot> => {
    this.onProjectRead?.();
    this.usage = {
      ...this.usage,
      graphqlRequests: this.usage.graphqlRequests + 1,
      graphqlCost: this.usage.graphqlCost + this.projectGraphQlCost,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-22T11:00:00.000Z',
    };
    return this.project;
  };

  readIssues = async (): Promise<readonly PolledIssue[]> => this.issues;

  readPullRequests = async () => ({
    nodes: this.fullPrs,
    pageInfo: { hasNextPage: false, endCursor: null },
  });

  readBranchClaims = async () => {
    this.branchReads += 1;
    return [];
  };

  readIncrementalBranchClaims = async () => {
    this.branchReads += 1;
    this.events.push('git:branches');
    return [];
  };

  readReviewClaimRefs = async () => {
    this.reviewRefReads += 1;
    this.events.push('git:review-refs');
    return this.reviewClaimRefs;
  };

  readGraphQlRemaining = async () => {
    this.quotaProbeCalls += 1;
    const remaining = this.quotaResponses.shift() ?? this.quotaRemaining;
    this.events.push(`rest:quota:${remaining}`);
    this.usage = {
      ...this.usage,
      graphqlRemaining: remaining,
      graphqlResetAt: '2026-07-22T11:00:00.000Z',
      restRequests: this.usage.restRequests + 1,
    };
    return remaining;
  };

  readPullRequestNumbersClosingIssues = async (issueNumbers: readonly number[]) => {
    this.closingRelationCalls.push([...issueNumbers]);
    this.events.push(`graphql:closing-relations:${issueNumbers.join(',')}`);
    this.usage = {
      ...this.usage,
      graphqlRequests: this.usage.graphqlRequests + 1,
      graphqlCost: this.usage.graphqlCost + 1,
      graphqlRemaining: this.usage.graphqlRemaining! - 1,
    };
    return new Set(issueNumbers.flatMap((number) => (
      this.closingPullRequestNumbers.get(number) ?? []
    )));
  };

  readPullRequestForReconciliation = async (number: number) => {
    this.hydrationCalls.push(number);
    this.events.push(`graphql:hydrate:${number}`);
    this.usage = {
      ...this.usage,
      graphqlRequests: this.usage.graphqlRequests + 1,
      graphqlCost: this.usage.graphqlCost + 8,
      graphqlRemaining: this.usage.graphqlRemaining! - 8,
      graphqlResetAt: '2026-07-22T11:00:00.000Z',
    };
    return this.targeted.get(number) ?? null;
  };

  githubUsage = (): GitHubUsage => this.usage;
}

class MemoryStore implements LifecycleDiscoveryStateStore {
  state: LifecycleDiscoveryState | null = null;
  saves = 0;
  failNextSave = false;

  load = async () => this.state;

  save = async (state: LifecycleDiscoveryState) => {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('simulated atomic persistence failure');
    }
    this.state = state;
    this.saves += 1;
  };
}

class FakeRestDiscovery {
  project = project();
  issues = [issueIndex()];
  openPrs = [openIndex()];
  closedPrs: PullRequestIndexEntry[] = [];
  cutoffs: string[] = [];
  events: string[] = [];

  readProjectSnapshot = async () => {
    this.events.push('rest:project');
    return this.project;
  };
  readOpenIssueIndex = async () => {
    this.events.push('rest:issues');
    return this.issues;
  };
  readOpenPullRequestIndex = async () => {
    this.events.push('rest:open-prs');
    return this.openPrs;
  };
  readRecentlyClosedPullRequestIndex = async (cutoff: string) => {
    this.events.push('rest:closed-prs');
    this.cutoffs.push(cutoff);
    return this.closedPrs;
  };
}

function harness(options: {
  probeChanged?: boolean | ((call: number, prNumber: number) => boolean);
} = {}) {
  const reader = new FakeLifecycleReader();
  const rest = new FakeRestDiscovery();
  rest.events = reader.events;
  const store = new MemoryStore();
  const probes: number[] = [];
  let probeCalls = 0;
  const probe: PullRequestEvidenceProbe = {
    changed: async (pr) => {
      probeCalls += 1;
      probes.push(pr.number);
      reader.events.push(`rest:probe:${pr.number}`);
      return typeof options.probeChanged === 'function'
        ? options.probeChanged(probeCalls, pr.number)
        : options.probeChanged ?? false;
    },
  };
  let now = new Date(FULL_AT);
  const conditionalRest = new ConditionalRestClient(async () => {
    throw new Error('conditional REST transport should be owned by discovery/probes');
  });
  const source = new IncrementalLifecycleSnapshotSource({
    fullReader: reader,
    restDiscovery: rest as unknown as GitHubRestDiscoveryReader,
    conditionalRest,
    evidenceProbe: probe,
    cacheStore: store,
    authorAllowlist: new Set(['oaksprout']),
    now: () => now,
  });
  return {
    source,
    reader,
    rest,
    store,
    probes,
    probe,
    conditionalRest,
    setNow(value: string) { now = new Date(value); },
  };
}

describe('IncrementalLifecycleSnapshotSource', () => {
  it('persists and reloads a full source seeded from a live-shaped Project rate limit', async () => {
    const context = harness();
    const fetched = await fetchProjectSnapshot(async () => JSON.stringify({
      data: {
        rateLimit: {
          cost: 2,
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-22T11:00:00.000Z',
        },
        organization: {
          projectV2: {
            sprintField: {
              configuration: {
                iterations: [{ id: 'sprint', startDate: '2026-07-20', duration: 7 }],
              },
            },
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: 'PVTI_42',
                content: {
                  __typename: 'Issue',
                  number: 42,
                  issueType: { name: 'feat' },
                  blockedBy: { nodes: [] },
                },
                status: { name: 'In Review' },
                priority: { name: 'P1' },
                effort: { name: 'Medium' },
                blockedOn: { name: 'Nothing' },
                sprint: { iterationId: 'sprint' },
              }],
            },
          },
        },
      },
    }), { nowMs: Date.parse(FULL_AT) });
    context.reader.project = fetched;
    const directory = await mkdtemp(join(tmpdir(), 'jinn-live-rate-limit-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const source = new IncrementalLifecycleSnapshotSource({
      fullReader: context.reader,
      restDiscovery: context.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct conditional REST calls expected');
      }),
      evidenceProbe: context.probe,
      cacheStore: store,
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date(FULL_AT),
    });

    await expect(source.read({ mode: 'full', rateLimitFloor: 500 }))
      .resolves.toMatchObject({ snapshotMode: 'full', snapshotComplete: true });
    await expect(store.load()).resolves.toMatchObject({
      evidence: {
        project: {
          rateLimit: {
            remaining: 4_000,
            used: 1_000,
            resetAt: '2026-07-22T11:00:00.000Z',
          },
        },
      },
    });
  });

  it('preserves already-metered failed-full usage during an internal incremental fallback', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    const fallback = await context.source.read({
      mode: 'incremental',
      rateLimitFloor: 500,
      resetUsage: false,
    });

    expect(context.reader.resetCalls).toBe(1);
    expect(fallback.githubUsage).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 2,
      graphqlRemaining: 3_999,
    });
  });

  it('fails closed when incremental mode has no complete full seed', async () => {
    const { source, rest } = harness();

    await expect(source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .rejects.toBeInstanceOf(IncrementalSnapshotUnavailableError);
    expect(rest.cutoffs).toEqual([]);
  });

  it('fails closed incrementally on corrupt content but full mode quarantines and replaces it', async () => {
    const context = harness();
    const directory = await mkdtemp(join(tmpdir(), 'jinn-corrupt-recovery-'));
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'lifecycle-cache.json'), '{broken', { mode: 0o600 });
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const source = new IncrementalLifecycleSnapshotSource({
      fullReader: context.reader,
      restDiscovery: context.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct calls expected');
      }),
      evidenceProbe: context.probe,
      cacheStore: store,
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date(FULL_AT),
    });

    await expect(source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .rejects.toThrow(/cache is corrupt/i);
    expect(context.reader.quotaProbeCalls).toBe(0);

    await expect(source.read({ mode: 'full', rateLimitFloor: 500 }))
      .resolves.toMatchObject({ snapshotMode: 'full', snapshotComplete: true });
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      'lifecycle-cache.json',
      expect.stringMatching(/^lifecycle-cache\.corrupt\..+\.json$/),
    ]));
  });

  it.each([
    ['invalid', [{
      endpoint: 'https://attacker.invalid/cache',
      etag: '"bad"',
      body: '[]',
      nextEndpoint: null,
    }]],
    ['duplicate', [{
      endpoint: 'repos/Jinn-Network/mono/issues?state=open&page=1',
      etag: '"one"',
      body: '[]',
      nextEndpoint: null,
    }, {
      endpoint: 'repos/Jinn-Network/mono/issues?state=open&page=1',
      etag: '"two"',
      body: '[]',
      nextEndpoint: null,
    }]],
  ] as const)('full mode quarantines and repairs %s persisted REST cache endpoints', async (
    _label,
    restCache,
  ) => {
    const seed = harness();
    await seed.source.read({ mode: 'full', rateLimitFloor: 500 });
    const directory = await mkdtemp(join(tmpdir(), 'jinn-rest-cache-repair-'));
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'lifecycle-cache.json'), JSON.stringify({
      ...seed.store.state!,
      restCache,
    }), { mode: 0o600 });
    const source = new IncrementalLifecycleSnapshotSource({
      fullReader: seed.reader,
      restDiscovery: seed.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct conditional REST calls expected');
      }),
      evidenceProbe: seed.probe,
      cacheStore: new LifecycleDiscoveryCacheStore({ stateDirectory: directory }),
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date(FULL_AT),
    });

    await expect(source.read({ mode: 'full', rateLimitFloor: 500 }))
      .resolves.toMatchObject({ snapshotMode: 'full', snapshotComplete: true });
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      'lifecycle-cache.json',
      expect.stringMatching(/^lifecycle-cache\.corrupt\..+\.json$/),
    ]));
  });

  it('does not recover through an unsafe symlink cache path', async () => {
    const context = harness();
    const directory = await mkdtemp(join(tmpdir(), 'jinn-unsafe-cache-'));
    await chmod(directory, 0o700);
    const target = join(directory, 'target.json');
    await writeFile(target, '{broken', { mode: 0o600 });
    await symlink(target, join(directory, 'lifecycle-cache.json'));
    const source = new IncrementalLifecycleSnapshotSource({
      fullReader: context.reader,
      restDiscovery: context.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct calls expected');
      }),
      evidenceProbe: context.probe,
      cacheStore: new LifecycleDiscoveryCacheStore({ stateDirectory: directory }),
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date(FULL_AT),
    });

    await expect(source.read({ mode: 'full', rateLimitFloor: 500 }))
      .rejects.toThrow(/not a regular file|unsafe/i);
  });

  it('seeds durable evidence from the full oracle and reuses it on an unchanged cycle', async () => {
    const { source, reader, rest, store, probes, setNow } = harness();
    const full = await source.read({ mode: 'full', rateLimitFloor: 500 });
    reader.quotaProbeCalls = 0;
    setNow('2026-07-22T10:10:00.000Z');

    const incremental = await source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(full).toMatchObject({
      snapshotMode: 'full',
      snapshotComplete: true,
      lastFullReconciliationAt: FULL_AT,
    });
    expect(store.state).toMatchObject({
      version: 1,
      recentlyClosedCutoff: '2026-07-22T09:55:00.000Z',
      evidence: { snapshotMode: 'incremental', lastFullReconciliationAt: FULL_AT },
    });
    expect(rest.cutoffs).toEqual([
      '2026-07-22T09:55:00.000Z',
      '2026-07-22T09:55:00.000Z',
      '2026-07-22T09:55:00.000Z',
    ]);
    expect(incremental).toMatchObject({
      snapshotMode: 'incremental',
      snapshotComplete: true,
      lastFullReconciliationAt: FULL_AT,
      githubUsage: {
        graphqlRequests: 0,
        graphqlCost: 0,
        graphqlRemaining: 3_999,
        restRequests: 1,
      },
    });
    expect(incremental.lifecycle).toEqual(full.lifecycle);
    expect(reader.hydrationCalls).toEqual([]);
    expect(reader.quotaProbeCalls).toBe(1);
    expect(probes).toEqual([101]);
    expect(reader.branchReads).toBe(2);
    expect(reader.reviewRefReads).toBe(1);
  });

  it('establishes complete REST baselines at startup without hydrating unrelated open or closed PRs', async () => {
    const context = harness();
    context.rest.openPrs = [
      openIndex(),
      openIndex({
        number: 102,
        title: 'unrelated one',
        headOid: HEAD_B,
        headRefName: 'feature/unrelated-one',
      }),
      openIndex({
        number: 103,
        title: 'unrelated two',
        headOid: HEAD_C,
        headRefName: 'feature/unrelated-two',
      }),
    ];
    context.rest.closedPrs = [openIndex({
      number: 104,
      title: 'closed without merge',
      state: 'CLOSED',
      updatedAt: '2026-07-22T09:40:00.000Z',
      headOid: HEAD_D,
      headRefName: 'feature/closed',
      closedAt: '2026-07-22T09:40:00.000Z',
    })];
    context.reader.targeted.set(102, rawPr({
      number: 102,
      labels: [],
      closingIssueNumbers: [99],
      headOid: HEAD_B,
      headRefName: 'feature/unrelated-one',
    }));
    context.reader.targeted.set(103, rawPr({
      number: 103,
      labels: [],
      closingIssueNumbers: [99],
      headOid: HEAD_C,
      headRefName: 'feature/unrelated-two',
    }));
    context.reader.targeted.set(104, null);

    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.reader.hydrationCalls = [];
    context.setNow('2026-07-22T10:10:00.000Z');
    const incremental = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([]);
    expect(incremental.githubUsage?.graphqlCost).toBeLessThanOrEqual(2);
    expect(context.store.state?.openPullRequests).toEqual(context.rest.openPrs);
    expect(context.store.state?.recentlyClosedPullRequests).toEqual(context.rest.closedPrs);
  });

  it('preserves REST baselines across an hourly full oracle without rehydrating omitted PRs', async () => {
    const context = harness();
    const unrelatedOne = rawPr({
      number: 102,
      labels: [],
      closingIssueNumbers: [99],
      headOid: HEAD_B,
      headRefName: 'feature/unrelated-one',
    });
    const unrelatedTwo = rawPr({
      number: 103,
      labels: [],
      closingIssueNumbers: [99],
      headOid: HEAD_C,
      headRefName: 'feature/unrelated-two',
    });
    context.reader.fullPrs = [rawPr(), unrelatedOne, unrelatedTwo];
    context.rest.openPrs = [
      openIndex(),
      openIndex({ number: 102, title: unrelatedOne.title, headOid: HEAD_B, headRefName: unrelatedOne.headRefName }),
      openIndex({ number: 103, title: unrelatedTwo.title, headOid: HEAD_C, headRefName: unrelatedTwo.headRefName }),
    ];
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    context.reader.fullPrs = [rawPr()];
    context.rest.closedPrs = [openIndex({
      number: 104,
      title: 'closed without merge',
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:20:00.000Z',
      headOid: HEAD_D,
      headRefName: 'feature/closed',
      closedAt: '2026-07-22T10:20:00.000Z',
    })];
    context.reader.targeted.set(104, null);
    context.setNow('2026-07-22T11:00:00.000Z');
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.reader.hydrationCalls = [];
    context.setNow('2026-07-22T11:10:00.000Z');
    const incremental = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([]);
    expect(incremental.githubUsage?.graphqlCost).toBeLessThanOrEqual(2);
    expect(context.store.state?.recentlyClosedPullRequests).toEqual(context.rest.closedPrs);
  });

  it('rejects an opened-and-merged race across the full boundary and preserves discoverability', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    const prior = context.store.state;
    const racedClosed = openIndex({
      number: 102,
      title: 'opened and merged during full reconciliation',
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:30:00.000Z',
      headOid: HEAD_B,
      headRefName: 'feature/raced-merge',
      closedAt: '2026-07-22T10:30:00.000Z',
      mergedAt: '2026-07-22T10:30:00.000Z',
    });
    const racedMerged = rawPr({
      number: 102,
      title: racedClosed.title,
      state: 'MERGED',
      headOid: HEAD_B,
      headRefName: racedClosed.headRefName,
      mergedAt: racedClosed.mergedAt,
      mergeCommitOid: MERGE,
    });
    context.reader.fullPrs = [rawPr(), racedMerged];
    context.reader.targeted.set(102, racedMerged);
    let boundaryClosedRead = 0;
    context.rest.readRecentlyClosedPullRequestIndex = async (cutoff: string) => {
      context.rest.cutoffs.push(cutoff);
      boundaryClosedRead += 1;
      return boundaryClosedRead === 1 ? [] : [racedClosed];
    };
    context.setNow('2026-07-22T10:30:00.000Z');

    await expect(context.source.read({ mode: 'full', rateLimitFloor: 500 }))
      .rejects.toThrow(/recently-closed.*changed|full oracle boundary/i);
    expect(context.store.state).toBe(prior);
    expect(context.store.state?.evidence.pullRequests.map((pr) => pr.number)).toEqual([101]);

    context.rest.readRecentlyClosedPullRequestIndex = async (cutoff: string) => {
      context.rest.cutoffs.push(cutoff);
      return [racedClosed];
    };
    context.reader.fullPrs = [rawPr()];
    context.reader.hydrationCalls = [];
    context.setNow('2026-07-22T10:40:00.000Z');
    const incremental = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([102]);
    expect(incremental.pullRequests).toEqual([
      expect.objectContaining({ number: 101, state: 'OPEN' }),
      expect.objectContaining({ number: 102, state: 'MERGED' }),
    ]);
  });

  it.each([
    ['new pull request', 'new'],
    ['changed head', 'head'],
    ['review, comment, or check evidence', 'probe'],
    ['review-claim ref', 'claim'],
  ] as const)('hydrates only the changed PR for %s', async (_label, change) => {
    const context = harness({ probeChanged: change === 'probe' });
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    if (change === 'new') {
      context.rest.openPrs.push(openIndex({
        number: 102,
        title: 'new PR',
        updatedAt: '2026-07-22T10:05:00.000Z',
        headOid: HEAD_B,
        headRefName: 'autopilot/42-new',
      }));
      context.reader.targeted.set(102, rawPr({
        number: 102,
        title: 'new PR',
        headOid: HEAD_B,
        headRefName: 'autopilot/42-new',
      }));
    } else if (change === 'head') {
      context.rest.openPrs = [openIndex({
        headOid: HEAD_B,
        updatedAt: '2026-07-22T10:05:00.000Z',
      })];
      context.reader.targeted.set(101, rawPr({ headOid: HEAD_B }));
    } else if (change === 'claim') {
      context.reader.reviewClaimRefs.set(101, gitOid(HEAD_B));
    }

    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([change === 'new' ? 102 : 101]);
  });

  it('hydrates a first-index update that happened after the full capture', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    context.rest.openPrs = [openIndex({ updatedAt: '2026-07-22T10:05:00.000Z' })];

    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([101]);
  });

  it('does not hydrate an unchanged full-boundary omission solely because exact evidence is absent', async () => {
    const context = harness();
    context.reader.fullPrs = [];
    context.reader.targeted.set(101, rawPr({ labels: [], closingIssueNumbers: [99] }));
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');

    const snapshot = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([]);
    expect(snapshot.pullRequests).toEqual([]);
  });

  it.each(['Done', 'archived'] as const)(
    'preserves complete open evidence across Project-only %s and restores exact parity',
    async (transition) => {
      const context = harness();
      const nonEngine = rawPr({ labels: [] });
      context.reader.fullPrs = [nonEngine];
      context.reader.targeted.set(101, nonEngine);
      await context.source.read({ mode: 'full', rateLimitFloor: 500 });
      context.setNow('2026-07-22T10:10:00.000Z');
      context.rest.project = transition === 'Done'
        ? project('Done')
        : { ...project(), items: [] };

      const inactive = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
      expect(inactive.pullRequests).toEqual([]);
      expect(context.store.state?.openPullRequestEvidence).toEqual([
        expect.objectContaining({ number: 101 }),
      ]);

      context.rest.project = project('In Review');
      context.setNow('2026-07-22T10:20:00.000Z');
      const restored = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
      expect(restored.pullRequests).toEqual([expect.objectContaining({ number: 101 })]);
      expect(context.reader.hydrationCalls).toEqual([]);

      context.reader.project = project('In Review');
      context.reader.fullPrs = [nonEngine];
      context.setNow('2026-07-22T11:00:00.000Z');
      const oracle = await context.source.read({ mode: 'full', rateLimitFloor: 500 });
      expect(oracle.parityDifferences).toEqual([]);
      expect(oracle.lifecycle).toEqual(restored.lifecycle);
    },
  );

  it('hydrates only closing-PR candidates when a Project-only transition activates an omitted issue', async () => {
    const context = harness();
    const candidate = rawPr({
      number: 102,
      title: 'candidate for later Project issue',
      labels: [],
      closingIssueNumbers: [43],
      headOid: HEAD_B,
      headRefName: 'feature/candidate',
    });
    const unrelated = rawPr({
      number: 103,
      title: 'still unrelated',
      labels: [],
      closingIssueNumbers: [99],
      headOid: HEAD_C,
      headRefName: 'feature/unrelated',
    });
    context.rest.openPrs = [
      openIndex(),
      openIndex({ number: 102, title: candidate.title, headOid: HEAD_B, headRefName: candidate.headRefName }),
      openIndex({ number: 103, title: unrelated.title, headOid: HEAD_C, headRefName: unrelated.headRefName }),
    ];
    context.reader.targeted.set(102, candidate);
    context.reader.targeted.set(103, unrelated);
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    context.reader.hydrationCalls = [];
    context.reader.closingPullRequestNumbers.set(43, [102]);
    context.rest.project = {
      ...project(),
      items: [
        ...project().items,
        {
          ...project().items[0]!,
          id: 'PVTI_43',
          number: 43,
          status: 'Todo',
        },
      ],
    };
    context.rest.issues.push({
      ...issueIndex(),
      number: 43,
      title: 'Activated by Project transition',
    });
    context.setNow('2026-07-22T10:20:00.000Z');

    const activated = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.closingRelationCalls).toEqual([[43]]);
    expect(context.reader.hydrationCalls).toEqual([102]);
    expect(activated.pullRequests.map((pr) => pr.number)).toEqual([101, 102]);
  });

  it('takes a fresh reserve check before Project relation discovery', async () => {
    const context = harness();
    const candidate = rawPr({
      number: 102,
      title: 'candidate for later Project issue',
      labels: [],
      closingIssueNumbers: [43],
      headOid: HEAD_B,
      headRefName: 'feature/candidate',
    });
    context.rest.openPrs = [
      openIndex(),
      openIndex({ number: 102, title: candidate.title, headOid: HEAD_B, headRefName: candidate.headRefName }),
    ];
    context.reader.targeted.set(102, candidate);
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    context.reader.closingRelationCalls = [];
    context.reader.closingPullRequestNumbers.set(43, [102]);
    context.reader.quotaResponses = [4_000, 501];
    context.rest.project = {
      ...project(),
      items: [
        ...project().items,
        { ...project().items[0]!, id: 'PVTI_43', number: 43, status: 'Todo' },
      ],
    };
    context.rest.issues.push({ ...issueIndex(), number: 43, title: 'New Project issue' });
    context.setNow('2026-07-22T10:20:00.000Z');

    await expect(context.source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .rejects.toThrow(/502|reserve|rate-limit/i);
    expect(context.reader.closingRelationCalls).toEqual([]);
  });

  it('keeps a newly changed non-engine PR when it closes a non-Done Project issue', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    context.rest.openPrs.push(openIndex({
      number: 102,
      title: 'linked without engine label',
      updatedAt: '2026-07-22T10:05:00.000Z',
      headOid: HEAD_B,
      headRefName: 'feature/linked',
    }));
    context.reader.targeted.set(102, rawPr({
      number: 102,
      title: 'linked without engine label',
      headOid: HEAD_B,
      headRefName: 'feature/linked',
      labels: [],
    }));

    const snapshot = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(snapshot.pullRequests.map((candidate) => candidate.number)).toEqual([101, 102]);
  });

  it('restarts from a durable complete seed without another full read', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    const restartedReader = new FakeLifecycleReader();
    const restarted = new IncrementalLifecycleSnapshotSource({
      fullReader: restartedReader,
      restDiscovery: context.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct conditional REST calls expected');
      }),
      evidenceProbe: context.probe,
      cacheStore: context.store,
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date('2026-07-22T10:20:00.000Z'),
    });

    await expect(restarted.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .resolves.toMatchObject({
        snapshotMode: 'incremental',
        lastFullReconciliationAt: FULL_AT,
      });
    expect(restartedReader.hydrationCalls).toEqual([]);
  });

  it('captures completion time and atomically persists data that changes during an incremental read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-mid-cycle-cache-'));
    const reader = new FakeLifecycleReader();
    const rest = new FakeRestDiscovery();
    let clock = new Date(FULL_AT);
    const originalOpenRead = rest.readOpenPullRequestIndex;
    const source = new IncrementalLifecycleSnapshotSource({
      fullReader: reader,
      restDiscovery: rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct conditional REST calls expected');
      }),
      evidenceProbe: { changed: async () => false },
      cacheStore: new LifecycleDiscoveryCacheStore({ stateDirectory: directory }),
      authorAllowlist: new Set(['oaksprout']),
      now: () => clock,
    });
    await source.read({ mode: 'full', rateLimitFloor: 500 });
    clock = new Date('2026-07-22T10:10:00.000Z');
    rest.readOpenPullRequestIndex = async () => {
      rest.openPrs = [openIndex({ updatedAt: '2026-07-22T10:10:30.000Z' })];
      clock = new Date('2026-07-22T10:11:00.000Z');
      return originalOpenRead();
    };

    const snapshot = await source.read({ mode: 'incremental', rateLimitFloor: 500 });
    const persisted = await new LifecycleDiscoveryCacheStore({ stateDirectory: directory }).load();

    expect(snapshot.capturedAt).toBe('2026-07-22T10:11:00.000Z');
    expect(persisted?.evidence.capturedAt).toBe(snapshot.capturedAt);
    expect(persisted?.openPullRequests?.[0]?.updatedAt)
      .toBe('2026-07-22T10:10:30.000Z');
  });

  it('enforces the targeted reserve before every exact hydration', async () => {
    const allowed = harness({ probeChanged: true });
    await allowed.source.read({ mode: 'full', rateLimitFloor: 500 });
    allowed.reader.quotaResponses = [4_000, 510];
    allowed.setNow('2026-07-22T10:10:00.000Z');
    await expect(allowed.source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .resolves.toMatchObject({ githubUsage: { graphqlCost: 8, graphqlRemaining: 502 } });

    const denied = harness({ probeChanged: true });
    await denied.source.read({ mode: 'full', rateLimitFloor: 500 });
    denied.reader.quotaResponses = [4_000, 509];
    denied.setNow('2026-07-22T10:10:00.000Z');
    await expect(denied.source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .rejects.toThrow(/510/);
    expect(denied.reader.hydrationCalls).toEqual([]);
  });

  it('marks parity unavailable without GraphQL spend when a changed PR needs hydration', async () => {
    const context = harness({ probeChanged: (call) => call === 2 });
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.reader.events = [];
    context.rest.events = context.reader.events;
    const savesBeforeFull = context.store.saves;
    context.reader.quotaResponses = [960, 960];
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([]);
    expect(context.reader.events).not.toContain('graphql:hydrate:101');
    expect(reconciled.parityUnavailableReason).toMatch(
      /fresh incremental boundary candidate failed.*requires GraphQL/i,
    );
    expect(reconciled.githubUsage?.graphqlCost).toBeLessThanOrEqual(450);
    expect(context.store.saves).toBe(savesBeforeFull + 1);
    expect(context.store.state?.evidence.snapshotMode).toBe('full');
  });

  it('abandons a multi-PR parity candidate with zero GraphQL spend and refreshes the full cache', async () => {
    let changed = false;
    const context = harness({ probeChanged: () => changed });
    const second = rawPr({
      number: 102,
      title: 'second changed PR',
      headOid: HEAD_B,
      headRefName: 'autopilot/43',
      closingIssueNumbers: [42],
    });
    context.reader.fullPrs = [rawPr(), second];
    context.reader.targeted.set(102, second);
    context.rest.openPrs = [
      openIndex(),
      openIndex({
        number: 102,
        title: second.title,
        headOid: HEAD_B,
        headRefName: second.headRefName,
      }),
    ];
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    changed = true;
    context.reader.events = [];
    context.rest.events = context.reader.events;
    const savesBeforeFull = context.store.saves;
    context.reader.quotaResponses = [4_000, 4_000];
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([]);
    expect(context.reader.events).not.toContain('graphql:hydrate:101');
    expect(context.reader.events).not.toContain('graphql:hydrate:102');
    expect(reconciled.parityUnavailableReason).toMatch(
      /fresh incremental boundary candidate failed.*requires GraphQL/i,
    );
    expect(reconciled.githubUsage?.graphqlCost).toBeLessThanOrEqual(450);
    expect(context.store.saves).toBe(savesBeforeFull + 1);
    expect(context.store.state?.evidence.snapshotMode).toBe('full');
  });

  it('stops a parity candidate before targeted closing-relation discovery', async () => {
    const context = harness();
    const linked = rawPr({
      number: 102,
      title: 'linked to a newly active issue',
      labels: [],
      closingIssueNumbers: [43],
      headOid: HEAD_B,
      headRefName: 'feature/linked',
    });
    context.rest.openPrs = [
      openIndex(),
      openIndex({
        number: 102,
        title: linked.title,
        headOid: HEAD_B,
        headRefName: linked.headRefName,
      }),
    ];
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    const secondItem = {
      ...project('Todo').items[0]!,
      id: 'PVTI_43',
      number: 43,
    };
    const activatedProject = {
      ...project('In Review'),
      items: [...project('In Review').items, secondItem],
    };
    context.rest.project = activatedProject;
    context.reader.project = activatedProject;
    context.rest.issues.push({ ...issueIndex(), number: 43, title: 'Newly active issue' });
    context.reader.issues.push({ ...issue('Todo'), number: 43, title: 'Newly active issue' });
    context.reader.fullPrs = [rawPr(), linked];
    context.reader.closingPullRequestNumbers.set(43, [102]);
    context.reader.closingRelationCalls = [];
    const savesBeforeFull = context.store.saves;
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(context.reader.closingRelationCalls).toEqual([]);
    expect(context.reader.hydrationCalls).toEqual([]);
    expect(reconciled.parityUnavailableReason).toMatch(
      /requires GraphQL closing-PR relation discovery.*#43/i,
    );
    expect(context.store.saves).toBe(savesBeforeFull + 1);
    expect(context.store.state?.evidence.snapshotMode).toBe('full');
    expect(reconciled.githubUsage?.graphqlCost).toBeLessThanOrEqual(450);
  });

  it('fails explicitly when the full oracle itself exceeds 450 GraphQL points', async () => {
    const context = harness();
    context.reader.projectGraphQlCost = 451;

    await expect(context.source.read({ mode: 'full', rateLimitFloor: 500 }))
      .rejects.toThrow(/Full oracle consumed 451 GraphQL points.*450-point acceptance/i);
    expect(context.store.saves).toBe(0);
  });

  it('always obtains live GraphQL evidence and enforces the floor on an idle cycle', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.reader.quotaProbeCalls = 0;
    context.reader.quotaRemaining = 499;
    context.setNow('2026-07-22T10:10:00.000Z');

    await expect(context.source.read({ mode: 'incremental', rateLimitFloor: 500 }))
      .rejects.toThrow(/499.*500|rate-limit/i);
    expect(context.reader.quotaProbeCalls).toBe(1);
    expect(context.reader.hydrationCalls).toEqual([]);
  });

  it('takes a fresh post-discovery quota probe and reuses hydration evidence for later PRs', async () => {
    const context = harness({ probeChanged: true });
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.reader.quotaProbeCalls = 0;
    context.reader.quotaResponses = [4_000, 530];
    context.setNow('2026-07-22T10:10:00.000Z');
    context.rest.openPrs.push(openIndex({
      number: 102,
      title: 'second',
      updatedAt: '2026-07-22T10:05:00.000Z',
      headOid: HEAD_B,
      headRefName: 'feature/second',
    }));
    context.reader.targeted.set(102, rawPr({
      number: 102,
      title: 'second',
      headOid: HEAD_B,
      headRefName: 'feature/second',
    }));

    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.quotaProbeCalls).toBe(2);
    expect(context.reader.hydrationCalls).toEqual([101, 102]);
  });

  it('orders the final quota precheck after all discovery, evidence probes, and git reads', async () => {
    const context = harness({ probeChanged: true });
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.reader.events = [];
    context.rest.events = context.reader.events;
    context.reader.quotaResponses = [4_000, 510];
    context.setNow('2026-07-22T10:10:00.000Z');

    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.events).toEqual([
      'rest:quota:4000',
      'rest:project',
      'rest:issues',
      'rest:open-prs',
      'rest:closed-prs',
      'git:review-refs',
      'rest:probe:101',
      'git:branches',
      'rest:quota:510',
      'graphql:hydrate:101',
    ]);
  });

  it('rechecks a disappeared PR, retains a merge until Done, then evicts it', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.rest.openPrs = [];
    context.rest.closedPrs = [openIndex({
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:11:00.000Z',
      closedAt: '2026-07-22T10:11:00.000Z',
      mergedAt: '2026-07-22T10:11:00.000Z',
    })];
    context.reader.targeted.set(101, rawPr({
      state: 'MERGED',
      mergedAt: '2026-07-22T10:11:00.000Z',
      mergeCommitOid: MERGE,
    }));

    const merged = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    expect(merged.pullRequests).toEqual([
      expect.objectContaining({ number: 101, state: 'MERGED', mergeCommitOid: MERGE }),
    ]);

    context.rest.project = project('Done');
    context.reader.issues = [];
    const done = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    expect(done.pullRequests).toEqual([]);
    expect(context.reader.hydrationCalls).toEqual([101]);
  });

  it('drops a disappeared closed-unmerged PR only after its targeted readback', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.rest.openPrs = [];
    context.rest.closedPrs = [openIndex({
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:11:00.000Z',
      closedAt: '2026-07-22T10:11:00.000Z',
    })];
    context.reader.targeted.set(101, null);

    const snapshot = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(snapshot.pullRequests).toEqual([]);
    expect(context.reader.hydrationCalls).toEqual([101]);
  });

  it.each([
    ['merged', rawPr({
      state: 'MERGED',
      mergedAt: '2026-07-22T10:05:00.000Z',
      mergeCommitOid: MERGE,
    }), 1],
    ['closed-unmerged', null, 0],
  ] as const)('classifies a previously unseen opened+closed-between-polls PR as %s', async (
    _label,
    outcome,
    expected,
  ) => {
    const context = harness();
    context.reader.fullPrs = [];
    context.rest.openPrs = [];
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    context.rest.closedPrs = [openIndex({
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:05:00.000Z',
      closedAt: '2026-07-22T10:05:00.000Z',
      mergedAt: outcome === null ? null : '2026-07-22T10:05:00.000Z',
    })];
    context.reader.targeted.set(101, outcome);

    const snapshot = await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });

    expect(context.reader.hydrationCalls).toEqual([101]);
    expect(snapshot.pullRequests).toHaveLength(expected);
  });

  it('persists a closed-unmerged classification and does not rehydrate it unchanged or restarted', async () => {
    const context = harness();
    context.reader.fullPrs = [];
    context.rest.openPrs = [];
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    context.rest.closedPrs = [openIndex({
      state: 'CLOSED',
      updatedAt: '2026-07-22T10:05:00.000Z',
      closedAt: '2026-07-22T10:05:00.000Z',
    })];
    context.reader.targeted.set(101, null);
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    expect(context.reader.hydrationCalls).toEqual([101]);
    expect(context.store.state?.recentlyClosedPullRequests).toEqual(context.rest.closedPrs);

    const restartedReader = new FakeLifecycleReader();
    restartedReader.targeted.set(101, null);
    const restarted = new IncrementalLifecycleSnapshotSource({
      fullReader: restartedReader,
      restDiscovery: context.rest as unknown as GitHubRestDiscoveryReader,
      conditionalRest: new ConditionalRestClient(async () => {
        throw new Error('no direct calls expected');
      }),
      evidenceProbe: context.probe,
      cacheStore: context.store,
      authorAllowlist: new Set(['oaksprout']),
      now: () => new Date('2026-07-22T10:20:00.000Z'),
    });
    await restarted.read({ mode: 'incremental', rateLimitFloor: 500 });
    expect(restartedReader.hydrationCalls).toEqual([]);
  });

  it('does not report a legitimate between-cycle change as a parity defect', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.rest.project = project('Todo');
    context.reader.project = project('Todo');
    context.reader.issues = [issue('Todo')];
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(reconciled.parityDifferences).toEqual([]);
    expect(reconciled).not.toHaveProperty('parityUnavailableReason');
  });

  it('reports a stable same-boundary incremental/full decision mismatch', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.rest.project = project('Todo');
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(reconciled.parityDifferences).toEqual([
      expect.objectContaining({ subject: 'pull-request:101' }),
    ]);
    expect(reconciled).not.toHaveProperty('parityUnavailableReason');
    expect(context.store.state?.evidence.pullRequests[0]?.headOid).toBe(HEAD_A);
    expect(context.store.state?.evidence.snapshotMode).toBe('full');
  });

  it('marks parity unavailable when discovery inputs change during the full oracle window', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    const savesBeforeFull = context.store.saves;
    context.reader.onProjectRead = () => {
      context.rest.project = project('Todo');
    };
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(reconciled).not.toHaveProperty('parityDifferences');
    expect(reconciled.parityUnavailableReason).toMatch(/Project|boundary|changed/i);
    expect(context.store.saves).toBe(savesBeforeFull + 1);
    expect(context.store.state?.evidence.snapshotMode).toBe('full');
    expect(context.store.state?.evidence.capturedAt).toBe(reconciled.capturedAt);
  });

  it('treats issue and PR label permutations as identical lifecycle decisions', async () => {
    const context = harness();
    const secondProjectItem = {
      ...project('Todo').items[0]!,
      id: 'PVTI_43',
      number: 43,
    };
    const projectWithSecondIssue = {
      ...project('In Review'),
      items: [...project('In Review').items, secondProjectItem],
    };
    context.rest.project = projectWithSecondIssue;
    context.reader.project = projectWithSecondIssue;
    context.rest.issues = [
      issueIndex(),
      { ...issueIndex(), number: 43, title: 'Unmapped issue', labels: ['alpha', 'beta'] },
    ];
    context.reader.issues = [
      issue(),
      { ...issue('Todo'), number: 43, title: 'Unmapped issue', labels: ['beta', 'alpha'] },
    ];
    context.reader.fullPrs = [rawPr({ labels: ['engine:review', 'zeta'] })];
    context.reader.targeted.set(101, rawPr({ labels: ['engine:review', 'zeta'] }));
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.reader.fullPrs = [rawPr({ labels: ['zeta', 'engine:review'] })];
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(reconciled.parityDifferences).toEqual([]);
    expect(reconciled).not.toHaveProperty('parityUnavailableReason');
  });

  it('marks parity unavailable when a conditional response fingerprint changes', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    context.conditionalRest.restoreCache([{
      endpoint: 'orgs/Jinn-Network/projectsV2/4/fields?per_page=100',
      etag: '"fields-a"',
      body: '[]',
      nextEndpoint: null,
    }]);
    context.setNow('2026-07-22T10:10:00.000Z');
    await context.source.read({ mode: 'incremental', rateLimitFloor: 500 });
    context.reader.onProjectRead = () => {
      context.conditionalRest.restoreCache([{
        endpoint: 'orgs/Jinn-Network/projectsV2/4/fields?per_page=100',
        etag: '"fields-b"',
        body: '[]',
        nextEndpoint: null,
      }]);
    };
    context.setNow('2026-07-22T11:00:00.000Z');

    const reconciled = await context.source.read({ mode: 'full', rateLimitFloor: 500 });

    expect(reconciled).not.toHaveProperty('parityDifferences');
    expect(reconciled.parityUnavailableReason).toMatch(/fingerprint|conditional|ETag/i);
  });

  it('does not replace the last complete seed when full persistence fails', async () => {
    const context = harness();
    await context.source.read({ mode: 'full', rateLimitFloor: 500 });
    const completeSeed = context.store.state;
    context.reader.fullPrs = [rawPr({ headOid: HEAD_B })];
    context.rest.openPrs = [openIndex({ headOid: HEAD_B })];
    context.store.failNextSave = true;

    await expect(context.source.read({ mode: 'full', rateLimitFloor: 500 }))
      .rejects.toThrow(/persistence failure/);

    expect(context.store.state).toBe(completeSeed);
    expect(context.store.state?.evidence.pullRequests[0]?.headOid).toBe(HEAD_A);
  });
});
