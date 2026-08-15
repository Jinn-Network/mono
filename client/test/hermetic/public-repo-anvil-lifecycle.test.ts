/**
 * Deterministic, on-chain lifecycle proof for the G0b public-repository
 * adapter. The evaluator evidence is synthetic parser-contract data; Anvil,
 * task creation, claims, deliveries, and verdict settlement are real.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../../src/util/canonical-json.js';
import {
  JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
  JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE,
  UNJS_DESTR_PUBLIC_REPO_PROOF,
} from '../../src/task-creator/proofs/public-repo-fixtures.js';
import {
  runPublicRepoAnvilLifecycle,
  runReceiptBoundJinnAnvilContractLifecycle,
} from '../task-creator/public-repo-anvil-lifecycle.js';
import { jinnDifferentialReceiptContractFixture } from '../task-creator/jinn-differential-receipt-contract-fixture.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type TaskEnvironmentSpecV1,
} from '../../src/task-creator/environment/contracts.js';
import type { ReceiptBoundJinnDifferentialProof } from '../../src/task-creator/proofs/differential-receipt-bound-proof.js';
import { resolveJinnMonoRecipeV1 } from '../../src/task-creator/environment/recipes.js';
import {
  parseReceiptBoundJinnAnvilProofCli,
  runReceiptBoundJinnAnvilProof,
} from '../../scripts/task-creator-jinn-differential-anvil-proof.js';

const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
const describeAnvil = hasAnvil ? describe : describe.skip;

describeAnvil('public-repository synthetic parser-contract Anvil lifecycle', () => {
  it('creates, claims, delivers, evaluates, settles, and records artifact/corpus evidence for Jinn and destr', async () => {
    const evidence = await runPublicRepoAnvilLifecycle([
      JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE,
      UNJS_DESTR_PUBLIC_REPO_PROOF,
    ]);

    expect(evidence).toHaveLength(2);
    for (const receipt of evidence) {
      expect(receipt.taskId).toMatch(/^\d+$/);
      expect(receipt.taskArtifactCid).toMatch(/^bafy-/);
      expect(receipt.environmentSpecCid).toMatch(/^bafy-/);
      expect(receipt.solutionDelivery.requestId).toMatch(/^0x[0-9a-f]+$/i);
      expect(receipt.solutionDelivery.txHash).toMatch(/^0x[0-9a-f]+$/i);
      expect(receipt.verdictDelivery.requestId).toMatch(/^0x[0-9a-f]+$/i);
      expect(receipt.verdictDelivery.txHash).toMatch(/^0x[0-9a-f]+$/i);
      expect(receipt.verdict).toEqual({ code: 1, source: 'synthetic-parser-contract', passed: true });
      expect(receipt.corpusEvidence).toMatchObject({
        taskArtifactCid: receipt.taskArtifactCid,
        environmentSpecCid: receipt.environmentSpecCid,
        solutionDeliveryTxHash: receipt.solutionDelivery.txHash,
        verdictDeliveryTxHash: receipt.verdictDelivery.txHash,
        publicRowHash: expect.stringMatching(/^sha256:/),
      });
    }
  }, 180_000);

  it('records a test-only receipt-bound Jinn contract lifecycle without calling it empirical proof', async () => {
    const fixture = jinnDifferentialReceiptContractFixture();
    expect(await verifyEnvironmentAttestationV1(fixture.environment.attestation)).toBe(true);
    const evidence = await runReceiptBoundJinnAnvilContractLifecycle({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt: fixture.receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
      environment: fixture.environment,
      testPatch: fixture.testPatch,
    });

    expect(evidence.fixture).toBe('jinn-mono-differential-admission-contract-fixture');
    expect(evidence.admissionReceipt).toEqual({
      kind: 'verified-differential-admission-receipt',
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
    });
    expect(evidence.verdict).toEqual({
      code: 1,
      source: 'test-only-differential-admission-contract-fixture',
      passed: true,
    });
    expect(evidence.corpusEvidence).toMatchObject({
      taskArtifactCid: evidence.taskArtifactCid,
      environmentSpecCid: evidence.environmentSpecCid,
      receiptCid: evidence.admissionReceipt.receiptCid,
      receiptHash: evidence.admissionReceipt.receiptHash,
      solutionDeliveryTxHash: evidence.solutionDelivery.txHash,
      verdictDeliveryTxHash: evidence.verdictDelivery.txHash,
    });
  }, 180_000);
});

describe('receipt-bound Jinn Anvil contract lifecycle preflight', () => {
  it('rejects a mismatched receipt before it can post a task or deliver a verdict', async () => {
    const fixture = jinnDifferentialReceiptContractFixture();
    await expect(runReceiptBoundJinnAnvilContractLifecycle({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt: fixture.receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      receiptHash: `sha256:${'f'.repeat(64)}`,
      environment: fixture.environment,
      testPatch: fixture.testPatch,
    })).rejects.toThrow(/receipt.*hash|hash.*receipt/i);
  });

  it('rejects a corrupted environment attestation before any Anvil lifecycle starts', async () => {
    const fixture = jinnDifferentialReceiptContractFixture();
    await expect(runReceiptBoundJinnAnvilContractLifecycle({
      source: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
      receipt: fixture.receipt,
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
      receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
      environment: {
        ...fixture.environment,
        attestation: { ...fixture.environment.attestation, signature: `0x${'0'.repeat(130)}` },
      },
      testPatch: fixture.testPatch,
    })).rejects.toThrow(/attestation.*signature|signature.*attestation/i);
  });
});

describe('receipt-bound Jinn Anvil proof command preflight', () => {
  const approvedAttester = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
  const invocation = (bindings: {
    environmentCid?: string;
    receiptCid?: string;
    expectedReceiptHash?: `sha256:${string}`;
  } = {}) => parseReceiptBoundJinnAnvilProofCli([
    '--environment-spec', '/secure/environment.json',
    '--environment-cid', bindings.environmentCid ?? 'bafy-test-only-jinn-environment',
    '--receipt', '/secure/receipt.json',
    '--receipt-cid', bindings.receiptCid ?? 'bafy-test-only-jinn-differential-receipt',
    '--expected-receipt-hash', bindings.expectedReceiptHash ?? `sha256:${'a'.repeat(64)}`,
    '--approved-attester', `${approvedAttester}:${approvedAttester}`,
    '--evidence-output', '/secure/evidence.json',
  ]);

  const verifiedInvocation = (artifacts: Awaited<ReturnType<typeof canonicalJinnProofArtifacts>>, bindings: {
    environmentCid?: string;
    receiptCid?: string;
  } = {}) => invocation({
    environmentCid: bindings.environmentCid ?? rawCanonicalJsonCid(artifacts.environment),
    receiptCid: bindings.receiptCid ?? rawCanonicalJsonCid(artifacts.receipt),
    expectedReceiptHash: hashDifferentialAdmissionReceiptV2(artifacts.receipt),
  });

  it('requires both artifact CIDs, the expected receipt hash, an attester pair, and an evidence output', () => {
    expect(() => parseReceiptBoundJinnAnvilProofCli([
      '--environment-spec', '/secure/environment.json',
      '--receipt', '/secure/receipt.json',
    ])).toThrow(/environment-cid/i);
    expect(() => parseReceiptBoundJinnAnvilProofCli([
      '--environment-spec', '/secure/environment.json',
      '--environment-cid', 'not-a-cid',
      '--receipt', '/secure/receipt.json',
      '--receipt-cid', 'also-not-a-cid',
      '--expected-receipt-hash', `sha256:${'a'.repeat(64)}`,
      '--approved-attester', 'not-an-attester-pair',
      '--evidence-output', '/secure/evidence.json',
    ])).toThrow(/CID|cid/i);
  });

  it('rejects a malformed environment before Anvil compilation or deployment', async () => {
    const artifacts = await canonicalJinnProofArtifacts();
    const runLifecycle = vi.fn();
    await expect(runReceiptBoundJinnAnvilProof(verifiedInvocation(artifacts), {
      readTextFile: async (path) => path.endsWith('environment.json') ? '{' : canonicalJson(artifacts.receipt),
      runLifecycle,
    })).rejects.toThrow(/signed environment.*valid JSON/i);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('rejects a drifted environment before Anvil compilation or deployment', async () => {
    const artifacts = await canonicalJinnProofArtifacts();
    const runLifecycle = vi.fn();
    const driftedEnvironment = {
      ...artifacts.environment,
      source: { ...artifacts.environment.source, repo: 'Jinn-Network/other' },
    };
    await expect(runReceiptBoundJinnAnvilProof(verifiedInvocation(artifacts), {
      readTextFile: async (path) => path.endsWith('environment.json')
        ? canonicalJson(driftedEnvironment)
        : canonicalJson(artifacts.receipt),
      runLifecycle,
    })).rejects.toThrow(/environmentHash|environment/i);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('rejects a malformed receipt before Anvil compilation or deployment', async () => {
    const artifacts = await canonicalJinnProofArtifacts();
    const runLifecycle = vi.fn();
    await expect(runReceiptBoundJinnAnvilProof(verifiedInvocation(artifacts), {
      readTextFile: async (path) => path.endsWith('environment.json') ? canonicalJson(artifacts.environment) : '{',
      runLifecycle,
    })).rejects.toThrow(/differential receipt.*valid JSON/i);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('rejects an unapproved attester before Anvil compilation or deployment', async () => {
    const artifacts = await canonicalJinnProofArtifacts();
    const runLifecycle = vi.fn();
    await expect(runReceiptBoundJinnAnvilProof(verifiedInvocation(artifacts), {
      readTextFile: async (path) => path.endsWith('environment.json')
        ? canonicalJson(artifacts.environment)
        : canonicalJson(artifacts.receipt),
      verifyReceipt: async () => { throw new Error('environment attester is not policy-approved'); },
      runLifecycle,
    })).rejects.toThrow(/attester.*policy-approved/i);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it.each([
    ['environment', 'environmentCid'],
    ['receipt', 'receiptCid'],
  ] as const)('rejects an unrelated valid %s CID before strict verification derives patches', async (_artifact, cidField) => {
    const artifacts = await canonicalJinnProofArtifacts();
    const environmentCid = rawCanonicalJsonCid(artifacts.environment);
    const receiptCid = rawCanonicalJsonCid(artifacts.receipt);
    const parsed = parseReceiptBoundJinnAnvilProofCli([
      '--environment-spec', '/secure/environment.json',
      '--environment-cid', cidField === 'environmentCid'
        ? 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
        : environmentCid,
      '--receipt', '/secure/receipt.json',
      '--receipt-cid', cidField === 'receiptCid'
        ? 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
        : receiptCid,
      '--expected-receipt-hash', hashDifferentialAdmissionReceiptV2(artifacts.receipt),
      '--approved-attester', `${approvedAttester}:${approvedAttester}`,
      '--evidence-output', '/secure/evidence.json',
    ]);
    const derivePatches = vi.fn(async () => { throw new Error('patch derivation must not start'); });
    const verifyReceipt = vi.fn(async ({ derivePatches: verifierDerive }) => {
      await verifierDerive();
      throw new Error('strict verifier must not run for an unrelated CID');
    });
    const runLifecycle = vi.fn();

    await expect(runReceiptBoundJinnAnvilProof(parsed, {
      readTextFile: async (path) => path.endsWith('environment.json')
        ? canonicalJson(artifacts.environment)
        : canonicalJson(artifacts.receipt),
      derivePatches,
      verifyReceipt,
      runLifecycle,
    })).rejects.toThrow(new RegExp(`${_artifact} CID.*canonical`, 'i'));
    expect(verifyReceipt).not.toHaveBeenCalled();
    expect(derivePatches).not.toHaveBeenCalled();
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('rejects a drifted artifact CID before it reads bytes or starts the Anvil lifecycle', async () => {
    const runLifecycle = vi.fn();
    const readTextFile = vi.fn(async () => '{}');
    await expect(runReceiptBoundJinnAnvilProof({
      ...invocation(),
      environmentCid: 'not-a-cid',
    }, {
      readTextFile,
      runLifecycle,
    })).rejects.toThrow(/environment CID/i);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('writes canonical receipt-bound lifecycle evidence without labelling the Anvil result empirical', async () => {
    const artifacts = await canonicalJinnProofArtifacts();
    const receiptHash = hashDifferentialAdmissionReceiptV2(artifacts.receipt);
    const environmentCid = rawCanonicalJsonCid(artifacts.environment);
    const receiptCid = rawCanonicalJsonCid(artifacts.receipt);
    const environmentBinding: ReceiptBoundJinnDifferentialProof['environment'] = {
      environmentSpecCid: environmentCid,
      environmentHash: artifacts.environment.attestation.environmentHash as `sha256:${string}`,
      attestation: artifacts.environment.attestation,
      parser: artifacts.environment.execution.parser,
      image: artifacts.environment.execution.image,
      platform: artifacts.environment.execution.platform,
    };
    const writes: Array<{ path: string; contents: string }> = [];
    const row = {
      instanceId: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.instanceId,
      rowHashVersion: 2 as const,
      publicRowHash: `sha256:${'c'.repeat(64)}` as const,
      FAIL_TO_PASS: artifacts.receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS),
      PASS_TO_PASS: artifacts.receipt.testPaths.flatMap((path) => path.PASS_TO_PASS),
    };

    await runReceiptBoundJinnAnvilProof(verifiedInvocation(artifacts), {
      readTextFile: async (path) => path.endsWith('environment.json')
        ? canonicalJson(artifacts.environment)
        : canonicalJson(artifacts.receipt),
      derivePatches: async () => ({
        goldPatch: 'test-only-gold-patch',
        testPatch: artifacts.testPatch,
        testPaths: JINN_MONO_DIFFERENTIAL_PROOF_SOURCE.testPaths,
        language: 'typescript',
      }),
      verifyReceipt: async () => ({
        receipt: artifacts.receipt,
        receiptHash,
        environment: artifacts.environment,
      }),
      bindReceipt: async (input): Promise<ReceiptBoundJinnDifferentialProof> => ({
        source: input.source,
        receipt: artifacts.receipt,
        receiptCid: input.receiptCid,
        receiptHash: input.receiptHash ?? receiptHash,
        environment: environmentBinding,
        testPatch: artifacts.testPatch,
      }),
      runLifecycle: async () => ({
        fixture: 'test-only-receipt-bound-lifecycle',
        taskId: '1',
        taskArtifactCid: 'bafy-test-only-task-artifact',
        environmentSpecCid: environmentCid,
        row,
        admissionReceipt: {
          kind: 'verified-differential-admission-receipt',
          receiptCid,
          receiptHash,
        },
        solutionDelivery: { requestId: `0x${'1'.repeat(64)}`, txHash: `0x${'2'.repeat(64)}` },
        verdictDelivery: { requestId: `0x${'3'.repeat(64)}`, txHash: `0x${'4'.repeat(64)}` },
        verdict: { code: 1, source: 'test-only-receipt-bound-lifecycle', passed: true },
        corpusEvidence: {
          taskArtifactCid: 'bafy-test-only-task-artifact',
          environmentSpecCid: environmentCid,
          receiptCid,
          receiptHash,
          publicRowHash: row.publicRowHash,
          solutionDeliveryTxHash: `0x${'2'.repeat(64)}`,
          verdictDeliveryTxHash: `0x${'4'.repeat(64)}`,
          solutionProjectionId: 'test-only-solution-projection',
          verdictProjectionId: 'test-only-verdict-projection',
        },
      }),
      atomicWriteEvidence: async (path, contents) => { writes.push({ path, contents }); },
    });

    expect(writes).toHaveLength(1);
    const evidence = JSON.parse(writes[0]!.contents);
    expect(evidence).toMatchObject({
      evidenceKind: 'receipt-bound-local-anvil-lifecycle',
      empiricalResult: {
        kind: 'docker-differential-admission-receipt',
        statement: expect.stringContaining('adds no empirical claim'),
      },
      row,
      environment: { environmentSpecCid: environmentCid },
      receipt: {
        receiptCid,
        receiptHash,
      },
    });
    expect(evidence.receipt.testPaths).toEqual(artifacts.receipt.testPaths.map((path) => ({
      testPath: path.testPath,
      FAIL_TO_PASS: path.FAIL_TO_PASS,
      PASS_TO_PASS: path.PASS_TO_PASS,
    })));
  });
});

function rawCanonicalJsonCid(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest();
  return `b${base32Encode(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let accumulator = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += alphabet[(accumulator >> bitCount) & 0x1f]!;
    }
  }
  if (bitCount > 0) encoded += alphabet[(accumulator << (5 - bitCount)) & 0x1f]!;
  return encoded;
}

async function canonicalJinnProofArtifacts(): Promise<{
  environment: TaskEnvironmentSpecV1;
  receipt: ReturnType<typeof createDifferentialAdmissionReceiptV2>;
  testPatch: string;
}> {
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const recipe = resolveJinnMonoRecipeV1(source.baseCommit);
  const recipeHash = `sha256:${createHash('sha256')
    .update(canonicalJson({ schemaVersion: 'jinn.environment-build-recipe.v1', recipe }))
    .digest('hex')}` as `sha256:${string}`;
  const unsigned: TaskEnvironmentSpecV1 = {
    schemaVersion: 'jinn.task-environment.v1',
    source: {
      repo: source.repo,
      repoUrl: 'https://github.com/Jinn-Network/mono.git',
      baseCommit: source.baseCommit,
    },
    inputs: [{
      inputRef: `git+https://github.com/Jinn-Network/mono.git#${source.baseCommit}`,
      sha256: `sha256:${'a'.repeat(64)}`,
      rights: {
        inputRef: `git+https://github.com/Jinn-Network/mono.git#${source.baseCommit}`,
        rightsRef: `https://api.github.com/repos/Jinn-Network/mono/license?ref=${source.baseCommit}`,
        basis: 'spdx',
        spdxId: 'Apache-2.0',
      },
    }],
    execution: {
      platform: recipe.platform,
      workspace: recipe.workspace,
      image: { reference: `ghcr.io/jinn-network/task-environment/jinn-mono@sha256:${'b'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}` },
      testCommands: recipe.testCommands,
      parser: recipe.parser,
      timeoutSeconds: recipe.timeoutSeconds,
      environment: recipe.environment,
    },
    build: {
      recipeCid: 'bafy-jinn-recipe',
      recipeHash,
      provider: 'explicit',
      providerId: recipe.recipeId,
      providerVersion: 'v1',
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-13T12:00:00.000Z',
      rightsPolicyVersion: 'jinn.publication-rights.v1',
      buildSmoke: 'pass',
      imageSecretScan: 'pass',
      sbomCid: 'bafy-jinn-sbom',
    },
    attestation: {
      scheme: 'eip191',
      algo: 'secp256k1',
      environmentHash: `sha256:${'0'.repeat(64)}`,
      operatorSafe: account.address,
      signer: account.address,
      signature: `0x${'0'.repeat(130)}`,
    },
  };
  const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
  const environment = parseTaskEnvironmentSpecV1({
    ...unsigned,
    attestation: {
      ...unsigned.attestation,
      environmentHash,
      signature: await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
    },
  });
  const testPatch = source.testPaths.map((path) => `diff --git a/${path} b/${path}\n`).join('');
  const receipt = createDifferentialAdmissionReceiptV2({
    task: {
      instanceId: source.instanceId,
      repo: source.repo,
      baseCommit: source.baseCommit,
      fixCommit: source.fixCommit,
    },
    goldPatchHash: `sha256:${createHash('sha256').update('test-only-gold-patch').digest('hex')}`,
    testPatchHash: `sha256:${createHash('sha256').update(testPatch).digest('hex')}`,
    environment,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    testPaths: source.testPaths.map((testPath, index) => {
      const assertion = `#1422 CID preflight fixture ${index + 1}`;
      const broken = { passed: [], failed: [assertion], passed_match: false };
      const fixed = { passed: [assertion], failed: [], passed_match: true };
      return {
        testPath,
        broken: [broken, broken],
        fixed: [fixed, fixed],
      };
    }),
  });
  return { environment, receipt, testPatch };
}
