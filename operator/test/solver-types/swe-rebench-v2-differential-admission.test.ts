import { describe, expect, it } from 'vitest';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
  targetRecipeCommandForTestPath,
  verifyDifferentialAdmissionReceiptV2,
} from '../../src/solver-types/_swe-rebench-v2-differential-admission.js';
import type { TaskEnvironmentSpecV1 } from '../../src/task-creator/environment/contracts.js';

const sha = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
const baseCommit = 'a'.repeat(40);
const fixCommit = 'b'.repeat(40);

function environmentFixture(cwd = 'client'): TaskEnvironmentSpecV1 {
  return {
    source: { repo: 'acme/widget', repoUrl: 'https://github.com/acme/widget.git', baseCommit },
    execution: {
      workspace: '/testbed',
      platform: 'linux/amd64',
      image: { reference: `ghcr.io/acme/widget@${sha('c')}`, digest: sha('c') },
      parser: { id: 'vitest-json.v1', version: 'v1', digest: sha('d'), bundleId: 'acme.v1' },
      testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json'], cwd }],
      timeoutSeconds: 300,
      environment: {},
    },
    attestation: { environmentHash: sha('e') },
  } as unknown as TaskEnvironmentSpecV1;
}

const broken = { passed: ['unaffected'], failed: ['regression'], passed_match: false };
const fixed = { passed: ['regression', 'unaffected'], failed: [], passed_match: true };

function receiptInput(overrides: Record<string, unknown> = {}) {
  return {
    task: { instanceId: 'acme__widget__echo-bbbbbbbbbbbb', repo: 'acme/widget', baseCommit, fixCommit },
    goldPatchHash: sha('f'),
    testPatchHash: sha('0'),
    environment: environmentFixture(),
    evalSemanticsVersion: '4',
    testPaths: [{
      testPath: 'operator/test/widget.test.ts',
      broken: [broken, broken],
      fixed: [fixed, fixed],
    }],
    ...overrides,
  };
}

describe('DifferentialAdmissionReceiptV2', () => {
  it('records canonical command hashes and stable F2P/P2P from two equal observations per side', () => {
    const receipt = createDifferentialAdmissionReceiptV2(receiptInput());

    expect(receipt.testPaths).toEqual([expect.objectContaining({
      testPath: 'operator/test/widget.test.ts',
      commandHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      FAIL_TO_PASS: ['regression'],
      PASS_TO_PASS: ['unaffected'],
      broken: [broken, broken],
      fixed: [fixed, fixed],
    })]);
    expect(receipt).not.toHaveProperty('goldPatch');
    expect(hashDifferentialAdmissionReceiptV2(receipt)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyDifferentialAdmissionReceiptV2(receipt)).toEqual(receipt);
  });

  it('rejects unstable parser output within one side', () => {
    expect(() => createDifferentialAdmissionReceiptV2(receiptInput({
      testPaths: [{
        testPath: 'operator/test/widget.test.ts',
        broken: [broken, { ...broken, failed: ['different'] }],
        fixed: [fixed, fixed],
      }],
    }))).toThrow(/stable/i);
  });

  it('rejects a test path without a fail-to-pass assertion', () => {
    const noF2p = { passed: ['unaffected'], failed: [], passed_match: true };
    expect(() => createDifferentialAdmissionReceiptV2(receiptInput({
      testPaths: [{
        testPath: 'operator/test/widget.test.ts',
        broken: [noF2p, noF2p],
        fixed: [noF2p, noF2p],
      }],
    }))).toThrow(/fail-to-pass/i);
  });

  it('rejects a raw assertion identifier used by more than one test path', () => {
    expect(() => createDifferentialAdmissionReceiptV2(receiptInput({
      testPaths: [
        { testPath: 'operator/test/one.test.ts', broken: [broken, broken], fixed: [fixed, fixed] },
        { testPath: 'operator/test/two.test.ts', broken: [broken, broken], fixed: [fixed, fixed] },
      ],
    }))).toThrow(/duplicate raw assertion/i);
  });
});

describe('targetRecipeCommandForTestPath', () => {
  it('strips the command workspace prefix and appends exactly one repo-safe target path', () => {
    expect(targetRecipeCommandForTestPath(environmentFixture(), 'operator/test/widget.test.ts')).toEqual({
      bin: 'yarn',
      args: ['vitest', 'run', '--reporter=json', 'test/widget.test.ts'],
      cwd: 'client',
    });
  });

  it('rejects an option-shaped test path segment before Vitest can parse it as a flag', () => {
    expect(() => targetRecipeCommandForTestPath(environmentFixture(), 'operator/--reporter=json')).toThrow(/option|unsafe/i);
  });

  it.each([
    ['traversal', environmentFixture(), '../test/widget.test.ts'],
    ['absolute', environmentFixture(), '/test/widget.test.ts'],
    ['outside command workspace', environmentFixture(), 'test/widget.test.ts'],
    ['workspace-escaping command cwd', environmentFixture('../outside'), 'operator/test/widget.test.ts'],
  ])('rejects an unsafe %s target', (_name, environment, testPath) => {
    expect(() => targetRecipeCommandForTestPath(environment, testPath)).toThrow(/safe|workspace|absolute|traversal/i);
  });
});
