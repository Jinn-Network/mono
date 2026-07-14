import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { runHarvestTick, type HarvestLoopConfig } from '../../src/daemon/harvest-loop.js';
import { repoSlugFromRemoteUrl } from '../../src/solver-types/_swe-rebench-v2-commit-echo-git.js';
import { HarvestStateStore } from '../../src/solver-types/_swe-rebench-v2-harvest-state.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import { ValidatedPoolStore, EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { MintedPoolStore } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { MineableTraceStore, type MineableTraceRecord } from '../../src/solver-types/_swe-rebench-v2-mineable-store.js';
import type { ExplicitRecipeBootstrap } from '../../src/solver-types/_swe-rebench-v2-harvest.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { EvalRunner, HfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import type { MintedEnvironmentVerifier } from '../../src/solver-types/_swe-rebench-v2-minted-environment-verifier.js';
import type { TaskEnvironmentSpecV1 } from '../../src/task-creator/environment/contracts.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafy-ipfs-checkpoint'),
  fetchFromIpfs: vi.fn(),
}));

const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;

function explicitBootstrap(baseCommit: string, parserDigest = digest): ExplicitRecipeBootstrap {
  const parser = { id: 'vitest-json.v1', version: '1', digest: parserDigest, bundleId: 'swe-rebench-v2-evaluator.bundle.v1' };
  return {
    recipe: {
      schemaVersion: 'jinn.environment-build-recipe.v1', recipeId: 'acme-widget.v1',
      source: { repo: 'acme/widget', repoUrl: 'https://github.com/acme/widget.git', baseCommit },
      platform: 'linux/amd64', baseImage: { reference: `node:22@${digest}`, digest }, workspace: '/testbed',
      installCommands: [{ bin: 'yarn', args: ['install', '--immutable'] }],
      smokeCommands: [{ bin: 'yarn', args: ['test', '--version'] }],
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json'] }],
      parser,
      inputRights: [{ inputRef: `git+https://github.com/acme/widget.git#${baseCommit}`, rightsRef: 'https://github.com/acme/widget', basis: 'spdx', spdxId: 'MIT' }],
      timeoutSeconds: 300, environment: {},
    },
    environment: {
      environmentSpecCid: 'bafyenvironment', environmentHash: digest,
      attestation: { scheme: 'eip191', algo: 'secp256k1', environmentHash: digest, operatorSafe: '0x0000000000000000000000000000000000000001', signer: '0x0000000000000000000000000000000000000002', signature: `0x${'0'.repeat(130)}` },
      parser, image: { reference: `ghcr.io/jinn-network/task-environment@${digest}`, digest }, platform: 'linux/amd64',
    },
  };
}

function report(passed: string[], failed: string[]): Awaited<ReturnType<EvalRunner['runEval']>> {
  return { passed, failed, passed_match: failed.length === 0, log: '', exitCode: 0 };
}

/** Mint CLI verification is independently covered; loop tests need its trusted output. */
const testEnvironmentVerifier: MintedEnvironmentVerifier = {
  async verify({ binding, poolTask }): Promise<TaskEnvironmentSpecV1> {
    return {
      source: {
        repo: poolTask.repo!,
        repoUrl: `https://github.com/${poolTask.repo}.git`,
        baseCommit: poolTask.base_commit!,
      },
      execution: {
        platform: binding.platform,
        workspace: '/testbed',
        image: binding.image,
        testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json'] }],
        parser: binding.parser,
        timeoutSeconds: 300,
        environment: {},
      },
      attestation: binding.attestation,
    } as TaskEnvironmentSpecV1;
  },
};

function queueHardenedEvidence(mock: ReturnType<typeof vi.fn>): void {
  mock
    .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']))
    .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']))
    .mockResolvedValueOnce(report(['widget.test.ts::testValue'], []))
    .mockResolvedValueOnce(report(['widget.test.ts::testValue'], []));
}

function queueHardenedAdmissionRun(mock: ReturnType<typeof vi.fn>): void {
  queueHardenedEvidence(mock);
  mock
    .mockResolvedValueOnce({ ...report(['widget.test.ts::testValue'], []), imageDigest: digest })
    .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']));
}

describe('runHarvestTick', () => {
  it('skips before discovery when Docker is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-skip-'));
    try {
      const result = await runHarvestTick({
        intervalMs: 60_000,
        stateDir: dir,
        repos: [{ path: '/tmp/repo', repo: 'acme/widget' }],
        limitPerRepo: 1,
        publish: false,
        isDockerAvailable: () => false,
        mintDeps: {
          stateDir: dir,
          ipfsRegistryUrl: 'https://registry.example',
          ipfsGatewayUrl: 'https://gateway.example',
          validatedStore: new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir }),
          mintedStore: new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir }),
          hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
          runner: { runEval: async () => { throw new Error('unused'); } },
          upstreamRepoDir: dir,
          publicRepoChecker: { isPublic: async () => true },
        },
      });
      expect(result.skipped).toContain('docker-unavailable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records an unconfigured public repo as awaiting_input rather than rejecting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-awaiting-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const snapshot = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      const state = new HarvestStateStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', snapshot);
      const result = await runHarvestTick({
        intervalMs: 60_000,
        stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget' }],
        limitPerRepo: 1,
        publish: false,
        isDockerAvailable: () => true,
        harvestState: state,
        loadPool: async () => [],
        mintDeps: {
          stateDir: dir,
          ipfsRegistryUrl: 'https://registry.example',
          ipfsGatewayUrl: 'https://gateway.example',
          validatedStore: new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir }),
          mintedStore: new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir }),
          hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
          runner: { runEval: async () => { throw new Error('unused'); } },
          upstreamRepoDir: dir,
          publicRepoChecker: { isPublic: async () => true },
        },
      });
      expect(result.rejected).toEqual([]);
      expect(result.awaitingInput[0]?.instance_id).toContain('acme__widget__echo-');
      expect((await state.getJob(`task:acme/widget@${fix}`))?.disposition).toBe('awaiting_input');
      expect((await state.getRepo('acme/widget'))?.lastScannedCommit).toBe(fix);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resumes an awaiting job after explicit config arrives without rediscovering or rolling back the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-resume-config-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      const state = new HarvestStateStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', base);
      const runner: EvalRunner = { runEval: vi.fn() };
      const validatedStore = new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir });
      const mintedStore = new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir });
      const mintDeps = {
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore, mintedStore, hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true }, environmentVerifier: testEnvironmentVerifier,
      };

      const first = await runHarvestTick({
        intervalMs: 60_000, stateDir: dir, repos: [{ path: dir, repo: 'acme/widget' }], limitPerRepo: 1,
        publish: false, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
      });
      expect(first.awaitingInput).toHaveLength(1);
      expect((await state.getRepo('acme/widget'))?.lastScannedCommit).toBe(fix);

      queueHardenedAdmissionRun(runner.runEval as ReturnType<typeof vi.fn>);
      const second = await runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: explicitBootstrap(base) }], limitPerRepo: 1,
        publish: true, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
      });
      expect(second.discovered).toBe(0);
      expect(second.admitted).toHaveLength(1);
      expect((await state.getRepo('acme/widget'))?.lastScannedCommit).toBe(fix);
      expect((await state.getJob(`task:acme/widget@${fix}`))?.disposition).toBe('admitted');
      expect(runner.runEval).toHaveBeenCalledTimes(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a missing-test-patch job awaiting when a later explicit recipe matches its repo/base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-no-test-requeue-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      const fix = 'b'.repeat(40);
      const state = new HarvestStateStore({ stateDir: dir });
      await state.persistDiscoveredJobs({
        repo: 'acme/widget',
        cursor: base,
        candidates: [{
          instance_id: 'acme__widget__echo-no-test', repo: 'acme/widget', base_commit: base, fix_commit: fix,
          gold_patch: 'diff --git a/widget.ts b/widget.ts', test_patch: '', test_paths: [],
          language: 'typescript', problem_statement: 'fix widget',
        }],
      });
      await state.markJobFailure(
        `task:acme/widget@${fix}`,
        'awaiting_input:test-patch-required: commit carries no regression test patch',
      );
      const result = await runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: explicitBootstrap(base) }], limitPerRepo: 1,
        publish: false, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [],
        mintDeps: {
          stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
          validatedStore: new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir }),
          mintedStore: new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir }),
          hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
          runner: { runEval: async () => { throw new Error('must not run'); } },
          upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        },
      });
      expect(result.discovered).toBe(0);
      expect(result.admitted).toEqual([]);
      expect(await state.getJob(`task:acme/widget@${fix}`)).toMatchObject({
        disposition: 'awaiting_input',
        reason: 'awaiting_input:test-patch-required: commit carries no regression test patch',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finishes a restart after the durable IPFS checkpoint without rerunning empirical or admission work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-ipfs-restart-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      class CrashAfterIpfsCheckpointStore extends HarvestStateStore {
        private crash = true;

        override async updateJob(...args: Parameters<HarvestStateStore['updateJob']>) {
          const job = await super.updateJob(...args);
          if (args[1].stage === 'ipfs' && this.crash) {
            this.crash = false;
            throw new Error('simulated crash after ipfs checkpoint');
          }
          return job;
        }
      }
      const state = new CrashAfterIpfsCheckpointStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', base);
      const runner: EvalRunner = { runEval: vi.fn() };
      queueHardenedAdmissionRun(runner.runEval as ReturnType<typeof vi.fn>);
      const validatedStore = new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir });
      const mintedStore = new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir });
      const mintDeps = {
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore, mintedStore, hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true }, environmentVerifier: testEnvironmentVerifier,
      };
      const run = (now: number) => runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: explicitBootstrap(base) }], limitPerRepo: 1,
        publish: true, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
        now: () => now,
      });

      const interrupted = await run(0);
      expect(interrupted.admitted).toEqual([]);
      const checkpointed = await state.getJob(`task:acme/widget@${fix}`);
      expect(checkpointed).toMatchObject({ stage: 'ipfs', disposition: 'retrying' });
      expect(checkpointed?.artifactRefs).toMatchObject({
        recipeId: 'acme-widget.v1',
        imageReference: `ghcr.io/jinn-network/task-environment@${digest}`,
        environmentSpecCid: 'bafyenvironment',
        environmentHash: digest,
        admissionInstanceId: expect.stringContaining('acme__widget__echo-'),
        mintedArtifactCid: 'bafy-ipfs-checkpoint',
      });
      expect(checkpointed?.resourceUse).toMatchObject({
        empiricalDurationMs: expect.any(Number),
        admissionDurationMs: expect.any(Number),
        ipfsDurationMs: expect.any(Number),
      });
      expect(runner.runEval).toHaveBeenCalledTimes(6);

      const recovered = await run(60_000);
      expect(recovered.discovered).toBe(0);
      expect(recovered.admitted).toHaveLength(1);
      expect((await state.getJob(`task:acme/widget@${fix}`))?.disposition).toBe('admitted');
      expect(runner.runEval).toHaveBeenCalledTimes(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes a restart from a bound admission checkpoint without rerunning empirical or validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-admission-restart-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      class CrashAfterAdmissionCheckpointStore extends HarvestStateStore {
        private crash = true;

        override async updateJob(...args: Parameters<HarvestStateStore['updateJob']>) {
          const job = await super.updateJob(...args);
          if (args[1].stage === 'admission' && this.crash) {
            this.crash = false;
            throw new Error('simulated crash after admission checkpoint');
          }
          return job;
        }
      }
      const state = new CrashAfterAdmissionCheckpointStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', base);
      const runner: EvalRunner = { runEval: vi.fn() };
      queueHardenedAdmissionRun(runner.runEval as ReturnType<typeof vi.fn>);
      const validatedStore = new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir });
      const mintedStore = new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir });
      const mintDeps = {
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore, mintedStore, hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true }, environmentVerifier: testEnvironmentVerifier,
      };
      const run = (now: number) => runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: explicitBootstrap(base) }], limitPerRepo: 1,
        publish: true, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
        now: () => now,
      });

      await run(0);
      expect(await state.getJob(`task:acme/widget@${fix}`)).toMatchObject({ stage: 'admission', disposition: 'retrying' });
      expect(runner.runEval).toHaveBeenCalledTimes(6);

      const recovered = await run(60_000);
      expect(recovered.admitted).toHaveLength(1);
      expect((await state.getJob(`task:acme/widget@${fix}`))?.disposition).toBe('admitted');
      expect(runner.runEval).toHaveBeenCalledTimes(6);
      expect(await mintedStore.getPublishedArtifactCid('4', 2)).toBe('bafy-ipfs-checkpoint');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses a persisted hardened differential receipt after an empirical checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-empirical-restart-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      class CrashAfterEmpiricalCheckpointStore extends HarvestStateStore {
        private crash = true;

        override async updateJob(...args: Parameters<HarvestStateStore['updateJob']>) {
          const job = await super.updateJob(...args);
          if (args[1].resourceUse?.['empiricalDurationMs'] !== undefined && this.crash) {
            this.crash = false;
            throw new Error('simulated crash after empirical checkpoint');
          }
          return job;
        }
      }
      const state = new CrashAfterEmpiricalCheckpointStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', base);
      vi.mocked(uploadToIpfs).mockClear();
      const runner: EvalRunner = { runEval: vi.fn() };
      queueHardenedEvidence(runner.runEval as ReturnType<typeof vi.fn>);
      const validatedStore = new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir });
      const mintedStore = new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir });
      const mintDeps = {
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore, mintedStore, hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true }, environmentVerifier: testEnvironmentVerifier,
      };
      const run = (now: number, publish = false) => runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: explicitBootstrap(base) }], limitPerRepo: 1,
        publish, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
        now: () => now,
      });

      await run(0);
      expect(await state.getJob(`task:acme/widget@${fix}`)).toMatchObject({
        stage: 'empirical',
        disposition: 'retrying',
        differentialAdmission: {
          schemaVersion: 'swe-rebench-v2-differential-admission-evidence.v2',
          admissionPolicyVersion: 'swe-rebench-v2-differential-admission.v2',
          receiptHash: expect.stringMatching(/^sha256:/),
          receipt: expect.objectContaining({ schemaVersion: 'swe-rebench-v2-differential-admission-receipt.v2' }),
        },
      });
      expect(runner.runEval).toHaveBeenCalledTimes(4);

      (runner.runEval as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...report(['widget.test.ts::testValue'], []), imageDigest: digest })
        .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']));
      const recovered = await run(60_000);
      expect(recovered.admitted).toEqual([]);
      expect(recovered.awaitingInput).toEqual([expect.objectContaining({
        instance_id: expect.stringContaining('acme__widget__echo-'),
        reason: expect.stringMatching(/receipt-publication-required/i),
      })]);
      expect(await state.getJob(`task:acme/widget@${fix}`)).toMatchObject({
        disposition: 'awaiting_input',
        reason: expect.stringMatching(/receipt-publication-required/i),
        differentialAdmission: expect.objectContaining({
          receipt: expect.objectContaining({ schemaVersion: 'swe-rebench-v2-differential-admission-receipt.v2' }),
        }),
      });
      expect(uploadToIpfs).not.toHaveBeenCalled();
      // The V2 receipt is re-verified from durable state; no mint validation
      // should begin while its public receipt CID is absent.
      expect(runner.runEval).toHaveBeenCalledTimes(4);

      const published = await run(120_000, true);
      expect(published.admitted).toHaveLength(1);
      expect((await state.getJob(`task:acme/widget@${fix}`))?.disposition).toBe('admitted');
      // Published resumption reuses the durable receipt; only gold/known-bad
      // admission validation runs.
      expect(runner.runEval).toHaveBeenCalledTimes(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse an admission checkpoint when its parser binding changes; it reruns and quarantines a dead empirical result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-admission-binding-drift-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await writeFile(join(dir, 'widget.ts'), 'export const value = 0;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await writeFile(join(dir, 'widget.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'widget.test.ts'), 'export const testValue = () => value === 1; // regression\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'fix: correct widget value'], { cwd: dir });
      const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      class CrashAfterAdmissionCheckpointStore extends HarvestStateStore {
        private crash = true;

        override async updateJob(...args: Parameters<HarvestStateStore['updateJob']>) {
          const job = await super.updateJob(...args);
          if (args[1].stage === 'admission' && this.crash) {
            this.crash = false;
            throw new Error('simulated crash after admission checkpoint');
          }
          return job;
        }
      }
      const state = new CrashAfterAdmissionCheckpointStore({ stateDir: dir });
      await state.setLastScannedCommit('acme/widget', base);
      const runner: EvalRunner = { runEval: vi.fn() };
      queueHardenedAdmissionRun(runner.runEval as ReturnType<typeof vi.fn>);
      const validatedStore = new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir });
      const mintedStore = new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir });
      const mintDeps = {
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore, mintedStore, hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true }, environmentVerifier: testEnvironmentVerifier,
      };
      const run = (now: number, bootstrap: ExplicitRecipeBootstrap) => runHarvestTick({
        intervalMs: 60_000, stateDir: dir,
        repos: [{ path: dir, repo: 'acme/widget', explicitRecipe: bootstrap }], limitPerRepo: 1,
        publish: true, isDockerAvailable: () => true, harvestState: state, loadPool: async () => [], mintDeps,
        now: () => now,
      });

      await run(0, explicitBootstrap(base));
      const oldJob = await state.getJob(`task:acme/widget@${fix}`);
      expect(oldJob).toMatchObject({ stage: 'admission', disposition: 'retrying' });
      expect(runner.runEval).toHaveBeenCalledTimes(6);

      const parserDrift = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;
      (runner.runEval as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']))
        .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']))
        .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']))
        .mockResolvedValueOnce(report([], ['widget.test.ts::testValue']));
      const recovered = await run(60_000, explicitBootstrap(base, parserDrift));
      expect(recovered.quarantined).toHaveLength(1);
      expect(await state.getJob(`task:acme/widget@${fix}`)).toMatchObject({
        stage: 'empirical',
        disposition: 'quarantined',
      });
      expect((await state.getJob(`task:acme/widget@${fix}`))?.recipeHash).not.toBe(oldJob?.recipeHash);
      expect(runner.runEval).toHaveBeenCalledTimes(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('repoSlugFromRemoteUrl', () => {
  it('parses ssh and https remotes', () => {
    expect(repoSlugFromRemoteUrl('git@github.com:acme/widget.git')).toBe('acme/widget');
    expect(repoSlugFromRemoteUrl('https://github.com/acme/widget')).toBe('acme/widget');
  });
});

// ── Task 9: harvest.sources union (commit-echo + session-echo) ─────────────

const SESSION_REPO = 'acme/widget';
const SOURCE_INSTANCE = 'acme__widget-1';
const MINTER_SAFE = '0x00000000000000000000000000000000000000aa';
const OPERATOR_SAFE = '0x00000000000000000000000000000000000000bb';

const SOURCE_TASK: PoolTask = {
  instance_id: SOURCE_INSTANCE,
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2024_06',
  repo: SESSION_REPO,
  base_commit: 'sourcebase123',
  patch: 'source-gold-patch',
  test_patch: 'diff --git a/tests/test_x.py',
  language: 'python',
};

const SOURCE_HF_ROW = {
  instance_id: SOURCE_INSTANCE,
  repo: SESSION_REPO,
  image_name: 'acme/widget:img',
  FAIL_TO_PASS: ['tests/test_x.py::test_fix'],
  PASS_TO_PASS: ['tests/test_x.py::test_other'],
  test_patch: 'diff --git a/tests/test_x.py',
  install_config: {
    test_cmd: 'pytest tests/test_x.py',
    log_parser: 'parse_log_pytest',
    install: ['pip install -e .'],
  },
};

function makeSessionRecord(overrides: Partial<MineableTraceRecord> = {}): MineableTraceRecord {
  return {
    sourceId: 'session-secret-do-not-leak-abc123',
    kind: 'harness-session',
    repo: SESSION_REPO,
    baseCommit: 'basecommit456',
    acceptedDiff: 'diff --git a/src/x.py b/src/x.py\n+fix\n',
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: true,
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

const sessionHfFetcher: HfFetcher = {
  fetchTaskRow: async (args: { instance_id: string }) => {
    if (args.instance_id === SOURCE_INSTANCE) return SOURCE_HF_ROW;
    throw new Error(`unexpected hfFetcher.fetchTaskRow(${args.instance_id})`);
  },
};

/** Standard 4-call sequence: empirical before/after (not dead), gold
 *  admission (with imageDigest so `docker image inspect` is never hit),
 *  discrimination known-bad (must legitimately fail to admit). */
function makeSuccessfulSessionRunner(): EvalRunner {
  let call = 0;
  const responses = [
    { passed: ['tests/test_x.py::test_other'], failed: ['tests/test_x.py::test_fix'], passed_match: false },
    { passed: ['tests/test_x.py::test_fix', 'tests/test_x.py::test_other'], failed: [], passed_match: true },
    { passed: ['tests/test_x.py::test_fix', 'tests/test_x.py::test_other'], failed: [], passed_match: true, imageDigest: `sha256:${'d'.repeat(64)}` },
    { passed: [], failed: ['tests/test_x.py::test_fix'], passed_match: false },
  ];
  return {
    runEval: async () => {
      const r = responses[call] ?? responses[responses.length - 1]!;
      call += 1;
      return r;
    },
  };
}

async function setupSessionEnv(): Promise<{
  stateDir: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  mineableStore: MineableTraceStore;
}> {
  const stateDir = await mkdtemp(join(tmpdir(), 'harvest-sources-'));
  const validatedStore = new ValidatedPoolStore({ stateDir });
  const mintedStore = new MintedPoolStore({ stateDir });
  const mineableStore = new MineableTraceStore({ stateDir });
  await validatedStore.record(SOURCE_INSTANCE, {
    scorable: true,
    reason: 'gold-patch-resolves',
    checkedAt: new Date().toISOString(),
    rowHash: 'sha256:seed',
    imageName: SOURCE_HF_ROW.image_name,
    imageDigest: `sha256:${'e'.repeat(64)}`,
  }, EVAL_SEMANTICS_VERSION);
  return { stateDir, validatedStore, mintedStore, mineableStore };
}

function baseSourcesConfig(
  env: Awaited<ReturnType<typeof setupSessionEnv>>,
  overrides: Partial<HarvestLoopConfig> = {},
): HarvestLoopConfig {
  return {
    intervalMs: 60_000,
    stateDir: env.stateDir,
    repos: [],
    limitPerRepo: 1,
    publish: false,
    minterSafe: MINTER_SAFE,
    operatorSafe: OPERATOR_SAFE,
    isDockerAvailable: () => true,
    validatedStore: env.validatedStore,
    mineableStore: env.mineableStore,
    loadPool: async () => [SOURCE_TASK],
    mintDeps: {
      stateDir: env.stateDir,
      ipfsRegistryUrl: 'https://registry.example',
      ipfsGatewayUrl: 'https://gateway.example',
      validatedStore: env.validatedStore,
      mintedStore: env.mintedStore,
      hfFetcher: sessionHfFetcher,
      runner: makeSuccessfulSessionRunner(),
      upstreamRepoDir: env.stateDir, // not a git repo — resolveUpstreamEvalCommit fails soft to null
      publicRepoChecker: { isPublic: async () => true },
    },
    ...overrides,
  };
}

async function cleanupSessionEnv(env: { stateDir: string }): Promise<void> {
  await rm(env.stateDir, { recursive: true, force: true });
}

describe('runHarvestTick — harvest.sources union (Task 9)', () => {
  it('(a) sources absent (default ["commits"]) never touches the mineable store', async () => {
    const env = await setupSessionEnv();
    try {
      const record = makeSessionRecord();
      await env.mineableStore.append(record, 'retain_local');

      const result = await runHarvestTick(baseSourcesConfig(env));

      expect(result).toEqual({ discovered: 0, admitted: [], rejected: [], awaitingInput: [], quarantined: [], skipped: [] });
      // The mineable-store record was never drained — proves the default
      // (no `sources` field) runs only the commit walker.
      expect(await env.mineableStore.listUnmined()).toHaveLength(1);
    } finally {
      await cleanupSessionEnv(env);
    }
  });

  it('(b) sources: ["commits","sessions"] drains the mineable store and merges results', async () => {
    const env = await setupSessionEnv();
    try {
      const record = makeSessionRecord();
      await env.mineableStore.append(record, 'retain_local');

      const result = await runHarvestTick(baseSourcesConfig(env, { sources: ['commits', 'sessions'] }));

      // repos: [] ⇒ commits contributes nothing; sessions contributes the
      // one admitted echo — proving the two HarvestTickResults are summed
      // (discovered) and concatenated (admitted/rejected/skipped), not
      // replaced.
      expect(result.discovered).toBe(1);
      expect(result.admitted).toHaveLength(1);
      expect(result.admitted[0]).toMatch(/^acme__widget__session-[0-9a-f]{12}$/);
      expect(result.rejected).toEqual([]);
      expect(await env.mineableStore.listUnmined()).toEqual([]);
    } finally {
      await cleanupSessionEnv(env);
    }
  });

  it('(c) sources: ["sessions"] with an empty mineable store is a clean no-op tick', async () => {
    const env = await setupSessionEnv();
    try {
      const result = await runHarvestTick(baseSourcesConfig(env, { sources: ['sessions'] }));
      expect(result).toEqual({ discovered: 0, admitted: [], rejected: [], awaitingInput: [], quarantined: [], skipped: [] });
    } finally {
      await cleanupSessionEnv(env);
    }
  });

  it('(d) sessions deps carry operatorSafe/minterSafe as wired', async () => {
    const env = await setupSessionEnv();
    try {
      const record = makeSessionRecord();
      await env.mineableStore.append(record, 'retain_local');

      const result = await runHarvestTick(baseSourcesConfig(env, { sources: ['sessions'] }));
      const mintedId = result.admitted[0]!;
      const entry = await env.mintedStore.getEntry(mintedId, EVAL_SEMANTICS_VERSION);

      expect(entry!.provenance.minterSafe).toBe(MINTER_SAFE);
      expect((entry!.provenance as { sourceSolverSafe?: string }).sourceSolverSafe).toBe(OPERATOR_SAFE);
    } finally {
      await cleanupSessionEnv(env);
    }
  });

  it('sources: ["sessions"] without a configured mineableStore skips (non-fatal), never crashes', async () => {
    const env = await setupSessionEnv();
    try {
      const config = baseSourcesConfig(env, { sources: ['sessions'] });
      delete config.mineableStore;

      const result = await runHarvestTick(config);
      expect(result).toEqual({ discovered: 0, admitted: [], rejected: [], awaitingInput: [], quarantined: [], skipped: ['sessions-source-missing-mineable-store'] });
    } finally {
      await cleanupSessionEnv(env);
    }
  });
});
