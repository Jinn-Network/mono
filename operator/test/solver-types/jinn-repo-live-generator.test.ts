import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POSTING_WINDOW_MS } from '../../src/solver-types/_jinn-repo-posting-window.js';
import {
  makeJinnRepoLiveGenerator,
  makeJinnRepoLiveGeneratorForLaunchedRecord,
  parseMarketplaceMarker,
} from '../../src/solver-types/jinn-repo-live-auto.js';
import type { GitHubFetch } from '../../src/solver-types/jinn-repo-live-auto.js';
import { JinnRepoLiveIssueTaskSchema } from '../../src/solver-types/jinn-repo.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';

const REPO = 'Jinn-Network/mono';
const LABEL = 'engine:marketplace';
const FIXED_NOW_ISO = '2026-07-21T10:00:00.000Z';

// A trusted author_association value used throughout as "our own automation's
// identity" — mirrors the fact that a real marker is always posted by an
// account with write access (issue #1893 Finding 1). Tests exercising the
// trust gate itself override this per-comment.
const TRUSTED_ASSOCIATION = 'MEMBER';

/** A marker-shaped comment authored by a trusted account (default trust config below). */
function trustedComment(body: string, association: string = TRUSTED_ASSOCIATION): { body: string; author_association: string } {
  return { body, author_association: association };
}

// ---------------------------------------------------------------------------
// Marker fixture builder — mirrors marketplace-route.ts's wire format
// independently (no shared code between packages/autopilot and client by
// design; see the generator's module doc).
// ---------------------------------------------------------------------------

function markerComment(args: {
  issueNumber: number;
  hash: string;
  baseCommit?: string;
  effort?: string | null;
  title?: string;
  body?: string;
}): string {
  const payload = {
    schemaVersion: 'jinn-marketplace-snapshot.v1',
    issueNumber: args.issueNumber,
    snapshotHash: args.hash,
    baseCommit: args.baseCommit ?? 'a'.repeat(40),
    effort: args.effort ?? null,
    title: args.title ?? `Issue #${args.issueNumber}`,
    body: args.body ?? `Body for #${args.issueNumber}`,
  };
  return [
    `<!-- jinn-marketplace-snapshot:v1 issue:${args.issueNumber} hash:${args.hash} -->`,
    '',
    'Marketplace snapshot (test fixture).',
    '',
    '```json',
    JSON.stringify(payload),
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fake GitHubFetch
// ---------------------------------------------------------------------------

interface FakeIssue {
  number: number;
  comments: Array<{ body?: string; author_association?: string; user?: { login?: string } }>;
}

function makeFakeFetch(issues: FakeIssue[], opts: { failLabeledList?: boolean; failCommentsFor?: number[] } = {}): GitHubFetch {
  const failCommentsFor = new Set(opts.failCommentsFor ?? []);
  return async (input: string) => {
    if (input.includes('/issues?labels=')) {
      if (opts.failLabeledList) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => issues.map((i) => ({ number: i.number })),
      };
    }
    const m = /\/issues\/(\d+)\/comments/.exec(input);
    if (m) {
      const n = Number(m[1]);
      if (failCommentsFor.has(n)) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      const issue = issues.find((i) => i.number === n);
      return { ok: true, status: 200, json: async () => issue?.comments ?? [] };
    }
    throw new Error(`fixture: unexpected fetch ${input}`);
  };
}

// ---------------------------------------------------------------------------
// parseMarketplaceMarker
// ---------------------------------------------------------------------------

describe('parseMarketplaceMarker', () => {
  it('round-trips a well-formed marker comment', () => {
    const comment = markerComment({ issueNumber: 5, hash: 'deadbeef', title: 'Fix the thing', body: 'Detailed body.' });
    const parsed = parseMarketplaceMarker(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.issueNumber).toBe(5);
    expect(parsed!.snapshotHash).toBe('deadbeef');
    expect(parsed!.title).toBe('Fix the thing');
    expect(parsed!.body).toBe('Detailed body.');
  });

  it('returns null for a non-marker comment', () => {
    expect(parseMarketplaceMarker('just a human reply')).toBeNull();
  });

  it('returns null for a marker prefix with malformed JSON in the fence', () => {
    const bad = '<!-- jinn-marketplace-snapshot:v1 issue:1 hash:x -->\n\n```json\n{not valid json\n```';
    expect(parseMarketplaceMarker(bad)).toBeNull();
  });

  it('returns null for a base_commit that is not a 40-char hex SHA', () => {
    const comment = markerComment({ issueNumber: 1, hash: 'abc', baseCommit: 'not-a-sha' });
    expect(parseMarketplaceMarker(comment)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// makeJinnRepoLiveGenerator
// ---------------------------------------------------------------------------

describe('makeJinnRepoLiveGenerator', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'jinn-repo-live-gen-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('builds a valid JinnRepoLiveIssueTask doc from a fixture label/comment payload', async () => {
    const hash = 'a'.repeat(64);
    const fetchImpl = makeFakeFetch([
      {
        number: 1892,
        comments: [trustedComment(markerComment({ issueNumber: 1892, hash, effort: 'High', title: 'Fix X', body: 'Do the thing.' }))],
      },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
    });

    const tasks = await gen();
    expect(tasks).not.toBeNull();
    expect(tasks).toHaveLength(1);
    const task = tasks![0]!;

    expect(task.solverType).toBe('jinn-repo.v1');
    expect(task.contractId).toBe('jinn-repo');
    expect(task.contractVersion).toBe('v1');
    expect(task.role).toBe('restoration');
    expect(task.claimPolicy).toMatchObject({ mode: 'exclusive', maxClaims: 1, maxClaimsPerOperator: 1 });

    // Parse with the REAL schema — this is the load-bearing correctness check.
    const parsedSpec = JinnRepoLiveIssueTaskSchema.parse(task.spec);
    expect(parsedSpec.source).toBe('live-issue');
    expect(parsedSpec.issue_number).toBe(1892);
    expect(parsedSpec.base_commit).toBe('a'.repeat(40));
    expect(parsedSpec.effort).toBe('high');
    expect(parsedSpec.problem_statement).toContain('Fix X');
    expect(parsedSpec.problem_statement).toContain('Do the thing.');

    // bucketKey ingredients — <issueNumber>:<snapshotHash> — carried on eligibility.
    expect(task.eligibility).toEqual({ issue_number: 1892, snapshot_hash: hash });
  });

  it('second tick with an unchanged snapshot returns null (no re-post)', async () => {
    const hash = 'b'.repeat(64);
    const fetchImpl = makeFakeFetch([
      { number: 10, comments: [trustedComment(markerComment({ issueNumber: 10, hash }))] },
    ]);
    const make = () =>
      makeJinnRepoLiveGenerator({ stateDir, fetchImpl, repo: REPO, label: LABEL, markerTrustedAssociations: [TRUSTED_ASSOCIATION] });

    expect((await make()())).not.toBeNull();
    expect(await make()()).toBeNull();
  });

  it('an edited-body fixture (new hash) produces a NEW task with a new bucketKey', async () => {
    const hashV1 = 'c'.repeat(64);
    const hashV2 = 'd'.repeat(64);

    const genV1 = makeJinnRepoLiveGenerator({
      stateDir,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
      fetchImpl: makeFakeFetch([{ number: 20, comments: [trustedComment(markerComment({ issueNumber: 20, hash: hashV1 }))] }]),
    });
    const firstTasks = await genV1();
    expect(firstTasks).not.toBeNull();
    expect(firstTasks![0]!.eligibility).toEqual({ issue_number: 20, snapshot_hash: hashV1 });

    const genV2 = makeJinnRepoLiveGenerator({
      stateDir,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
      fetchImpl: makeFakeFetch([{ number: 20, comments: [trustedComment(markerComment({ issueNumber: 20, hash: hashV2 }))] }]),
    });
    const secondTasks = await genV2();
    expect(secondTasks).not.toBeNull();
    expect(secondTasks).toHaveLength(1);
    expect(secondTasks![0]!.eligibility).toEqual({ issue_number: 20, snapshot_hash: hashV2 });
    // Different snapshot ⇒ different instance_id (never collide with the prior post).
    const specV1 = JinnRepoLiveIssueTaskSchema.parse(firstTasks![0]!.spec);
    const specV2 = JinnRepoLiveIssueTaskSchema.parse(secondTasks![0]!.spec);
    expect(specV1.instance_id).not.toBe(specV2.instance_id);
  });

  it('a labeled issue with no valid marker is skipped with a log, never a throw', async () => {
    const fetchImpl = makeFakeFetch([
      { number: 30, comments: [{ body: 'just a human comment' }] },
    ]);
    const gen = makeJinnRepoLiveGenerator({ stateDir, fetchImpl, repo: REPO, label: LABEL });
    await expect(gen()).resolves.toBeNull();
  });

  it('a labeled issue with zero comments is skipped, never a throw', async () => {
    const fetchImpl = makeFakeFetch([{ number: 31, comments: [] }]);
    const gen = makeJinnRepoLiveGenerator({ stateDir, fetchImpl, repo: REPO, label: LABEL });
    await expect(gen()).resolves.toBeNull();
  });

  it('a labeled-issue list-poll failure returns null, never throws', async () => {
    const fetchImpl = makeFakeFetch([], { failLabeledList: true });
    const gen = makeJinnRepoLiveGenerator({ stateDir, fetchImpl, repo: REPO, label: LABEL });
    await expect(gen()).resolves.toBeNull();
  });

  it('a per-issue comment-fetch failure is isolated — other issues still process', async () => {
    const hash = 'e'.repeat(64);
    const fetchImpl = makeFakeFetch(
      [
        { number: 40, comments: [trustedComment(markerComment({ issueNumber: 40, hash }))] },
        { number: 41, comments: [trustedComment(markerComment({ issueNumber: 41, hash: 'f'.repeat(64) }))] },
      ],
      { failCommentsFor: [41] },
    );
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
    });
    const tasks = await gen();
    expect(tasks).toHaveLength(1);
    expect(tasks![0]!.eligibility).toMatchObject({ issue_number: 40 });
  });

  it('maxPerTick caps the number of tasks emitted per tick', async () => {
    const fetchImpl = makeFakeFetch(
      [50, 51, 52].map((n) => ({ number: n, comments: [trustedComment(markerComment({ issueNumber: n, hash: `${n}`.repeat(16) }))] })),
    );
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      maxPerTick: 2,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
    });
    const tasks = await gen();
    expect(tasks).toHaveLength(2);
  });

  it('solverNetManifestCid is threaded onto every emitted Task', async () => {
    const fetchImpl = makeFakeFetch([
      { number: 60, comments: [trustedComment(markerComment({ issueNumber: 60, hash: 'a1'.repeat(32) }))] },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      solverNetManifestCid: 'bafyLiveManifestCid',
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
    });
    const tasks = await gen();
    expect(tasks![0]!.solverNetManifestCid).toBe('bafyLiveManifestCid');
  });

  it('default posting window is exactly six hours on emitted task', async () => {
    const hash = 'e'.repeat(64);
    const fetchImpl = makeFakeFetch([
      {
        number: 42,
        comments: [trustedComment(markerComment({ issueNumber: 42, hash }))],
      },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
    });
    const tasks = await gen();
    expect(tasks).toHaveLength(1);
    expect(tasks![0]!.window.endTs - tasks![0]!.window.startTs).toBe(
      DEFAULT_POSTING_WINDOW_MS,
    );
  });

  it('postingWindowMs override appears as emitted window duration', async () => {
    const override = 7 * 60 * 60 * 1000;
    const hash = 'f'.repeat(64);
    const fetchImpl = makeFakeFetch([
      {
        number: 43,
        comments: [trustedComment(markerComment({ issueNumber: 43, hash }))],
      },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION],
      postingWindowMs: override,
    });
    const tasks = await gen();
    expect(tasks![0]!.window.endTs - tasks![0]!.window.startTs).toBe(override);
  });

  it('invalid postingWindowMs throws at construction (no silent fallback)', () => {
    const fetchImpl = makeFakeFetch([]);
    expect(() =>
      makeJinnRepoLiveGenerator({
        stateDir,
        fetchImpl,
        repo: REPO,
        label: LABEL,
        postingWindowMs: 0,
      }),
    ).toThrow(/postingWindowMs/);
    expect(() =>
      makeJinnRepoLiveGenerator({
        stateDir,
        fetchImpl,
        repo: REPO,
        label: LABEL,
        postingWindowMs: Number.NaN,
      }),
    ).toThrow(/postingWindowMs/);
  });
});

// ---------------------------------------------------------------------------
// Marker authorship trust (issue #1893 Finding 1 — CRITICAL)
// ---------------------------------------------------------------------------

describe('makeJinnRepoLiveGenerator — marker authorship trust', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'jinn-repo-live-gen-trust-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('fails closed: with no trust config at all, an otherwise-valid marker (even from a would-be-trusted-looking association) is ignored — no task posted', async () => {
    const hash = 'aa'.repeat(32);
    const fetchImpl = makeFakeFetch([
      { number: 90, comments: [trustedComment(markerComment({ issueNumber: 90, hash }), 'OWNER')] },
    ]);
    // No markerAuthorLogin, no markerTrustedAssociations configured.
    const gen = makeJinnRepoLiveGenerator({ stateDir, fetchImpl, repo: REPO, label: LABEL });
    await expect(gen()).resolves.toBeNull();
  });

  it('ignores a marker-shaped comment from an author outside the trusted association set — no task posted', async () => {
    const hash = 'bb'.repeat(32);
    // A differently-authored comment matching the marker shape byte-for-byte
    // (same schema, same fence) but authored by an account with no
    // relationship to the repo.
    const fetchImpl = makeFakeFetch([
      { number: 91, comments: [trustedComment(markerComment({ issueNumber: 91, hash }), 'NONE')] },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerTrustedAssociations: [TRUSTED_ASSOCIATION], // 'MEMBER' — comment's association is 'NONE'
    });
    await expect(gen()).resolves.toBeNull();
  });

  it('markerAuthorLogin: trusts an exact (case-insensitive) login match', async () => {
    const hash = 'cc'.repeat(32);
    const fetchImpl = makeFakeFetch([
      {
        number: 92,
        comments: [{ body: markerComment({ issueNumber: 92, hash }), user: { login: 'Jinn-Autopilot-Bot' } }],
      },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerAuthorLogin: 'jinn-autopilot-bot',
    });
    const tasks = await gen();
    expect(tasks).toHaveLength(1);
    expect(tasks![0]!.eligibility).toMatchObject({ issue_number: 92 });
  });

  it('markerAuthorLogin: a differently-authored comment matching the marker shape is IGNORED — no task posted', async () => {
    const hash = 'dd'.repeat(32);
    const fetchImpl = makeFakeFetch([
      {
        number: 93,
        comments: [{ body: markerComment({ issueNumber: 93, hash }), user: { login: 'random-attacker' } }],
      },
    ]);
    const gen = makeJinnRepoLiveGenerator({
      stateDir,
      fetchImpl,
      repo: REPO,
      label: LABEL,
      markerAuthorLogin: 'jinn-autopilot-bot',
    });
    await expect(gen()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// makeJinnRepoLiveGeneratorForLaunchedRecord — launched-record gate
// ---------------------------------------------------------------------------

describe('makeJinnRepoLiveGeneratorForLaunchedRecord', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'jinn-repo-live-gen-record-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function record(overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
    return {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: '5474_jinn-repo-v1_abc12345',
      manifestCid: 'bafyLiveRecordManifest',
      manifestHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
      launcherAgentId: '5474',
      launcherSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      launchedAt: FIXED_NOW_ISO,
      status: 'launched',
      statusUpdatedAt: FIXED_NOW_ISO,
      generatorEnabled: true,
      registry: { metadataTxHash: `0x${'bb'.repeat(32)}` as `0x${string}`, metadataBlockNumber: 1 },
      ...overrides,
    };
  }

  it('returns null when the record is not launched', async () => {
    const recordRef = { current: record({ status: 'paused' }) };
    const gen = makeJinnRepoLiveGeneratorForLaunchedRecord({
      recordRef,
      staticConfig: { stateDir, fetchImpl: makeFakeFetch([{ number: 70, comments: [] }]) },
    });
    await expect(gen()).resolves.toBeNull();
  });

  it('returns null when generatorEnabled is false', async () => {
    const recordRef = { current: record({ generatorEnabled: false }) };
    const gen = makeJinnRepoLiveGeneratorForLaunchedRecord({
      recordRef,
      staticConfig: { stateDir, fetchImpl: makeFakeFetch([{ number: 71, comments: [] }]) },
    });
    await expect(gen()).resolves.toBeNull();
  });

  it('threads recordRef.manifestCid onto emitted tasks when launched + enabled', async () => {
    const hash = 'c1'.repeat(32);
    const recordRef = { current: record({ manifestCid: 'bafyThreadedManifest' }) };
    const gen = makeJinnRepoLiveGeneratorForLaunchedRecord({
      recordRef,
      staticConfig: {
        stateDir,
        fetchImpl: makeFakeFetch([{ number: 80, comments: [trustedComment(markerComment({ issueNumber: 80, hash }))] }]),
        markerTrustedAssociations: [TRUSTED_ASSOCIATION],
      },
    });
    const tasks = await gen();
    expect(Array.isArray(tasks) ? tasks[0]!.solverNetManifestCid : undefined).toBe('bafyThreadedManifest');
  });

  it('throws when generatorConfig.posting_window_ms is invalid and staticConfig omits postingWindowMs', () => {
    expect(() =>
      makeJinnRepoLiveGeneratorForLaunchedRecord({
        recordRef: {
          current: record({ generatorConfig: { posting_window_ms: 'fast' } }),
        },
        staticConfig: { stateDir, fetchImpl: makeFakeFetch([]) },
      }),
    ).toThrow(/postingWindowMs/);
  });

  it('staticConfig.postingWindowMs wins over invalid generatorConfig.posting_window_ms', () => {
    expect(() =>
      makeJinnRepoLiveGeneratorForLaunchedRecord({
        recordRef: {
          current: record({ generatorConfig: { posting_window_ms: 0 } }),
        },
        staticConfig: {
          stateDir,
          fetchImpl: makeFakeFetch([]),
          postingWindowMs: 8 * 60 * 60 * 1000,
        },
      }),
    ).not.toThrow();
  });

  it('generatorConfig.posting_window_ms override appears on emitted window when static omits it', async () => {
    const override = 7 * 60 * 60 * 1000;
    const hash = 'a2'.repeat(32);
    const gen = makeJinnRepoLiveGeneratorForLaunchedRecord({
      recordRef: {
        current: record({
          generatorConfig: { posting_window_ms: override },
        }),
      },
      staticConfig: {
        stateDir,
        fetchImpl: makeFakeFetch([
          {
            number: 81,
            comments: [
              trustedComment(markerComment({ issueNumber: 81, hash })),
            ],
          },
        ]),
        markerTrustedAssociations: [TRUSTED_ASSOCIATION],
      },
    });
    const tasks = await gen();
    const task = Array.isArray(tasks) ? tasks[0]! : tasks!;
    expect(task.window.endTs - task.window.startTs).toBe(override);
  });
});
