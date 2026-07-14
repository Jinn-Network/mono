import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  admitBuiltMintCandidates,
  buildCommitEchoMintCandidate,
  type ExplicitRecipeBootstrap,
} from '../../src/solver-types/_swe-rebench-v2-harvest.js';
import {
  HarvestStateStore,
  classifyHarvestFailure,
} from '../../src/solver-types/_swe-rebench-v2-harvest-state.js';
import { MintedPoolStore } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { EVAL_SEMANTICS_VERSION, ValidatedPoolStore } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { resolveHarvestRepoConfigs } from '../../src/daemon/harvest-loop.js';
import type { CommitEchoCandidate } from '../../src/solver-types/_swe-rebench-v2-commit-echo.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafy-explicit-v2'),
  fetchFromIpfs: vi.fn(),
}));

const sha = (input: string) => `sha256:${createHash('sha256').update(input).digest('hex')}` as `sha256:${string}`;
const base = 'a'.repeat(40);
const fix = 'b'.repeat(40);
const candidate: CommitEchoCandidate = {
  instance_id: 'acme__widget__echo-bbbbbbbbbbbb',
  repo: 'acme/widget',
  base_commit: base,
  fix_commit: fix,
  gold_patch: 'diff --git a/src/widget.ts b/src/widget.ts\n+return fixed',
  test_patch: 'diff --git a/test/widget.test.ts b/test/widget.test.ts\n+test fixed',
  test_paths: ['test/widget.test.ts'],
  language: 'typescript',
  problem_statement: 'fix widget',
};

const source: PoolTask = {
  instance_id: 'source', hf_dataset: 'source-dataset', hf_split: 'test', repo: 'acme/widget',
  base_commit: base, patch: 'source gold', test_patch: 'SOURCE TEST PATCH', language: 'python',
};

const sourceRow = {
  instance_id: 'source', repo: 'acme/widget', image_name: 'legacy:image',
  FAIL_TO_PASS: ['old'], PASS_TO_PASS: [], test_patch: 'SOURCE TEST PATCH',
  install_config: { install: ['pip install -e .'], test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
};

function report(passed: string[], failed: string[]): Awaited<ReturnType<EvalRunner['runEval']>> {
  return { passed, failed, passed_match: failed.length === 0, log: '', exitCode: 0 };
}

function differentialRunner(candidateUnderTest: CommitEchoCandidate): EvalRunner {
  return {
    runEval: vi.fn(async (request) => {
      const command = Array.isArray(request.test_cmd) ? request.test_cmd.join(' ') : request.test_cmd;
      const testPath = candidateUnderTest.test_paths.find((path) => command.includes(path));
      const assertion = `${testPath ?? 'unscoped'} regression`;
      return {
        ...(request.patch === candidateUnderTest.gold_patch
          ? report([assertion], [])
          : report([], [assertion])),
        imageDigest: sha('observed-image'),
      };
    }),
  };
}

function explicitBootstrap(parserDigest = sha('parser')): ExplicitRecipeBootstrap {
  const parser = { id: 'vitest-json.v1', version: '1', digest: parserDigest, bundleId: 'swe-rebench-v2-evaluator.bundle.v1' };
  const imageDigest = sha('image');
  return {
    recipe: {
      schemaVersion: 'jinn.environment-build-recipe.v1',
      recipeId: 'acme-widget.v1',
      source: { repo: 'acme/widget', repoUrl: 'https://github.com/acme/widget.git', baseCommit: base },
      platform: 'linux/amd64',
      baseImage: { reference: `node:22@${imageDigest}`, digest: imageDigest },
      workspace: '/testbed',
      installCommands: [{ bin: 'yarn', args: ['install', '--immutable'] }],
      smokeCommands: [{ bin: 'yarn', args: ['test', '--version'] }],
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json'] }],
      parser,
      inputRights: [{ inputRef: `git+https://github.com/acme/widget.git#${base}`, rightsRef: 'https://github.com/acme/widget', basis: 'spdx', spdxId: 'MIT' }],
      timeoutSeconds: 300,
      environment: {},
    },
    environment: {
      environmentSpecCid: 'bafyenvironment', environmentHash: sha('environment'),
      attestation: { scheme: 'eip191', algo: 'secp256k1', environmentHash: sha('environment'), operatorSafe: '0x0000000000000000000000000000000000000001', signer: '0x0000000000000000000000000000000000000002', signature: `0x${'0'.repeat(130)}` },
      parser,
      image: { reference: `ghcr.io/jinn-network/task-environment@${imageDigest}`, digest: imageDigest },
      platform: 'linux/amd64',
    },
  };
}

describe('public-repository commit-echo bootstrap', () => {
  it('keeps the commit candidate test patch and language instead of borrowing the source row', async () => {
    const runner: EvalRunner = { runEval: vi.fn()
      .mockResolvedValueOnce(report([], ['test fixed']))
      .mockResolvedValueOnce(report(['test fixed'], [])) };
    const fetcher = { fetchTaskRow: vi.fn().mockResolvedValue(sourceRow) };
    const result = await buildCommitEchoMintCandidate({ candidate, source, fetcher, runner });

    expect(result.built?.row.test_patch).toBe(candidate.test_patch);
    expect(result.built?.poolTask.test_patch).toBe(candidate.test_patch);
    expect(result.built?.poolTask.language).toBe('typescript');
    expect(runner.runEval).toHaveBeenNthCalledWith(1, expect.objectContaining({ test_patch: candidate.test_patch }));
    expect(result.built?.environment).toBeUndefined();
  });

  it('uses an explicit trusted recipe as a v2 bootstrap without a Rebench source row', async () => {
    const runner = differentialRunner(candidate);
    const fetcher = { fetchTaskRow: vi.fn() };
    const bootstrap = explicitBootstrap();
    const result = await buildCommitEchoMintCandidate({ candidate, explicitRecipe: bootstrap, fetcher, runner });

    expect(fetcher.fetchTaskRow).not.toHaveBeenCalled();
    expect(result.built?.environment).toEqual(bootstrap.environment);
    expect(result.built?.row.image_name).toBe(bootstrap.environment.image.reference);
    expect(result.built?.row.install_config.log_parser).toBe('vitest-json.v1');
    expect(result.built?.poolTask.language).toBe('typescript');
    expect(result.built?.differentialAdmission?.receipt.testPaths).toHaveLength(1);
    expect(runner.runEval).toHaveBeenCalledTimes(4);
  });

  it('strictly parses a configured explicit bootstrap into the harvest repo config', async () => {
    const bootstrap = explicitBootstrap();
    const configs = await resolveHarvestRepoConfigs([{
      path: '/fixture/acme-widget',
      repo: 'acme/widget',
      explicitRecipe: bootstrap,
    }]);
    expect(configs[0]?.explicitRecipe).toEqual(bootstrap);
  });

  it('collects two broken and two fixed runs per path without reusing V1 empirical evidence', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'bound-empirical-'));
    try {
      const state = new HarvestStateStore({ stateDir });
      const twoPathCandidate: CommitEchoCandidate = {
        ...candidate,
        test_paths: ['test/widget.test.ts', 'test/other.test.ts'],
        test_patch: `${candidate.test_patch}\ndiff --git a/test/other.test.ts b/test/other.test.ts\n+test other`,
      };
      const runner = differentialRunner(twoPathCandidate);
      const bootstrap = explicitBootstrap();
      const first = await buildCommitEchoMintCandidate({ candidate: twoPathCandidate, explicitRecipe: bootstrap, fetcher: { fetchTaskRow: vi.fn() }, runner, empiricalEvidenceStore: state });
      const second = await buildCommitEchoMintCandidate({ candidate: twoPathCandidate, explicitRecipe: bootstrap, fetcher: { fetchTaskRow: vi.fn() }, runner, empiricalEvidenceStore: state });

      expect(first.built?.differentialAdmission?.receipt.testPaths).toHaveLength(2);
      expect(first.built?.differentialAdmission?.receipt.testPaths.every((path) => path.broken.length === 2 && path.fixed.length === 2)).toBe(true);
      expect(second.built).not.toBeNull();
      // A stale V1 cache entry cannot satisfy repeated path-scoped evidence.
      expect(runner.runEval).toHaveBeenCalledTimes(16);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('leaves unsupported multi-template public-repo recipes awaiting input', async () => {
    const bootstrap = explicitBootstrap();
    bootstrap.recipe.testCommands.push({ bin: 'yarn', args: ['vitest', 'run', '--reporter=json'] });

    const result = await buildCommitEchoMintCandidate({
      candidate,
      explicitRecipe: bootstrap,
      fetcher: { fetchTaskRow: vi.fn() },
      runner: differentialRunner(candidate),
    });

    expect(result.built).toBeNull();
    expect(result.reason).toMatch(/^awaiting_input:unsupported-test-targeting:/);
    expect(classifyHarvestFailure(result.reason!)).toBe('awaiting_input');
  });

  it('leaves an unsafe test path awaiting input before it reaches the evaluator', async () => {
    const result = await buildCommitEchoMintCandidate({
      candidate: { ...candidate, test_paths: ['../outside.test.ts'] },
      explicitRecipe: explicitBootstrap(),
      fetcher: { fetchTaskRow: vi.fn() },
      runner: differentialRunner(candidate),
    });

    expect(result.built).toBeNull();
    expect(result.reason).toMatch(/^awaiting_input:unsupported-test-targeting:/);
  });

  it('quarantines unstable repeated observations instead of accepting a weak policy result', async () => {
    const runner: EvalRunner = {
      runEval: vi.fn()
        .mockResolvedValueOnce(report([], ['first broken']))
        .mockResolvedValueOnce(report([], ['second broken']))
        .mockResolvedValueOnce(report(['first broken'], []))
        .mockResolvedValueOnce(report(['first broken'], [])),
    };

    const result = await buildCommitEchoMintCandidate({
      candidate,
      explicitRecipe: explicitBootstrap(),
      fetcher: { fetchTaskRow: vi.fn() },
      runner,
    });

    expect(result.built).toBeNull();
    expect(result.reason).toMatch(/^flaky\/non-reproducible:/);
    expect(classifyHarvestFailure(result.reason!)).toBe('quarantined');
  });

  it('publishes an explicit bootstrap as a v2 artifact while leaving the v1 contract untouched', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'explicit-v2-mint-'));
    try {
      execFileSync('git', ['init'], { cwd: stateDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: stateDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: stateDir });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: stateDir });
      const runner = differentialRunner(candidate);
      const built = await buildCommitEchoMintCandidate({
        candidate,
        explicitRecipe: explicitBootstrap(),
        fetcher: { fetchTaskRow: vi.fn() },
        runner,
      });
      expect(built.built).not.toBeNull();

      const mintedStore = new MintedPoolStore({ stateDir });
      const checkpoints: string[] = [];
      const result = await admitBuiltMintCandidates([built.built!], {
        stateDir,
        ipfsRegistryUrl: 'https://registry.example',
        ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir }),
        mintedStore,
        hfFetcher: { fetchTaskRow: vi.fn() },
        runner,
        upstreamRepoDir: stateDir,
        publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: {
          verify: async () => {
            const bootstrap = explicitBootstrap();
            return {
              source: bootstrap.recipe.source,
              execution: {
                platform: bootstrap.environment.platform,
                workspace: bootstrap.recipe.workspace,
                image: bootstrap.environment.image,
                testCommands: bootstrap.recipe.testCommands,
                parser: bootstrap.environment.parser,
                timeoutSeconds: bootstrap.recipe.timeoutSeconds,
                environment: bootstrap.recipe.environment,
              },
              attestation: bootstrap.environment.attestation,
            } as unknown as import('../../src/task-creator/environment/contracts.js').TaskEnvironmentSpecV1;
          },
        },
        publish: true,
        progress: {
          onAdmissionStored: async ({ instanceId }) => { checkpoints.push(`admission:${instanceId}`); },
          onIpfsPublished: async ({ artifactCid, rowHashVersion }) => { checkpoints.push(`ipfs:${rowHashVersion}:${artifactCid}`); },
        },
      });

      expect(result.rejected).toEqual([]);
      expect(result.admitted).toEqual([candidate.instance_id]);
      expect(result.artifactCids?.[2]).toBe('ipfs://bafy-explicit-v2');
      expect(await mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, 1)).toBeNull();
      expect(await mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, 2)).toBe('bafy-explicit-v2');
      expect((await mintedStore.exportArtifactV2(EVAL_SEMANTICS_VERSION)).rows[0]?.environment).toEqual(explicitBootstrap().environment);
      expect((await mintedStore.exportArtifactV2(EVAL_SEMANTICS_VERSION)).rows[0]?.fix_commit).toBe(candidate.fix_commit);
      expect(checkpoints).toEqual([
        `admission:${candidate.instance_id}`,
        'ipfs:2:bafy-explicit-v2',
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
