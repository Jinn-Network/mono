/**
 * Hermetic G0b proof: ordinary public repositories enter the existing
 * SWE-rebench generator as v2 minted rows.  No source repository, Docker
 * daemon, registry, IPFS gateway, or chain is contacted by this suite.
 */

import { describe, expect, it } from 'vitest';
import {
  JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
  JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE,
  UNJS_DESTR_PUBLIC_REPO_PROOF,
  resolvePublicRepoProofRecipe,
} from '../../src/task-creator/proofs/public-repo-fixtures.js';
import {
  runPublicRepoParityFixture,
  type PublicRepoFixtureRun,
} from '../../src/task-creator/proofs/vitest-json-fixture.js';
import {
  bindJinnDifferentialReceiptToProof,
} from '../../src/task-creator/proofs/differential-receipt-bound-proof.js';
import { computeMintedPoolRowV2Hash, type MintedPoolRowV2 } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { DEFAULT_GENERATOR_CONFIG, selectNextPostingCandidates } from '../../src/solver-types/swe-rebench-v2-auto.js';
import { syntheticClaimBlocked } from '../../src/solver-types/_swe-rebench-v2-synthetic-claim.js';
import { resolveMintedTaskDeliveryRate } from '../../src/solver-types/_swe-rebench-v2-escrow.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import { jinnDifferentialReceiptContractFixture } from './jinn-differential-receipt-contract-fixture.js';

function toV2Row(fixture: PublicRepoFixtureRun): MintedPoolRowV2 {
  const row = {
    instance_id: fixture.proof.instanceId,
    repo: fixture.proof.repo,
    base_commit: fixture.proof.baseCommit,
    language: fixture.proof.language,
    problem_statement: fixture.proof.problemStatement,
    image_name: fixture.environment.image.reference,
    FAIL_TO_PASS: fixture.parity.FAIL_TO_PASS,
    PASS_TO_PASS: fixture.parity.PASS_TO_PASS,
    test_patch: fixture.testPatch,
    install_config: fixture.installConfig,
    rowHashVersion: 2 as const,
    environment: fixture.environment,
    publicRowHash: '' as `sha256:${string}`,
  } satisfies Omit<MintedPoolRowV2, 'publicRowHash'> & { publicRowHash: `sha256:${string}` };
  return { ...row, publicRowHash: computeMintedPoolRowV2Hash(row) };
}

/** In-process disposable registry seam: proves no public registry is needed in CI. */
class MockLocalRegistry {
  private readonly images = new Map<string, `sha256:${string}`>();

  push(reference: string, digest: `sha256:${string}`): void {
    if (!reference.startsWith('localhost:5000/') || !reference.endsWith(`@${digest}`)) {
      throw new Error('mock registry accepts only digest-qualified localhost references');
    }
    this.images.set(reference, digest);
  }

  pull(reference: string): `sha256:${string}` {
    const digest = this.images.get(reference);
    if (!digest) throw new Error(`mock registry has no image ${reference}`);
    return digest;
  }
}

describe('Task Creator public-repository proof fixtures', () => {
  it('reframes the stale Jinn merge as Vitest parser-contract coverage, not empirical evidence', () => {
    expect(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE.fixCommit).toBe('5b76bade319857bd09a72c3c4aaf0949cfe078ee');
    expect(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE.problemStatement).toMatch(/parser-contract.*not empirical/i);
    expect(JINN_MONO_DIFFERENTIAL_PROOF_SOURCE).toMatchObject({
      repo: 'Jinn-Network/mono',
      baseCommit: 'ae8093a8848e70e581f46d66dcdb56789c0808a3',
      fixCommit: 'ef9608876511b4dff000cda1537ff7c1a227677d',
      instanceId: 'Jinn-Network__mono__echo-ef9608876511',
      testPaths: [
        'operator/test/daemon/daemon-recovery-nonblocking.test.ts',
        'operator/test/harnesses/engine/recovery.test.ts',
      ],
    });
  });

  it('derives Jinn’s two synthetic parser-contract tests from trusted Vitest JSON and distinguishes empty/gold/broken', () => {
    const fixture = runPublicRepoParityFixture(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE);

    expect(fixture.parity.FAIL_TO_PASS).toEqual(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE.syntheticParserContractTests);
    expect(fixture.parity.PASS_TO_PASS).toEqual(['public-repo fixture stable control']);
    expect(fixture.verdicts.empty).toBe(false);
    expect(fixture.verdicts.gold).toBe(true);
    expect(fixture.verdicts.broken).toBe(false);
    expect(fixture.installConfig.log_parser).toBe('vitest-json.v1');
    expect(fixture.environment.parser).toEqual(fixture.recipe.parser);
  });

  it('uses the same declarative public-repository adapter and trusted parser for Jinn and destr', () => {
    const jinn = runPublicRepoParityFixture(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE);
    const destr = runPublicRepoParityFixture(UNJS_DESTR_PUBLIC_REPO_PROOF);

    expect(jinn.environment.parser).toEqual(destr.environment.parser);
    expect(jinn.installConfig.log_parser).toBe('vitest-json.v1');
    expect(destr.installConfig.log_parser).toBe('vitest-json.v1');
    expect(jinn.recipe.source.repo).toBe('Jinn-Network/mono');
    expect(destr.recipe.source.repo).toBe('unjs/destr');
    expect(jinn.recipe.platform).toBe('linux/amd64');
    expect(destr.recipe.platform).toBe('linux/amd64');
    expect(jinn.recipe.recipeId).toBe('jinn-mono.v1');
    expect(destr.recipe.recipeId).toBe('unjs-destr.v1');
  });

  it('joins a v2 public-repository row to the unchanged PoolTask selection, escrow, and claim policy', () => {
    const fixture = runPublicRepoParityFixture(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE);
    const row = toV2Row(fixture);
    const registry = new MockLocalRegistry();
    registry.push(row.environment.image.reference, row.environment.image.digest);
    expect(registry.pull(row.environment.image.reference)).toBe(row.environment.image.digest);
    const task: PoolTask = {
      instance_id: row.instance_id,
      hf_dataset: 'ipfs://bafy-mock-public-repo-v2',
      hf_split: 'minted',
      repo: row.repo,
      base_commit: row.base_commit,
      language: row.language,
      problem_statement: row.problem_statement,
      // This private gold value may exist only in local task material.  The
      // v2 public row below must neither contain nor hash it.
      patch: 'private-local-gold-patch',
      test_patch: row.test_patch,
    };

    expect(computeMintedPoolRowV2Hash({ ...row, goldPatch: task.patch } as MintedPoolRowV2)).toBe(row.publicRowHash);
    expect(JSON.stringify(row)).not.toContain('private-local-gold-patch');

    const selected = selectNextPostingCandidates({
      pool: [task],
      counters: new Map(),
      config: { ...DEFAULT_GENERATOR_CONFIG, post_batch_size: 4 },
      now: 0,
      syntheticInstanceIds: new Set([task.instance_id]),
      mintFamilyByInstance: new Map([[task.instance_id, 'commit-echo']]),
    });
    expect(selected).toEqual([task]);
    expect(syntheticClaimBlocked({ synthetic: true, minterSafe: '0xminter' }, '0xsolver')).toBeNull();
    expect(syntheticClaimBlocked({ synthetic: true, minterSafe: '0xminter' }, '0xminter')).toMatch(/minter/i);
    expect(resolveMintedTaskDeliveryRate(100n, {
      syntheticEscrow: true,
      syntheticEscrowInputs: { loc: 10, files: 1, tests: row.FAIL_TO_PASS.length },
      syntheticEscrowParams: {
        alpha: 0.1, beta: 0.1, gamma: 0.1,
        loc_normalizer: 100, files_normalizer: 10, tests_normalizer: 10,
      },
    })).toBeGreaterThan(100n);
  });

  it('requires the supplied full base commit when resolving an operator-approved proof recipe', () => {
    expect(() => resolvePublicRepoProofRecipe(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE, 'c7701007')).toThrow(/40/i);
    expect(resolvePublicRepoProofRecipe(
      JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE,
      JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE.baseCommit,
    ).source.baseCommit).toBe(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE.baseCommit);
  });

  it('fails closed before posting when a real Jinn receipt hash or environment binding drifts', async () => {
    const { receipt, environment, testPatch } = jinnDifferentialReceiptContractFixture();
    const bound = await bindJinnDifferentialReceiptToProof({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      environment,
      testPatch,
    });
    expect(bound.receipt.task).toEqual({
      instanceId: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.instanceId,
      repo: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.repo,
      baseCommit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.baseCommit,
      fixCommit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.fixCommit,
    });

    await expect(bindJinnDifferentialReceiptToProof({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      receiptHash: `sha256:${'f'.repeat(64)}`,
      environment,
      testPatch,
    })).rejects.toThrow(/hash/i);
    await expect(bindJinnDifferentialReceiptToProof({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      environment: { ...environment, environmentHash: `sha256:${'e'.repeat(64)}` },
      testPatch,
    })).rejects.toThrow(/environment/i);
  });
});
