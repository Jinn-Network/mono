/**
 * End-to-end harvest slice verification (orchestration, mock Docker/IPFS).
 *
 * Proves: git fixture → runHarvestTick → MintedPoolStore + ipfs backfill →
 * loadMintedPoolTasks → RoutingTaskRowFetcher row resolve → synthetic claim +
 * escrow eligibility stamping inputs.
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { runHarvestTick } from '../../src/daemon/harvest-loop.js';
import { HarvestStateStore } from '../../src/solver-types/_swe-rebench-v2-harvest-state.js';
import { ValidatedPoolStore, EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { MintedPoolStore, loadMintedPoolTasks, mintedIpfsDatasetCid } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { RoutingTaskRowFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import { resolveMintedTaskDeliveryRate } from '../../src/solver-types/_swe-rebench-v2-escrow.js';
import {
  DEFAULT_SYNTHETIC_ESCROW_PARAMS,
  escrowInputsFromPatch,
} from '../../src/solver-types/_swe-rebench-v2-harvest.js';
import { syntheticClaimBlocked } from '../../src/solver-types/_swe-rebench-v2-synthetic-claim.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafyharveste2e'),
  fetchFromIpfs: vi.fn(),
}));

const execFileAsync = promisify(execFile);
// NB: the instance id and repo MUST be synthetic (not a real dataset
// instance/repo) — minting derives a repo denylist from the active held-out
// slates (`loadMintRepoDenylist`), so a real slate member (e.g. sympy/sympy,
// held out since slate v3 via sympy__sympy-27510) would be rejected at
// admission and this test would never reach the minted pool.
const SOURCE_INSTANCE = 'org__repo-1647';
const REPO = 'org/repo';
const MINTER_SAFE = '0x00000000000000000000000000000000000000aa';

const SOURCE_TASK: PoolTask = {
  instance_id: SOURCE_INSTANCE,
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2024_06',
  repo: REPO,
  base_commit: 'abc123',
  patch: 'gold-from-benchmark',
  test_patch: 'diff --git a/sympy/tests/test_x.py',
  language: 'python',
};

const HF_ROW = {
  instance_id: SOURCE_INSTANCE,
  repo: REPO,
  image_name: 'swe-rebench/repo:1647',
  FAIL_TO_PASS: ['sympy/tests/test_x.py::test_fix'],
  PASS_TO_PASS: ['sympy/tests/test_x.py::test_other'],
  test_patch: 'diff --git a/sympy/tests/test_x.py',
  install_config: {
    test_cmd: 'pytest sympy/tests/test_x.py',
    log_parser: 'parse_log_pytest',
    install: ['pip install -e .'],
  },
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return stdout;
}

describe('task-creator harvest e2e (orchestration)', () => {
  let stateDir: string;
  let repoDir: string;
  let snapshot: string;
  let fixCommit: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'harvest-e2e-state-'));
    repoDir = await mkdtemp(join(tmpdir(), 'harvest-e2e-repo-'));

    await git(repoDir, ['init']);
    await git(repoDir, ['config', 'user.email', 'e2e@test.local']);
    await git(repoDir, ['config', 'user.name', 'E2E']);
    await git(repoDir, ['checkout', '-b', 'main']);

    await execFileAsync('bash', ['-c', `mkdir -p sympy/tests
cat > sympy/core.py <<'EOF'
def value():
    return 0
EOF
cat > sympy/tests/test_x.py <<'EOF'
def test_fix():
    assert value() == 1
def test_other():
    assert True
EOF`], { cwd: repoDir });
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'initial broken state']);
    snapshot = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();

    await execFileAsync('bash', ['-c', `cat > sympy/core.py <<'EOF'
def value():
    return 1
EOF
cat > sympy/tests/test_x.py <<'EOF'
def test_fix():
    assert value() == 1  # fixed
def test_other():
    assert True
EOF`], { cwd: repoDir });
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'fix: correct value and test']);
    fixCommit = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();

    const validatedStore = new ValidatedPoolStore({ stateDir });
    await validatedStore.record(SOURCE_INSTANCE, {
      scorable: true,
      reason: 'gold-patch-resolves',
      checkedAt: new Date().toISOString(),
      rowHash: 'sha256:seed',
      imageName: HF_ROW.image_name,
      imageDigest: 'sha256:digest',
    }, EVAL_SEMANTICS_VERSION);
  });

  afterAll(async () => {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it('harvests git commit through admission to gradeable minted pool row', async () => {
    const validatedStore = new ValidatedPoolStore({ stateDir });
    const mintedStore = new MintedPoolStore({ stateDir });

    const runner: EvalRunner = {
      runEval: vi.fn()
        // empirical before
        .mockResolvedValueOnce({
          passed: ['sympy/tests/test_x.py::test_other'],
          failed: ['sympy/tests/test_x.py::test_fix'],
          passed_match: false,
        })
        // empirical after
        .mockResolvedValueOnce({
          passed: ['sympy/tests/test_x.py::test_fix', 'sympy/tests/test_x.py::test_other'],
          failed: [],
          passed_match: true,
        })
        // gold admission
        .mockResolvedValueOnce({
          passed: ['sympy/tests/test_x.py::test_fix', 'sympy/tests/test_x.py::test_other'],
          failed: [],
          passed_match: true,
          imageDigest: 'sha256:digest',
        })
        // discrimination known-bad
        .mockResolvedValueOnce({
          passed: [],
          failed: ['sympy/tests/test_x.py::test_fix'],
          passed_match: false,
        }),
    };

    const hfFetcher = {
      fetchTaskRow: vi.fn().mockImplementation(async (args: { instance_id: string }) => {
        if (args.instance_id === SOURCE_INSTANCE) return HF_ROW;
        return {
          ...HF_ROW,
          instance_id: args.instance_id,
          FAIL_TO_PASS: ['sympy/tests/test_x.py::test_fix'],
          PASS_TO_PASS: ['sympy/tests/test_x.py::test_other'],
        };
      }),
    };

    const harvestState = new HarvestStateStore({ stateDir });
    await harvestState.setLastScannedCommit(REPO, snapshot);

    const result = await runHarvestTick({
      intervalMs: 60_000,
      stateDir,
      repos: [{ path: repoDir, repo: REPO }],
      limitPerRepo: 1,
      limitPerTick: 3,
      publish: true,
      minterSafe: MINTER_SAFE,
      isDockerAvailable: () => true,
      validatedStore,
      harvestState,
      loadPool: async () => [SOURCE_TASK],
      mintDeps: {
        stateDir,
        ipfsRegistryUrl: 'https://registry.example',
        ipfsGatewayUrl: 'https://gateway.example',
        validatedStore,
        mintedStore,
        hfFetcher,
        runner,
        upstreamRepoDir: repoDir,
        publicRepoChecker: { isPublic: async () => true },
      },
    });

    expect(result.discovered).toBe(1);
    expect(result.admitted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);

    const mintedId = result.admitted[0]!;
    expect(mintedId).toContain('org__repo__echo-');
    // Discovery writes its resumable job before moving the cursor; admission
    // completes that same durable job rather than relying on an in-memory loop.
    const job = await harvestState.getJob(`task:${REPO}@${fixCommit}`);
    expect(job?.disposition).toBe('admitted');
    expect((await harvestState.getRepo(REPO))?.lastScannedCommit).toBe(fixCommit);

    const publishedCid = await mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION);
    expect(publishedCid).toBe('bafyharveste2e');

    const poolTasks = await loadMintedPoolTasks(mintedStore, EVAL_SEMANTICS_VERSION);
    expect(poolTasks).toHaveLength(1);
    expect(poolTasks[0]!.hf_dataset).toBe(mintedIpfsDatasetCid('bafyharveste2e'));

    const routingFetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: async () => { throw new Error('hf should not be called'); } },
      fetchMintedArtifact: async () => {
        const artifact = await mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION);
        return artifact;
      },
    });
    const resolved = await routingFetcher.fetchTaskRow({
      hf_dataset: poolTasks[0]!.hf_dataset,
      hf_split: 'minted',
      instance_id: mintedId,
    });
    expect(resolved.FAIL_TO_PASS).toContain('sympy/tests/test_x.py::test_fix');

    const entry = await mintedStore.getEntry(mintedId, EVAL_SEMANTICS_VERSION);
    expect(entry?.provenance.minterSafe).toBe(MINTER_SAFE);
    expect(syntheticClaimBlocked(entry?.provenance, MINTER_SAFE)).toContain('minter');
    expect(uploadToIpfs).toHaveBeenCalled();

    const baseRate = 1_000_000_000_000_000_000n;
    const weighted = resolveMintedTaskDeliveryRate(baseRate, {
      syntheticEscrow: true,
      syntheticEscrowInputs: escrowInputsFromPatch(poolTasks[0]!.patch ?? '', resolved.FAIL_TO_PASS),
      syntheticEscrowParams: DEFAULT_SYNTHETIC_ESCROW_PARAMS,
    });
    expect(weighted).toBeGreaterThan(baseRate);

    expect(fixCommit).not.toBe(snapshot);
  });
});
