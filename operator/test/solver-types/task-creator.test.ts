/**
 * Tests for task-creator guards, yield, hunk-echo, routing fetcher.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertPublicRepoForPublish,
  assertRepoAllowedForMint,
  contestedBandDistance,
  createGitHubPublicRepoChecker,
  inInformativeBand,
  loadMintRepoDenylist,
  type PublicRepoChecker,
} from '../../src/solver-types/_swe-rebench-v2-guards.js';
import { computeExemplarPairYield } from '../../src/solver-types/_swe-rebench-v2-yield.js';
import {
  buildHunkSubsetEcho,
  splitPatchHunks,
} from '../../src/solver-types/_swe-rebench-v2-hunk-echo.js';
import { deriveF2pP2pFromReports } from '../../src/solver-types/_swe-rebench-v2-empirical-tests.js';
import { RoutingTaskRowFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import {
  CAPABILITY_SLATE_SCHEMA_VERSION,
  hashCapabilitySlate,
  loadCapabilitySlateRepos,
  type CapabilitySlateArtifact,
} from '../../src/eval/capability-slate.js';

/** Minimal valid cap-v0 fixture — shape parseCapabilitySlate accepts (mirrors
 * operator/test/eval/capability-slate.test.ts's `valid` fixture). */
function buildCapSlateFixture(repo: string): CapabilitySlateArtifact {
  return {
    schemaVersion: CAPABILITY_SLATE_SCHEMA_VERSION,
    solverType: 'swe-rebench-v2.v1',
    version: 'cap-v0',
    generatedAt: '2026-07-06T00:00:00.000Z',
    evalSemanticsVersion: '4',
    instances: [
      {
        instance_id: `${repo.replace('/', '__')}-1`,
        repo,
        rowHash: 'sha256:aa',
        imageDigest: 'sha256:bb',
        stockPassRate: 0.33,
        screening: { agentSha: 'deadbeef', emptyLoadout: true, noCorpusTools: true, hostSkillDirHash: 'sha256:empty' },
      },
    ],
    construction: 'contested-band[0.15,0.85], stock=haiku, R=3, repo-stratified',
    corpusSnapshotCid: 'ipfs://root',
    corpusDerivedIndexCid: 'ipfs://index',
    loadoutFrozenBeforeSlate: true,
    disjointness: {
      instance: { verdict: 'pass', flaggedPairs: [] },
      repo: { verdict: 'pass', flaggedPairs: [] },
      lexical: { verdict: 'pass', flaggedPairs: [], attestation: 'self-attested' },
      semantic: { verdict: 'n/a-v0', model: null, threshold: null, flaggedPairs: [] },
    },
  };
}

describe('task-creator guards', () => {
  it('rejects mint from held-out slate repo, keyed on repo not instance_id', () => {
    const denylist = loadMintRepoDenylist();
    // Fail loud rather than soft-skip (#1485 review): the active slates must resolve
    // to at least one repo, else this regression guard silently passes and a slate
    // repo could be minted. AC5 depends on the denylist actually being populated.
    expect(denylist.repos.size).toBeGreaterThan(0);
    const repo = [...denylist.repos][0]!;
    expect(() => assertRepoAllowedForMint(repo, denylist)).toThrow(/held-out/);
    // Refusal keys on the repo, so a fresh, never-seen instance_id derived from the
    // same slate repo is refused too — exclusion cannot be dodged with a new id.
    expect(() => assertRepoAllowedForMint(repo, denylist)).toThrow(/held-out/);
  });

  it('blocks publishing a task from a private repo (D5, AC6)', async () => {
    const privateChecker: PublicRepoChecker = { isPublic: async () => false };
    await expect(
      assertPublicRepoForPublish('acme/private-service', privateChecker),
    ).rejects.toThrow(/not public/);
  });

  it('allows publishing a task from a public repo (D5, AC6)', async () => {
    const publicChecker: PublicRepoChecker = { isPublic: async () => true };
    await expect(
      assertPublicRepoForPublish('pandas-dev/pandas', publicChecker),
    ).resolves.toBeUndefined();
  });

  it('does not cache repository visibility across publication checks', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ private: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ private: true }) });
    const checker = createGitHubPublicRepoChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(checker.isPublic('acme/widget')).resolves.toBe(true);
    await expect(checker.isPublic('acme/widget')).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['malformed JSON', async () => { throw new SyntaxError('bad JSON'); }],
    ['missing private field', async () => ({ full_name: 'acme/widget' })],
    ['non-object JSON', async () => null],
  ])('fails closed on a successful GitHub response with %s', async (_label, json) => {
    const checker = createGitHubPublicRepoChecker({
      fetchImpl: (async () => ({ ok: true, json })) as unknown as typeof fetch,
    });

    await expect(checker.isPublic('acme/widget')).resolves.toBe(false);
  });

  it('rejects non-canonical repository slugs without making an API request', async () => {
    const fetchImpl = vi.fn();
    const checker = createGitHubPublicRepoChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(checker.isPublic('acme/widget/extra')).resolves.toBe(false);
    await expect(checker.isPublic('acme')).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('contested band prefers 50% solve rate', () => {
    expect(contestedBandDistance(0.5)).toBeLessThan(contestedBandDistance(0.1));
    expect(inInformativeBand(0.5)).toBe(true);
    expect(inInformativeBand(0.05)).toBe(false);
  });

  it('unions cap-v0 capability-slate repos into the mint denylist (spec §11)', () => {
    const slateRepo = 'acme/capslate-target';
    const untouchedRepo = 'acme/not-on-any-slate';
    const dir = mkdtempSync(join(tmpdir(), 'cap-slate-'));
    try {
      const fixture = buildCapSlateFixture(slateRepo);
      const hash = hashCapabilitySlate(fixture);
      writeFileSync(
        join(dir, 'capability-slate.cap-v0.json'),
        JSON.stringify({ ...fixture, hash }),
        'utf8',
      );

      const capRepos = loadCapabilitySlateRepos(dir);
      expect(capRepos.has(slateRepo)).toBe(true);
      expect(capRepos.has(untouchedRepo)).toBe(false);

      const denylist = loadMintRepoDenylist({ capabilitySlatesDir: dir });
      expect(denylist.repos.has(slateRepo)).toBe(true);
      expect(denylist.repos.has(untouchedRepo)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exemplar pair yield', () => {
  it('counts instances with both pass and fail', () => {
    const report = computeExemplarPairYield([
      { instanceId: 'a', passes: 1, fails: 1 },
      { instanceId: 'b', passes: 1, fails: 0 },
    ]);
    expect(report.exemplarPairs).toBe(1);
  });
});

describe('hunk-subset echo', () => {
  it('builds echo candidate from hunk', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const hunks = splitPatchHunks(patch);
    expect(hunks.length).toBeGreaterThan(0);
    const echo = buildHunkSubsetEcho({
      sourceInstanceId: 'acme__widget-1',
      repo: 'acme/widget',
      solverPatch: patch,
      hunk: hunks[0]!,
      baseCommit: 'abc',
    });
    expect(echo.instance_id).toContain('hunk-');
  });
});

describe('empirical F2P/P2P', () => {
  it('derives flip tests', () => {
    const r = deriveF2pP2pFromReports(
      { passed: ['t1'], failed: ['t2'], passed_match: false },
      { passed: ['t1', 't2'], failed: [], passed_match: true },
      ['t1', 't2'],
    );
    expect(r.FAIL_TO_PASS).toEqual(['t2']);
    expect(r.dead).toBe(false);
  });
});

describe('RoutingTaskRowFetcher', () => {
  it('fetches minted rows from ipfs artifact', async () => {
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: async () => { throw new Error('hf'); } },
      fetchMintedArtifact: async () => ({
        schemaVersion: 'swe-rebench-v2-minted-pool.v1',
        evalSemanticsVersion: '4',
        generatedAt: new Date().toISOString(),
        rows: [{
          instance_id: 'mint-1',
          repo: 'acme/widget',
          image_name: 'img:tag',
          FAIL_TO_PASS: ['t1'],
          PASS_TO_PASS: [],
          test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        }],
      }),
    });
    const row = await fetcher.fetchTaskRow({
      hf_dataset: 'ipfs://bafytest',
      hf_split: 'minted',
      instance_id: 'mint-1',
    });
    expect(row.repo).toBe('acme/widget');
  });
});
