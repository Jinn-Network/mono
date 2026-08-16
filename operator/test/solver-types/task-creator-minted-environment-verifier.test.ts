import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  createMintedEnvironmentVerifier,
  MintedEnvironmentVerificationError,
} from '../../src/solver-types/_swe-rebench-v2-minted-environment-verifier.js';
import { runMintTasksPipeline } from '../../src/solver-types/_swe-rebench-v2-mint-cli.js';
import { MintedPoolStore, type MintedEnvironmentBindingV1 } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { ValidatedPoolStore } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  type TaskEnvironmentSpecV1,
} from '../../src/task-creator/environment/contracts.js';
import { hashEnvironmentBuildRecipeV1 } from '../../src/task-creator/environment/jinn-differential-policy.js';
import { resolveJinnMonoRecipeV1 } from '../../src/task-creator/environment/recipes.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import { JINN_MONO_DIFFERENTIAL_PROOF_SOURCE } from '../../src/task-creator/proofs/public-repo-fixtures.js';
import { jinnDifferentialReceiptContractFixture } from '../task-creator/jinn-differential-receipt-contract-fixture.js';

const sha = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
const BASE_COMMIT = 'a'.repeat(40);
const IMAGE_DIGEST = sha('b');
const PARSER_DIGEST = sha('c');
const poolTask: PoolTask = {
  instance_id: 'acme__widget__echo-123',
  hf_dataset: 'ipfs://localmintedpending',
  hf_split: 'minted',
  repo: 'acme/widget',
  base_commit: BASE_COMMIT,
  language: 'typescript',
  test_patch: 'diff --git a/test/widget.test.ts b/test/widget.test.ts',
};

async function environmentFixture(): Promise<{ spec: TaskEnvironmentSpecV1; binding: MintedEnvironmentBindingV1 }> {
  const image = { reference: `ghcr.io/jinn-network/task-environment@${IMAGE_DIGEST}`, digest: IMAGE_DIGEST };
  const parser = { id: 'vitest-json.v1', version: 'v1', digest: PARSER_DIGEST, bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1' };
  const unsigned = {
    schemaVersion: 'jinn.task-environment.v1' as const,
    source: { repo: 'acme/widget', repoUrl: 'https://github.com/acme/widget.git', baseCommit: BASE_COMMIT },
    inputs: [{
      inputRef: `git+https://github.com/acme/widget.git#${BASE_COMMIT}`,
      sha256: sha('d'),
      rights: {
        inputRef: `git+https://github.com/acme/widget.git#${BASE_COMMIT}`,
        rightsRef: 'https://spdx.org/licenses/MIT.html', basis: 'spdx' as const, spdxId: 'MIT',
      },
    }],
    execution: {
      platform: 'linux/amd64' as const, workspace: '/testbed' as const, image,
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run'] }], parser,
      timeoutSeconds: 300, environment: {},
    },
    build: {
      recipeCid: 'bafyrecipe', recipeHash: sha('e'), provider: 'explicit' as const,
      providerId: 'acme-widget.v1', providerVersion: 'v1',
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-10T00:00:00.000Z', rightsPolicyVersion: 'g0b.v1',
      buildSmoke: 'pass' as const, imageSecretScan: 'pass' as const, sbomCid: 'bafysbom',
    },
    attestation: {
      scheme: 'eip191' as const, algo: 'secp256k1' as const, environmentHash: sha('0'),
      operatorSafe: `0x${'1'.repeat(40)}`, signer: `0x${'2'.repeat(40)}`,
      signature: `0x${'3'.repeat(130)}`,
    },
  } satisfies TaskEnvironmentSpecV1;
  const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
  const account = privateKeyToAccount(`0x${'4'.repeat(64)}`);
  const spec = {
    ...unsigned,
    attestation: {
      ...unsigned.attestation,
      environmentHash,
      signer: account.address,
      signature: await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
    },
  } satisfies TaskEnvironmentSpecV1;
  return {
    spec,
    binding: {
      environmentSpecCid: 'bafyenvironment', environmentHash, attestation: spec.attestation,
      parser, image, platform: 'linux/amd64',
    },
  };
}

async function exactJinnEnvironmentFixture(privateKey: `0x${string}`): Promise<{
  spec: TaskEnvironmentSpecV1;
  binding: MintedEnvironmentBindingV1;
  task: PoolTask;
}> {
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  const recipe = resolveJinnMonoRecipeV1(source.baseCommit);
  const account = privateKeyToAccount(privateKey);
  const image = {
    reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${IMAGE_DIGEST}`,
    digest: IMAGE_DIGEST,
  };
  const unsigned: TaskEnvironmentSpecV1 = {
    schemaVersion: 'jinn.task-environment.v1',
    source: recipe.source,
    inputs: recipe.inputRights.map((rights) => ({ inputRef: rights.inputRef, sha256: sha('d'), rights })),
    execution: {
      platform: recipe.platform,
      workspace: recipe.workspace,
      image,
      testCommands: recipe.testCommands,
      parser: recipe.parser,
      timeoutSeconds: recipe.timeoutSeconds,
      environment: recipe.environment,
    },
    build: {
      recipeCid: 'bafy-jinn-recipe',
      recipeHash: hashEnvironmentBuildRecipeV1(recipe),
      provider: 'explicit',
      providerId: recipe.recipeId,
      providerVersion: 'v1',
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-12T00:00:00.000Z',
      rightsPolicyVersion: 'g0b.v1',
      buildSmoke: 'pass',
      imageSecretScan: 'pass',
      sbomCid: 'bafy-jinn-sbom',
    },
    attestation: {
      scheme: 'eip191', algo: 'secp256k1', environmentHash: sha('0'),
      operatorSafe: account.address, signer: account.address, signature: `0x${'0'.repeat(130)}`,
    },
  };
  const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
  const spec = {
    ...unsigned,
    attestation: {
      ...unsigned.attestation,
      environmentHash,
      signature: await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
    },
  } satisfies TaskEnvironmentSpecV1;
  return {
    spec,
    binding: {
      environmentSpecCid: 'bafy-exact-jinn-environment', environmentHash, attestation: spec.attestation,
      parser: spec.execution.parser, image, platform: 'linux/amd64',
    },
    task: {
      instance_id: source.instanceId,
      hf_dataset: 'ipfs://localmintedpending', hf_split: 'minted', repo: source.repo,
      base_commit: source.baseCommit, language: 'typescript', test_patch: 'diff --git a/client/test/daemon/daemon-recovery-nonblocking.test.ts b/client/test/daemon/daemon-recovery-nonblocking.test.ts',
    },
  };
}

describe('explicit v2 mint environment verifier', () => {
  it('fails closed before environment verification when the real Jinn source lacks hardened receipt evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-jinn-receipt-required-'));
    try {
      const fixture = jinnDifferentialReceiptContractFixture();
      const verify = vi.fn();
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask: {
            instance_id: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.instanceId,
            hf_dataset: 'ipfs://localmintedpending', hf_split: 'minted',
            repo: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.repo,
            base_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.baseCommit,
            language: 'typescript', test_patch: fixture.testPatch,
          },
          goldPatch: 'local-only-gold',
          fixCommit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.fixCommit,
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: fixture.environment,
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
        fetcher: { fetchTaskRow: vi.fn() }, runner: { runEval: vi.fn() }, upstreamRepoDir: dir,
        publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: { verify },
      });

      expect(result.admitted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/Jinn.*differential.*receipt|differential.*receipt/i);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let an exact real Jinn source with language python escape through legacy minting without an environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-jinn-no-legacy-escape-'));
    try {
      const fixture = jinnDifferentialReceiptContractFixture();
      const runner = { runEval: vi.fn() };
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask: {
            instance_id: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.instanceId,
            hf_dataset: 'ipfs://legacy-escape-attempt', hf_split: 'minted',
            repo: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.repo,
            base_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.baseCommit,
            language: 'python', test_patch: fixture.testPatch,
          },
          goldPatch: 'local-only-gold',
          fixCommit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.fixCommit,
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          differentialAdmission: {
            receipt: fixture.receipt,
            receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
            receiptCid: 'bafy-test-only-jinn-differential-receipt',
          },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
        fetcher: { fetchTaskRow: vi.fn() }, runner, upstreamRepoDir: dir,
        publicRepoChecker: { isPublic: async () => true },
      });

      expect(result.admitted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/Jinn.*environment|environment.*Jinn/i);
      expect(runner.runEval).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('derives an exact Jinn v2 row’s public assertions from its verified receipt, not legacy pool fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-jinn-receipt-row-'));
    try {
      const fixture = jinnDifferentialReceiptContractFixture();
      const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
      const expectedF2p = fixture.receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS);
      const expectedP2p = fixture.receipt.testPaths.flatMap((path) => path.PASS_TO_PASS);
      const runner = {
        runEval: vi.fn()
          .mockResolvedValueOnce({ passed_match: true, passed: expectedF2p, failed: [], log: '', exitCode: 0, imageDigest: fixture.environment.image.digest })
          .mockResolvedValueOnce({ passed_match: false, passed: [], failed: expectedF2p, log: '', exitCode: 0 }),
      };
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask: {
            instance_id: source.instanceId,
            hf_dataset: 'ipfs://localmintedpending', hf_split: 'minted', repo: source.repo,
            base_commit: source.baseCommit, language: 'typescript', test_patch: fixture.testPatch,
          },
          goldPatch: fixture.goldPatch, fixCommit: source.fixCommit,
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: fixture.environment,
          differentialAdmission: {
            receipt: fixture.receipt,
            receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
            receiptCid: 'bafy-test-only-jinn-differential-receipt',
          },
          publish: false,
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
        fetcher: { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch placeholder')) },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: {
          verify: async () => ({
            source: { repo: source.repo, baseCommit: source.baseCommit },
            execution: {
              platform: fixture.environment.platform,
              workspace: '/testbed',
              image: fixture.environment.image,
              parser: fixture.environment.parser,
              testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-results.json'], cwd: 'operator' }],
            },
            attestation: { environmentHash: fixture.environment.environmentHash },
          }) as unknown as TaskEnvironmentSpecV1,
        },
        uploadReceipt: vi.fn().mockResolvedValue('bafy-test-only-jinn-differential-receipt'),
      });

      expect(runner.runEval).toHaveBeenCalled();
      expect(result.rejected).toEqual([]);
      expect(result.admitted).toEqual([source.instanceId]);
      // The row is recorded locally but unpublished (publish:false ⇒ published
      // marker is false, D2 tier-2). Inspecting it via exportArtifactV2 requires
      // naming it in includeIds, exactly as the publish path does for the batch
      // it is publishing right now.
      expect(
        (await new MintedPoolStore({ stateDir: dir }).exportArtifactV2('4', { includeIds: [source.instanceId] })).rows[0],
      ).toMatchObject({
        FAIL_TO_PASS: expectedF2p,
        PASS_TO_PASS: expectedP2p,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a configured receipt CID when publication returns a different CID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-receipt-cid-drift-'));
    try {
      const { spec, binding } = await environmentFixture();
      const receipt = createDifferentialAdmissionReceiptV2({
        task: { instanceId: poolTask.instance_id, repo: poolTask.repo!, baseCommit: BASE_COMMIT, fixCommit: 'f'.repeat(40) },
        goldPatchHash: `sha256:${createHash('sha256').update('local-only-gold').digest('hex')}`,
        testPatchHash: `sha256:${createHash('sha256').update(poolTask.test_patch!).digest('hex')}`,
        environment: spec,
        evalSemanticsVersion: '4',
        testPaths: [{
          testPath: 'test/widget.test.ts',
          broken: [{ passed: ['unaffected'], failed: ['regression'], passed_match: false }, { passed: ['unaffected'], failed: ['regression'], passed_match: false }],
          fixed: [{ passed: ['regression', 'unaffected'], failed: [], passed_match: true }, { passed: ['regression', 'unaffected'], failed: [], passed_match: true }],
        }],
      });
      const runner = {
        runEval: vi.fn()
          .mockResolvedValueOnce({ passed_match: true, passed: ['regression', 'unaffected'], failed: [], log: '', exitCode: 0, imageDigest: binding.image.digest })
          .mockResolvedValueOnce({ passed_match: false, passed: ['unaffected'], failed: ['regression'], log: '', exitCode: 0 }),
      };

      await expect(runMintTasksPipeline({
        candidates: [{
          poolTask, goldPatch: 'local-only-gold', fixCommit: 'f'.repeat(40),
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: binding,
          differentialAdmission: {
            receipt,
            receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
            receiptCid: 'bafy-expected-receipt-cid',
          },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
        fetcher: { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch placeholder')) },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: { verify: async () => spec },
        uploadReceipt: vi.fn().mockResolvedValue('bafy-different-receipt-cid'),
      })).rejects.toThrow(/receipt CID.*does not match|published.*receipt CID/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts only the exact signed environment spec for the candidate', async () => {
    const { spec, binding } = await environmentFixture();
    const verifier = createMintedEnvironmentVerifier({
      ipfsGatewayUrl: 'https://gateway.example',
      fetchEnvironmentSpec: vi.fn().mockResolvedValue(spec),
    });

    await expect(verifier.verify({ binding, poolTask })).resolves.toEqual(spec);
  });

  it('rejects an exact Jinn environment signed by an attester outside the explicit proof policy', async () => {
    const approved = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const { spec, binding, task } = await exactJinnEnvironmentFixture(`0x${'2'.repeat(64)}`);
    const verifier = createMintedEnvironmentVerifier({
      ipfsGatewayUrl: 'https://gateway.example',
      fetchEnvironmentSpec: vi.fn().mockResolvedValue(spec),
      jinnDifferentialAttesterPolicy: {
        approvedAttesters: [{ operatorSafe: approved.address, signer: approved.address }],
      },
    });

    await expect(verifier.verify({ binding, poolTask: task })).rejects.toMatchObject({
      name: 'MintedEnvironmentVerificationError',
      category: 'policy',
      message: expect.stringMatching(/attester.*policy-approved|policy-approved.*attester/i),
    } satisfies Partial<MintedEnvironmentVerificationError>);
  });

  it('classifies a missing environment CID as infrastructure and an invalid signature as policy', async () => {
    const { spec, binding } = await environmentFixture();
    const missing = createMintedEnvironmentVerifier({
      ipfsGatewayUrl: 'https://gateway.example',
      fetchEnvironmentSpec: vi.fn().mockRejectedValue(new Error('404')),
    });
    await expect(missing.verify({ binding, poolTask })).rejects.toMatchObject({
      name: 'MintedEnvironmentVerificationError', category: 'infrastructure',
    } satisfies Partial<MintedEnvironmentVerificationError>);

    const invalidSpec = { ...spec, attestation: { ...spec.attestation, signature: `0x${'0'.repeat(130)}` } };
    const invalidBinding = { ...binding, attestation: invalidSpec.attestation };
    const invalid = createMintedEnvironmentVerifier({
      ipfsGatewayUrl: 'https://gateway.example',
      fetchEnvironmentSpec: vi.fn().mockResolvedValue(invalidSpec),
    });
    await expect(invalid.verify({ binding: invalidBinding, poolTask })).rejects.toMatchObject({
      name: 'MintedEnvironmentVerificationError', category: 'policy',
    } satisfies Partial<MintedEnvironmentVerificationError>);
  });

  it('rejects an invalid signed v2 environment before validation, store record, or publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-v2-verifier-'));
    try {
      const { spec, binding } = await environmentFixture();
      const invalidSpec = { ...spec, attestation: { ...spec.attestation, signature: `0x${'0'.repeat(130)}` } };
      const invalidBinding = { ...binding, attestation: invalidSpec.attestation };
      const receipt = createDifferentialAdmissionReceiptV2({
        task: { instanceId: poolTask.instance_id, repo: poolTask.repo!, baseCommit: BASE_COMMIT, fixCommit: 'f'.repeat(40) },
        goldPatchHash: `sha256:${createHash('sha256').update('local-only-gold').digest('hex')}`,
        testPatchHash: `sha256:${createHash('sha256').update(poolTask.test_patch!).digest('hex')}`,
        environment: spec,
        evalSemanticsVersion: '4',
        testPaths: [{
          testPath: 'test/widget.test.ts',
          broken: [{ passed: [], failed: ['regression'], passed_match: false }, { passed: [], failed: ['regression'], passed_match: false }],
          fixed: [{ passed: ['regression'], failed: [], passed_match: true }, { passed: ['regression'], failed: [], passed_match: true }],
        }],
      });
      const runner = { runEval: vi.fn() };
      const mintedStore = new MintedPoolStore({ stateDir: dir });
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask,
          goldPatch: 'local-only-gold',
          fixCommit: 'f'.repeat(40),
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: invalidBinding,
          differentialAdmission: { receipt, receiptHash: hashDifferentialAdmissionReceiptV2(receipt) },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore,
        fetcher: { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch placeholder')) },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: createMintedEnvironmentVerifier({
          ipfsGatewayUrl: 'https://gateway.example', fetchEnvironmentSpec: vi.fn().mockResolvedValue(invalidSpec),
        }),
      });

      expect(result.admitted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/^policy: environment attestation signature is invalid/);
      expect(await mintedStore.listEntries('4')).toEqual([]);
      expect(runner.runEval).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a newly minted non-Jinn explicit-environment row without hardened differential evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-v2-empirical-row-'));
    try {
      const { binding } = await environmentFixture();
      const mintedStore = new MintedPoolStore({ stateDir: dir });
      const runner = { runEval: vi.fn() };
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask, goldPatch: 'local-only-gold',
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: binding,
          publish: false,
          row: {
            instance_id: poolTask.instance_id, repo: 'acme/widget', image_name: binding.image.reference,
            FAIL_TO_PASS: ['regression'], PASS_TO_PASS: ['unaffected'], test_patch: poolTask.test_patch!,
            install_config: { install: [], test_cmd: ['yarn vitest run'], log_parser: binding.parser.id },
          },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore,
        fetcher: { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch placeholder')) },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: {
          verify: async () => ({ execution: { testCommands: [{ bin: 'yarn', args: ['vitest', 'run'] }] } } as unknown as TaskEnvironmentSpecV1),
        },
      });

      expect(result.admitted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/differential admission receipt/i);
      expect(await mintedStore.listEntries('4')).toEqual([]);
      expect(runner.runEval).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records a receipt-bound non-Jinn local v2 row without uploading its pre-published receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-v2-local-receipt-'));
    try {
      const { spec, binding } = await environmentFixture();
      const mintedStore = new MintedPoolStore({ stateDir: dir });
      const receipt = createDifferentialAdmissionReceiptV2({
        task: { instanceId: poolTask.instance_id, repo: poolTask.repo!, baseCommit: BASE_COMMIT, fixCommit: 'f'.repeat(40) },
        goldPatchHash: `sha256:${createHash('sha256').update('local-only-gold').digest('hex')}`,
        testPatchHash: `sha256:${createHash('sha256').update(poolTask.test_patch!).digest('hex')}`,
        environment: spec,
        evalSemanticsVersion: '4',
        testPaths: [{
          testPath: 'test/widget.test.ts',
          broken: [
            { passed: ['unaffected'], failed: ['regression'], passed_match: false },
            { passed: ['unaffected'], failed: ['regression'], passed_match: false },
          ],
          fixed: [
            { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
            { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
          ],
        }],
      });
      const runner = {
        runEval: vi.fn()
          .mockResolvedValueOnce({ passed_match: true, passed: ['regression', 'unaffected'], failed: [], log: '', exitCode: 0, imageDigest: binding.image.digest })
          .mockResolvedValueOnce({ passed_match: false, passed: ['unaffected'], failed: ['regression'], log: '', exitCode: 0 }),
      };
      const uploadReceipt = vi.fn().mockResolvedValue('bafy-should-not-upload-local-row');

      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask,
          goldPatch: 'local-only-gold',
          fixCommit: 'f'.repeat(40),
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: binding,
          publish: false,
          differentialAdmission: {
            receipt,
            receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
            receiptCid: 'QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp',
          },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore,
        fetcher: { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch placeholder')) },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: { verify: async () => spec },
        uploadReceipt,
      });

      expect(result.admitted).toEqual([poolTask.instance_id]);
      expect(result.rejected).toEqual([]);
      expect(uploadReceipt).not.toHaveBeenCalled();
      // Unpublished local row (publish:false) — name it in includeIds to inspect
      // it through the tier-2 publish gate (D2).
      expect(
        (await mintedStore.exportArtifactV2('4', { includeIds: [poolTask.instance_id] })).rows[0],
      ).toMatchObject({
        FAIL_TO_PASS: ['regression'], PASS_TO_PASS: ['unaffected'], test_patch: poolTask.test_patch,
        differentialAdmission: { receiptCid: 'QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects hardened evidence whose candidate fix commit differs from its receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-v2-fix-commit-'));
    try {
      const { spec, binding } = await environmentFixture();
      const receipt = createDifferentialAdmissionReceiptV2({
        task: {
          instanceId: poolTask.instance_id,
          repo: poolTask.repo!,
          baseCommit: BASE_COMMIT,
          fixCommit: 'f'.repeat(40),
        },
        goldPatchHash: `sha256:${createHash('sha256').update('local-only-gold').digest('hex')}`,
        testPatchHash: `sha256:${createHash('sha256').update(poolTask.test_patch!).digest('hex')}`,
        environment: spec,
        evalSemanticsVersion: '4',
        testPaths: [{
          testPath: 'test/widget.test.ts',
          broken: [
            { passed: ['unaffected'], failed: ['regression'], passed_match: false },
            { passed: ['unaffected'], failed: ['regression'], passed_match: false },
          ],
          fixed: [
            { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
            { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
          ],
        }],
      });
      const runner = { runEval: vi.fn() };
      const result = await runMintTasksPipeline({
        candidates: [{
          poolTask,
          goldPatch: 'local-only-gold',
          provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
          environment: binding,
          fixCommit: 'e'.repeat(40),
          differentialAdmission: { receipt, receiptHash: hashDifferentialAdmissionReceiptV2(receipt) },
        }],
        stateDir: dir, ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
        validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
        fetcher: { fetchTaskRow: vi.fn() },
        runner, upstreamRepoDir: dir, publicRepoChecker: { isPublic: async () => true },
        environmentVerifier: { verify: async () => spec },
      });

      expect(result.admitted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/differential admission receipt task\/patch\/semantics binding drift/);
      expect(runner.runEval).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
