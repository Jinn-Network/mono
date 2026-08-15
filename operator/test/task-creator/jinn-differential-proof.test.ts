import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../../src/util/canonical-json.js';
import type { EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  type TaskEnvironmentSpecV1,
} from '../../src/task-creator/environment/contracts.js';
import {
  TRUSTED_VITEST_JSON_PARSER_V1,
  resolveJinnMonoRecipeV1,
} from '../../src/task-creator/environment/recipes.js';
import {
  JINN_DIFFERENTIAL_PROOF_SOURCE,
  LocalJinnVitestRunner,
  assertJinnDifferentialSource,
  ensurePublishedJinnDifferentialImage,
  parseJinnDifferentialEnvironment,
  parseJinnDifferentialProofCli,
  verifyJinnDifferentialReceipt,
  writeJinnDifferentialReceipt,
} from '../../scripts/task-creator-jinn-differential-proof.js';

const sha = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
const TEST_PATCH = [
  'diff --git a/operator/test/daemon/daemon-recovery-nonblocking.test.ts b/operator/test/daemon/daemon-recovery-nonblocking.test.ts\n',
  'diff --git a/operator/test/harnesses/engine/recovery.test.ts b/operator/test/harnesses/engine/recovery.test.ts\n',
].join('');
const GOLD_PATCH = 'diff --git a/operator/src/daemon/daemon.ts b/operator/src/daemon/daemon.ts\n';
const TEST_APPROVED_ATTESTER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const TEST_ATTESTER_POLICY = {
  approvedAttesters: [{ operatorSafe: TEST_APPROVED_ATTESTER, signer: TEST_APPROVED_ATTESTER }],
};

describe('Jinn differential proof command', () => {
  it('rejects the stale documentation-only merge SHA', () => {
    expect(() => assertJinnDifferentialSource({
      ...JINN_DIFFERENTIAL_PROOF_SOURCE,
      fixCommit: '5b76bade319857bd09a72c3c4aaf0949cfe078ee',
    })).toThrow(/stale|docs-only|ef960887/i);
  });

  it('requires both reviewed target paths', () => {
    expect(() => assertJinnDifferentialSource({
      ...JINN_DIFFERENTIAL_PROOF_SOURCE,
      testPaths: [JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths[0]!],
    })).toThrow(/target paths|both/i);
  });

  it('rejects a self-consistent Jinn environment with an altered canonical recipe hash', async () => {
    await expect(parseJinnDifferentialEnvironment(await signedEnvironmentSpec({
      build: { recipeHash: sha('f') },
    }), TEST_ATTESTER_POLICY)).rejects.toThrow(/recipe.*hash|hash.*recipe/i);
  });

  it('rejects a self-consistent Jinn environment with a non-canonical build provider', async () => {
    await expect(parseJinnDifferentialEnvironment(await signedEnvironmentSpec({
      build: { providerId: 'arbitrary-jinn-provider.v1' },
    }), TEST_ATTESTER_POLICY)).rejects.toThrow(/provider/i);
  });

  it('rejects a self-consistent Jinn environment with an altered test-command template', async () => {
    await expect(parseJinnDifferentialEnvironment(await signedEnvironmentSpec({
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--passWithNoTests'], cwd: 'client' }],
    }), TEST_ATTESTER_POLICY)).rejects.toThrow(/test.*command|command.*template/i);
  });

  it('rejects a cryptographically valid environment attestation from an unapproved signer', async () => {
    await expect(parseJinnDifferentialEnvironment(await signedEnvironmentSpec({
      privateKey: `0x${'2'.repeat(64)}`,
    }), TEST_ATTESTER_POLICY)).rejects.toThrow(/attest|signer|approved/i);
  });

  it('verify-only revalidates canonical source-bound evidence without invoking Docker', async () => {
    const environmentSpec = await signedEnvironmentSpec();
    const receipt = receiptFor(environmentSpec);

    await expect(verifyJinnDifferentialReceipt({
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      environmentSpec,
      receiptContents: canonicalJson(receipt),
      expectedReceiptHash: hashDifferentialAdmissionReceiptV2(receipt),
      derivePatches: async () => testPatches(),
    })).resolves.toMatchObject({
      receiptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      receipt,
      environment: {
        attestation: { environmentHash: environmentSpec.attestation.environmentHash },
      },
    });
  });

  it('verify-only rejects a receipt whose environment binding drifts from the signed environment', async () => {
    const environmentSpec = await signedEnvironmentSpec();
    const receipt = receiptFor(environmentSpec);
    const drifted = {
      ...receipt,
      environment: {
        ...receipt.environment,
        image: { reference: `registry.example.test/jinn@${sha('f')}`, digest: sha('f') },
      },
    };

    await expect(verifyJinnDifferentialReceipt({
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      environmentSpec,
      receiptContents: canonicalJson(drifted),
      expectedReceiptHash: hashDifferentialAdmissionReceiptV2(drifted),
      derivePatches: async () => testPatches(),
    })).rejects.toThrow(/environment.*binding|binding.*environment/i);
  });

  it('verify-only rejects noncanonical receipt bytes before trusting its evidence', async () => {
    const environmentSpec = await signedEnvironmentSpec();

    await expect(verifyJinnDifferentialReceipt({
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      environmentSpec,
      receiptContents: `${canonicalJson(receiptFor(environmentSpec))}\n`,
      expectedReceiptHash: hashDifferentialAdmissionReceiptV2(receiptFor(environmentSpec)),
      derivePatches: async () => testPatches(),
    })).rejects.toThrow(/canonical/i);
  });

  it('verify-only rejects a declared receipt hash that does not bind the receipt', async () => {
    const environmentSpec = await signedEnvironmentSpec();
    const receipt = receiptFor(environmentSpec);

    await expect(verifyJinnDifferentialReceipt({
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      environmentSpec,
      receiptContents: canonicalJson(receipt),
      expectedReceiptHash: sha('e'),
      derivePatches: async () => testPatches(),
    })).rejects.toThrow(/expected.*hash|hash.*expected/i);
  });

  it('verify-only rejects a receipt whose derived command binding drifts', async () => {
    const environmentSpec = await signedEnvironmentSpec();
    const receipt = receiptFor(environmentSpec);
    const drifted = {
      ...receipt,
      testPaths: receipt.testPaths.map((path, index) => index === 0
        ? { ...path, commandHash: sha('f') }
        : path),
    };

    await expect(verifyJinnDifferentialReceipt({
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      environmentSpec,
      receiptContents: canonicalJson(drifted),
      expectedReceiptHash: hashDifferentialAdmissionReceiptV2(drifted),
      derivePatches: async () => testPatches(),
    })).rejects.toThrow(/command binding/i);
  });

  it('verify CLI requires an expected receipt hash and rejects generation or publication flags', () => {
    expect(() => parseJinnDifferentialProofCli([
      '--verify', '/secure/receipt.json',
      '--environment-spec', '/secure/environment.json',
      '--approved-attester', `${TEST_APPROVED_ATTESTER}:${TEST_APPROVED_ATTESTER}`,
    ])).toThrow(/expected-receipt-hash/i);

    const expectedReceiptHash = sha('d');
    expect(() => parseJinnDifferentialProofCli([
      '--verify', '/secure/receipt.json',
      '--environment-spec', '/secure/environment.json',
      '--approved-attester', `${TEST_APPROVED_ATTESTER}:${TEST_APPROVED_ATTESTER}`,
      '--expected-receipt-hash', expectedReceiptHash,
      '--output', '/secure/other.json',
    ])).toThrow(/must not.*output/i);
    expect(() => parseJinnDifferentialProofCli([
      '--verify', '/secure/receipt.json',
      '--environment-spec', '/secure/environment.json',
      '--expected-receipt-hash', expectedReceiptHash,
      '--approved-attester', `${TEST_APPROVED_ATTESTER}:${TEST_APPROVED_ATTESTER}`,
      '--ipfs-registry', 'https://ipfs.example.test',
    ])).toThrow(/must not.*ipfs-registry/i);

    expect(parseJinnDifferentialProofCli([
      '--verify', '/secure/receipt.json',
      '--environment-spec', '/secure/environment.json',
      '--expected-receipt-hash', expectedReceiptHash,
      '--approved-attester', `${TEST_APPROVED_ATTESTER}:${TEST_APPROVED_ATTESTER}`,
    ])).toEqual({
      mode: 'verify',
      receiptPath: '/secure/receipt.json',
      environmentSpecPath: '/secure/environment.json',
      expectedReceiptHash,
      attesterPolicy: TEST_ATTESTER_POLICY,
      repoPath: undefined,
    });
  });

  it('pulls the exact signed digest and inspects it before any local no-pull proof run', async () => {
    const environment = await signedEnvironmentSpec();
    const calls: string[][] = [];

    await expect(ensurePublishedJinnDifferentialImage(environment, async (args) => {
      calls.push(args);
      if (args[0] === 'pull') return { exitCode: 0, stdout: 'pulled', stderr: '' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Id: sha('c'),
          Os: 'linux',
          Architecture: 'amd64',
          RepoDigests: [environment.execution.image.reference],
        }),
        stderr: '',
      };
    })).resolves.toEqual({
      reference: environment.execution.image.reference,
      localImageId: sha('c'),
    });

    expect(calls).toEqual([
      ['pull', '--platform', 'linux/amd64', environment.execution.image.reference],
      ['image', 'inspect', environment.execution.image.reference, '--format', '{{json .}}'],
    ]);
  });

  it('fails closed when the signed digest image cannot be pulled locally', async () => {
    const environment = await signedEnvironmentSpec();
    const calls: string[][] = [];

    await expect(ensurePublishedJinnDifferentialImage(environment, async (args) => {
      calls.push(args);
      return { exitCode: 1, stdout: '', stderr: 'manifest unknown' };
    })).rejects.toThrow(/pull.*published.*image|published.*image.*pull/i);

    expect(calls).toEqual([['pull', '--platform', 'linux/amd64', environment.execution.image.reference]]);
  });

  it('rejects an inspected image whose platform or immutable digest binding drifts from the signed environment', async () => {
    const environment = await signedEnvironmentSpec();
    const inspect = async (value: Record<string, unknown>) => ensurePublishedJinnDifferentialImage(
      environment,
      async (args) => args[0] === 'pull'
        ? { exitCode: 0, stdout: 'pulled', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify(value), stderr: '' },
    );

    await expect(inspect({
      Id: sha('c'), Os: 'linux', Architecture: 'arm64', RepoDigests: [environment.execution.image.reference],
    })).rejects.toThrow(/linux\/amd64/i);
    await expect(inspect({
      Id: sha('c'), Os: 'linux', Architecture: 'amd64', RepoDigests: [`ghcr.io/jinn-network/task-environment/jinn-mono@${sha('f')}`],
    })).rejects.toThrow(/digest.*binding|binding.*digest|signed.*digest/i);
    await expect(inspect({
      Id: 'sha256:not-an-image-id', Os: 'linux', Architecture: 'amd64', RepoDigests: [environment.execution.image.reference],
    })).rejects.toThrow(/immutable.*image.*ID/i);
  });

  it('derives a sanitised receipt from a verified signed environment and exactly eight target-state observations', async () => {
    const environmentSpec = await signedEnvironmentSpec();
    const calls: Parameters<EvalRunner['runEval']>[0][] = [];
    const writes: Array<{ path: string; contents: string }> = [];
    const result = await writeJinnDifferentialReceipt({
      outputPath: '/tmp/jinn-real-differential-receipt.json',
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      derivePatches: async () => ({
        goldPatch: GOLD_PATCH,
        testPatch: TEST_PATCH,
        testPaths: [...JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths],
        language: 'typescript',
      }),
      environmentSpec,
      runner: simulatedRunner(calls),
      atomicWrite: async (path, contents) => { writes.push({ path, contents }); },
    });

    expect(calls).toHaveLength(8);
    for (const path of JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths) {
      const pathCalls = calls.filter((call) => typeof call.test_cmd === 'string' && call.test_cmd.endsWith(path.slice('operator/'.length)));
      expect(pathCalls).toHaveLength(4);
      expect(pathCalls.map((call) => call.patch)).toEqual(['', '', GOLD_PATCH, GOLD_PATCH]);
      expect(pathCalls.every((call) => call.image === environmentSpec.execution.image.reference)).toBe(true);
      expect(pathCalls.every((call) => call.log_parser === environmentSpec.execution.parser.id)).toBe(true);
    }
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.contents)).not.toHaveProperty('goldPatch');
    expect(result.receipt.environment).toEqual({
      environmentHash: environmentSpec.attestation.environmentHash,
      image: environmentSpec.execution.image,
      parser: environmentSpec.execution.parser,
      platform: environmentSpec.execution.platform,
    });
    expect(result.receipt.testPaths.map((path) => path.testPath)).toEqual(JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths);
  });

  it('rejects an incomplete or unsigned environment before deriving patches or writing a receipt', async () => {
    const writes: string[] = [];
    let derived = false;
    await expect(writeJinnDifferentialReceipt({
      outputPath: '/tmp/should-not-exist.json',
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      derivePatches: async () => {
        derived = true;
        return { goldPatch: GOLD_PATCH, testPatch: TEST_PATCH, testPaths: [...JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths], language: 'typescript' };
      },
      environmentSpec: {
        source: { repo: JINN_DIFFERENTIAL_PROOF_SOURCE.repo, baseCommit: JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit },
      },
      runner: simulatedRunner([]),
      atomicWrite: async (path) => { writes.push(path); },
    })).rejects.toThrow(/schema|execution|environment/i);
    expect(derived).toBe(false);
    expect(writes).toEqual([]);
  });

  it('rejects a structurally valid environment whose EIP-191 attestation signature is not authentic', async () => {
    const valid = await signedEnvironmentSpec();
    let derived = false;
    await expect(writeJinnDifferentialReceipt({
      outputPath: '/tmp/should-not-exist.json',
      source: JINN_DIFFERENTIAL_PROOF_SOURCE,
      attesterPolicy: TEST_ATTESTER_POLICY,
      derivePatches: async () => {
        derived = true;
        return { goldPatch: GOLD_PATCH, testPatch: TEST_PATCH, testPaths: [...JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths], language: 'typescript' };
      },
      environmentSpec: {
        ...valid,
        attestation: { ...valid.attestation, signature: `0x${'0'.repeat(130)}` },
      },
      runner: simulatedRunner([]),
    })).rejects.toThrow(/signature/i);
    expect(derived).toBe(false);
  });

  it('bounds a timed-out Docker run and forcibly removes its container', async () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const runner = new LocalJinnVitestRunner('example/jinn@' + sha('f'), 1, async (args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (args[0] === 'create') return { exitCode: 0, stdout: 'a'.repeat(64), stderr: '' };
      if (args[0] === 'start') return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runner.runEval({
      instance_id: JINN_DIFFERENTIAL_PROOF_SOURCE.instanceId,
      repo: JINN_DIFFERENTIAL_PROOF_SOURCE.repo,
      image: 'example/jinn@' + sha('f'),
      patch: '',
      test_patch: TEST_PATCH,
      test_cmd: 'cd operator && yarn vitest run test/daemon/daemon-recovery-nonblocking.test.ts',
      log_parser: 'vitest-json.v1',
      fail_to_pass: [],
      pass_to_pass: [],
    })).rejects.toThrow(/timed out/i);

    expect(calls.some((call) => call.args[0] === 'rm' && call.args[1] === '-f')).toBe(true);
    expect(calls.every((call) => call.timeoutMs === 1_000)).toBe(true);
  });
});

function simulatedRunner(calls: Parameters<EvalRunner['runEval']>[0][]): EvalRunner {
  return {
    async runEval(input) {
      calls.push(input);
      const path = JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths.find((candidate) =>
        typeof input.test_cmd === 'string' && input.test_cmd.endsWith(candidate.slice('operator/'.length)),
      );
      if (!path) throw new Error(`unexpected target command ${String(input.test_cmd)}`);
      const assertion = `#1422 ${path}`;
      const fixed = input.patch === GOLD_PATCH;
      return {
        passed_match: fixed,
        passed: fixed ? [assertion] : [],
        failed: fixed ? [] : [assertion],
        log: '',
        exitCode: fixed ? 0 : 1,
      };
    },
  };
}

function testPatches() {
  return {
    goldPatch: GOLD_PATCH,
    testPatch: TEST_PATCH,
    testPaths: [...JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths],
    language: 'typescript',
  };
}

function receiptFor(environment: TaskEnvironmentSpecV1) {
  return createDifferentialAdmissionReceiptV2({
    task: {
      instanceId: JINN_DIFFERENTIAL_PROOF_SOURCE.instanceId,
      repo: JINN_DIFFERENTIAL_PROOF_SOURCE.repo,
      baseCommit: JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit,
      fixCommit: JINN_DIFFERENTIAL_PROOF_SOURCE.fixCommit,
    },
    goldPatchHash: `sha256:${createHash('sha256').update(GOLD_PATCH).digest('hex')}`,
    testPatchHash: `sha256:${createHash('sha256').update(TEST_PATCH).digest('hex')}`,
    environment,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    testPaths: JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths.map((testPath, index) => {
      const assertion = `#1422 verify fixture ${index + 1}`;
      const broken = { passed: [], failed: [assertion], passed_match: false };
      const fixed = { passed: [assertion], failed: [], passed_match: true };
      return { testPath, broken: [broken, broken], fixed: [fixed, fixed] };
    }),
  });
}

async function signedEnvironmentSpec(args: {
  build?: Partial<TaskEnvironmentSpecV1['build']>;
  testCommands?: TaskEnvironmentSpecV1['execution']['testCommands'];
  privateKey?: `0x${string}`;
} = {}): Promise<TaskEnvironmentSpecV1> {
  const account = privateKeyToAccount(args.privateKey ?? `0x${'1'.repeat(64)}`);
  const recipe = resolveJinnMonoRecipeV1(JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit);
  const recipeHash = `sha256:${createHash('sha256').update(canonicalJson({ schemaVersion: 'jinn.environment-build-recipe.v1', recipe })).digest('hex')}` as `sha256:${string}`;
  const unsigned: TaskEnvironmentSpecV1 = {
    schemaVersion: 'jinn.task-environment.v1',
    source: {
      repo: JINN_DIFFERENTIAL_PROOF_SOURCE.repo,
      repoUrl: 'https://github.com/Jinn-Network/mono.git',
      baseCommit: JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit,
    },
    inputs: [{
      inputRef: `git+https://github.com/Jinn-Network/mono.git#${JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit}`,
      sha256: sha('a'),
      rights: {
        inputRef: `git+https://github.com/Jinn-Network/mono.git#${JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit}`,
        rightsRef: `https://api.github.com/repos/Jinn-Network/mono/license?ref=${JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit}`,
        basis: 'spdx',
        spdxId: 'Apache-2.0',
      },
    }],
    execution: {
      platform: 'linux/amd64',
      workspace: '/testbed',
      image: { reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${sha('b')}`, digest: sha('b') },
      testCommands: args.testCommands ?? [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-results.json'], cwd: 'client' }],
      parser: TRUSTED_VITEST_JSON_PARSER_V1,
      timeoutSeconds: 300,
      environment: { CI: '1' },
    },
    build: {
      recipeCid: 'bafyrecipe', recipeHash, provider: 'explicit', providerId: 'jinn-mono.v1', providerVersion: 'v1',
      ...args.build,
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-12T10:00:00.000Z', rightsPolicyVersion: 'jinn.publication-rights.v1', buildSmoke: 'pass', imageSecretScan: 'pass', sbomCid: 'bafysbom',
    },
    attestation: {
      scheme: 'eip191', algo: 'secp256k1', environmentHash: sha('e'), operatorSafe: account.address, signer: account.address, signature: `0x${'0'.repeat(130)}`,
    },
  };
  const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
  const signature = await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) });
  return parseTaskEnvironmentSpecV1({
    ...unsigned,
    attestation: { ...unsigned.attestation, environmentHash, signature },
  });
}
