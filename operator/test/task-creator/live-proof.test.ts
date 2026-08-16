import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  networkProofConfigDocument,
  executeNetworkFactoryProof,
  parseLivePublicRepoProofConfig,
  publicRepoProofMintCommand,
} from '../../src/task-creator/proofs/live-proof.js';
import { JINN_MONO_DIFFERENTIAL_PROOF_SOURCE } from '../../src/task-creator/proofs/public-repo-fixtures.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  type TaskEnvironmentSpecV1,
} from '../../src/task-creator/environment/contracts.js';
import { hashEnvironmentBuildRecipeV1 } from '../../src/task-creator/environment/jinn-differential-policy.js';
import { resolveJinnMonoRecipeV1 } from '../../src/task-creator/environment/recipes.js';

const SHA = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
const RECEIPT_CID = 'QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp';
const TEST_PATCH = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.testPaths
  .map((path) => `diff --git a/${path} b/${path}\n`)
  .join('');

async function createLiveFixture(options: {
  approvedPrivateKey?: `0x${string}`;
  signerPrivateKey?: `0x${string}`;
} = {}) {
  const approved = privateKeyToAccount(options.approvedPrivateKey ?? `0x${'1'.repeat(64)}`);
  const signer = privateKeyToAccount(options.signerPrivateKey ?? `0x${'1'.repeat(64)}`);
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  const recipe = resolveJinnMonoRecipeV1(source.baseCommit);
  const image = {
    reference: `registry.example.test/jinn-mono@${SHA('a')}`,
    digest: SHA('a'),
  };
  const unsigned: TaskEnvironmentSpecV1 = {
    schemaVersion: 'jinn.task-environment.v1',
    source: recipe.source,
    inputs: recipe.inputRights.map((rights) => ({ inputRef: rights.inputRef, sha256: SHA('b'), rights })),
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
      recipeCid: RECEIPT_CID,
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
      sbomCid: RECEIPT_CID,
    },
    attestation: {
      scheme: 'eip191', algo: 'secp256k1', environmentHash: SHA('c'),
      operatorSafe: signer.address, signer: signer.address, signature: `0x${'0'.repeat(130)}`,
    },
  };
  const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
  const environmentSpec: TaskEnvironmentSpecV1 = {
    ...unsigned,
    attestation: {
      ...unsigned.attestation,
      environmentHash,
      signature: await signer.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
    },
  };
  const environment = {
    environmentSpecCid: RECEIPT_CID,
    environmentHash,
    attestation: environmentSpec.attestation,
    parser: environmentSpec.execution.parser,
    image,
    platform: 'linux/amd64' as const,
  };
  const receipt = createDifferentialAdmissionReceiptV2({
    task: { instanceId: source.instanceId, repo: source.repo, baseCommit: source.baseCommit, fixCommit: source.fixCommit },
    goldPatchHash: `sha256:${createHash('sha256').update('local-only-test-gold').digest('hex')}`,
    testPatchHash: `sha256:${createHash('sha256').update(TEST_PATCH).digest('hex')}`,
    environment: environmentSpec,
    evalSemanticsVersion: '4',
    testPaths: source.testPaths.map((testPath, index) => {
      const assertion = `#1422 live proof test ${index + 1}`;
      const broken = { passed: [], failed: [assertion], passed_match: false };
      const fixed = { passed: [assertion], failed: [], passed_match: true };
      return { testPath, broken: [broken, broken], fixed: [fixed, fixed] };
    }),
  });
  const candidatesFile = join(mkdtempSync(join(tmpdir(), 'public-repo-live-proof-')), 'candidates.json');
  const receiptFile = join(mkdtempSync(join(tmpdir(), 'public-repo-live-receipt-')), 'receipt.json');
  writeFileSync(receiptFile, JSON.stringify(receipt));
  writeFileSync(candidatesFile, JSON.stringify({
    poolTask: {
      instance_id: source.instanceId, repo: source.repo, base_commit: source.baseCommit,
      fix_commit: source.fixCommit, language: source.language, test_patch: TEST_PATCH,
    },
    goldPatch: 'local-only-test-gold', fixCommit: source.fixCommit,
    provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:test' },
    environment,
    differentialAdmission: { receipt, receiptHash: hashDifferentialAdmissionReceiptV2(receipt), receiptCid: RECEIPT_CID },
  }));
  return {
    candidatesFile,
    environment,
    environmentSpec,
    configured: {
      JINN_TASK_CREATOR_RPC_URL: 'https://rpc.example.test',
      JINN_TASK_CREATOR_REGISTRY_URL: 'https://registry.example.test',
      JINN_TASK_CREATOR_IPFS_GATEWAY_URL: 'https://gateway.example.test',
      JINN_TASK_CREATOR_REGISTRY_AUTH_REF: 'docker-credential-ghcr',
      JINN_TASK_CREATOR_MINTER_OPERATOR: '0x0000000000000000000000000000000000000001',
      JINN_TASK_CREATOR_SOLVER_OPERATOR: '0x0000000000000000000000000000000000000002',
      JINN_TASK_CREATOR_EVALUATOR_OPERATOR: '0x0000000000000000000000000000000000000003',
      JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS: `${approved.address}:${approved.address}`,
      JINN_TASK_CREATOR_CANDIDATES_FILE: candidatesFile,
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_PATH: receiptFile,
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID: RECEIPT_CID,
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH: hashDifferentialAdmissionReceiptV2(receipt),
    } as NodeJS.ProcessEnv,
  };
}

const live = await createLiveFixture();
const { candidatesFile, configured, environmentSpec: liveEnvironmentSpec } = live;
const parseConfigured = (env: NodeJS.ProcessEnv = configured) => parseLivePublicRepoProofConfig(
  'jinn-mono',
  env,
  { fetchEnvironmentSpec: async () => liveEnvironmentSpec },
);

describe('public-repository live proof preflight', () => {
  it('requires an explicit approved Jinn attester policy before it can launch a network proof', async () => {
    const { JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS: _approved, ...withoutApprovedAttester } = configured;
    await expect(parseConfigured(withoutApprovedAttester)).rejects.toThrow(
      /JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS/i,
    );
  });

  it('refuses the Jinn proof route without a generated differential receipt reference', async () => {
    const {
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_PATH: _path,
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID: _cid,
      JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH: _hash,
      ...withoutReceipt
    } = configured;
    await expect(parseConfigured(withoutReceipt)).rejects.toThrow(/differential.*receipt|receipt.*differential/i);
  });

  it('requires the mint CLI fixCommit field that will bind the vetted v2 row', async () => {
    const missingFix = join(mkdtempSync(join(tmpdir(), 'public-repo-live-proof-missing-fix-')), 'candidates.json');
    const candidate = JSON.parse(readFileSync(candidatesFile, 'utf8')) as Record<string, unknown>;
    delete candidate['fixCommit'];
    writeFileSync(missingFix, JSON.stringify(candidate));
    await expect(parseConfigured({
      ...configured,
      JINN_TASK_CREATOR_CANDIDATES_FILE: missingFix,
    })).rejects.toThrow(/fixCommit/i);
  });

  it('requires the mint candidate to carry the configured generated receipt CID', async () => {
    const missingCid = join(mkdtempSync(join(tmpdir(), 'public-repo-live-proof-missing-receipt-cid-')), 'candidates.json');
    const candidate = JSON.parse(readFileSync(candidatesFile, 'utf8')) as {
      differentialAdmission: Record<string, unknown>;
    };
    delete candidate.differentialAdmission['receiptCid'];
    writeFileSync(missingCid, JSON.stringify(candidate));
    await expect(parseConfigured({
      ...configured,
      JINN_TASK_CREATOR_CANDIDATES_FILE: missingCid,
    })).rejects.toThrow(/receipt CID/i);
  });

  it('fails closed with every missing external configuration key named', async () => {
    await expect(parseLivePublicRepoProofConfig('jinn-mono', {})).rejects.toThrow(
      /JINN_TASK_CREATOR_RPC_URL.*JINN_TASK_CREATOR_REGISTRY_URL.*JINN_TASK_CREATOR_MINTER_OPERATOR/s,
    );
  });

  it('requires distinct minter, solver, and evaluator operators', async () => {
    await expect(parseConfigured({
      ...configured,
      JINN_TASK_CREATOR_SOLVER_OPERATOR: configured.JINN_TASK_CREATOR_MINTER_OPERATOR,
    })).rejects.toThrow(/distinct/i);
  });

  it('accepts only a Docker credential-helper name, never credential material', async () => {
    for (const registryAuthRef of [
      'ghp_this-is-an-access-token',
      'password=registry-secret',
      'https://user:token@registry.example.test',
    ]) {
      await expect(parseConfigured({
        ...configured,
        JINN_TASK_CREATOR_REGISTRY_AUTH_REF: registryAuthRef,
      })).rejects.toThrow(/credential-helper/i);
    }

    expect((await parseConfigured()).registryCredentialRef)
      .toBe('docker-credential-ghcr');
  });

  it('rejects endpoint URLs that would serialize credential material', async () => {
    for (const [key, value] of [
      ['JINN_TASK_CREATOR_RPC_URL', 'https://user:password@rpc.example.test'],
      ['JINN_TASK_CREATOR_RPC_URL', 'https://rpc.example.test/?api_key=secret'],
      ['JINN_TASK_CREATOR_REGISTRY_URL', 'https://user:password@registry.example.test'],
      ['JINN_TASK_CREATOR_REGISTRY_URL', 'https://registry.example.test/?token=secret'],
    ] as const) {
      await expect(parseConfigured({
        ...configured,
        [key]: value,
      })).rejects.toThrow(/credential material/i);
    }
  });

  it('rejects a fake environment and a candidate that does not bind the selected fixture', async () => {
    const fake = join(mkdtempSync(join(tmpdir(), 'public-repo-live-proof-fake-')), 'candidates.json');
    writeFileSync(fake, JSON.stringify({
      poolTask: { instance_id: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.instanceId, repo: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.repo, base_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.baseCommit, fix_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.fixCommit, language: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.language, test_patch: TEST_PATCH },
      environment: { image: 'mock' },
    }));
    await expect(parseConfigured({
      ...configured,
      JINN_TASK_CREATOR_CANDIDATES_FILE: fake,
    })).rejects.toThrow(/environment binding/i);

    const wrongFixture = join(mkdtempSync(join(tmpdir(), 'public-repo-live-proof-wrong-')), 'candidates.json');
    writeFileSync(wrongFixture, JSON.stringify({
      poolTask: { instance_id: 'wrong', repo: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.repo, base_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.baseCommit, fix_commit: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.fixCommit, language: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.language, test_patch: TEST_PATCH },
      environment: live.environment,
    }));
    await expect(parseConfigured({
      ...configured,
      JINN_TASK_CREATOR_CANDIDATES_FILE: wrongFixture,
    })).rejects.toThrow(/instance_id/i);
  });

  it('creates the existing mint command only from caller-supplied config and never includes credentials', async () => {
    const config = await parseConfigured();
    expect(publicRepoProofMintCommand(config)).toEqual({
      bin: 'yarn',
      args: ['jinn', 'solver-nets', 'mint-tasks', 'swe-rebench-v2', '--candidates', configured.JINN_TASK_CREATOR_CANDIDATES_FILE],
    });
    expect(JSON.stringify(config)).not.toMatch(/private.?key|secret|password/i);
    expect(networkProofConfigDocument(config)).toMatchObject({
      schemaVersion: 'jinn.task-creator.public-repo-network-proof.v1',
      rpcUrl: new URL(configured.JINN_TASK_CREATOR_RPC_URL!).toString(),
      registry: {
        url: new URL(configured.JINN_TASK_CREATOR_REGISTRY_URL!).toString(),
        credentialRef: configured.JINN_TASK_CREATOR_REGISTRY_AUTH_REF,
      },
      operators: {
        minter: configured.JINN_TASK_CREATOR_MINTER_OPERATOR,
        solver: configured.JINN_TASK_CREATOR_SOLVER_OPERATOR,
        evaluator: configured.JINN_TASK_CREATOR_EVALUATOR_OPERATOR,
      },
      jinnEnvironmentPolicy: expect.objectContaining({
        ipfsGatewayUrl: new URL(configured.JINN_TASK_CREATOR_IPFS_GATEWAY_URL!).toString(),
        environment: live.environment,
        approvedAttesters: expect.any(Array),
      }),
    });
  });

  it('rejects a self-signed Jinn environment whose signer is not policy-approved before the network runner starts', async () => {
    const unapproved = await createLiveFixture({ signerPrivateKey: `0x${'2'.repeat(64)}` });
    await expect(parseLivePublicRepoProofConfig('jinn-mono', unapproved.configured, {
      fetchEnvironmentSpec: async () => unapproved.environmentSpec,
    })).rejects.toThrow(/policy-approved|attester.*approved/i);
  });

  it('binds the network/factory runner to a secret-free, explicit config document', async () => {
    const config = await parseConfigured();
    const orchestrator = join(mkdtempSync(join(tmpdir(), 'public-repo-orchestrator-')), 'runner');
    writeFileSync(orchestrator, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const calls: Array<{ bin: string; args: string[]; document: unknown }> = [];
    await executeNetworkFactoryProof(config, {
      env: {
        ...configured,
        JINN_TASK_CREATOR_NETWORK_EXECUTE: '1',
        JINN_TASK_CREATOR_NETWORK_ORCHESTRATOR: orchestrator,
      },
      run: async (bin, args) => {
        calls.push({ bin, args, document: JSON.parse(readFileSync(args[1]!, 'utf8')) });
      },
      fetchEnvironmentSpec: async () => liveEnvironmentSpec,
    });

    expect(calls).toEqual([expect.objectContaining({
      bin: orchestrator,
      args: ['--task-creator-public-repo-config', expect.stringContaining('network-proof.json')],
      document: expect.objectContaining({
        rpcUrl: 'https://rpc.example.test/',
        operators: expect.objectContaining({ minter: configured.JINN_TASK_CREATOR_MINTER_OPERATOR }),
        jinnEnvironmentPolicy: expect.objectContaining({
          ipfsGatewayUrl: new URL(configured.JINN_TASK_CREATOR_IPFS_GATEWAY_URL!).toString(),
          environment: live.environment,
        }),
      }),
    })]);
  });
});
