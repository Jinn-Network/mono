import { createHash } from 'node:crypto';
import { createDifferentialAdmissionReceiptV2 } from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import type { TaskEnvironmentSpecV1 } from '../../src/task-creator/environment/contracts.js';
import { TRUSTED_VITEST_JSON_PARSER_V1 } from '../../src/task-creator/environment/recipes.js';
import { JINN_MONO_DIFFERENTIAL_PROOF_SOURCE } from '../../src/task-creator/proofs/public-repo-fixtures.js';

export function jinnDifferentialReceiptContractFixture() {
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  const goldPatch = 'test-only-jinn-gold-patch';
  const testPatch = source.testPaths.map((path) => `diff --git a/${path} b/${path}\n`).join('');
  const environmentSpec: TaskEnvironmentSpecV1 = {
    source: { repo: source.repo, repoUrl: 'https://github.com/Jinn-Network/mono.git', baseCommit: source.baseCommit },
    execution: {
      workspace: '/testbed',
      platform: 'linux/amd64',
      image: {
        reference: `registry.example.test/jinn-mono@sha256:${'a'.repeat(64)}`,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      parser: TRUSTED_VITEST_JSON_PARSER_V1,
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-results.json'], cwd: 'client' }],
      timeoutSeconds: 300,
      environment: { CI: '1' },
    },
    attestation: { environmentHash: `sha256:${'b'.repeat(64)}` },
  } as unknown as TaskEnvironmentSpecV1;
  const receipt = createDifferentialAdmissionReceiptV2({
    task: {
      instanceId: source.instanceId,
      repo: source.repo,
      baseCommit: source.baseCommit,
      fixCommit: source.fixCommit,
    },
    goldPatchHash: `sha256:${createHash('sha256').update(goldPatch).digest('hex')}`,
    testPatchHash: `sha256:${createHash('sha256').update(testPatch).digest('hex')}`,
    environment: environmentSpec,
    evalSemanticsVersion: '4',
    testPaths: source.testPaths.map((testPath, index) => {
      const assertion = `#1422 test fixture ${index + 1}`;
      const broken = { passed: [], failed: [assertion], passed_match: false };
      const fixed = { passed: [assertion], failed: [], passed_match: true };
      return { testPath, broken: [broken, broken], fixed: [fixed, fixed] };
    }),
  });
  return {
    receipt,
    goldPatch,
    testPatch,
    environment: {
      environmentSpecCid: 'bafy-test-only-jinn-environment',
      environmentHash: environmentSpec.attestation.environmentHash,
      attestation: {
        scheme: 'eip191',
        algo: 'secp256k1',
        environmentHash: environmentSpec.attestation.environmentHash,
        operatorSafe: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
        signer: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
        signature: '0x4c01e1d9f21a5688727b0cdc318cf00c9c151df350675b476ea58b6fb4ce554e307e3fbaf63c32671ba78cf0025747a1a345d4e783463f154d2de6f27141f0a31b',
      },
      parser: environmentSpec.execution.parser,
      image: environmentSpec.execution.image,
      platform: 'linux/amd64' as const,
    },
  };
}
