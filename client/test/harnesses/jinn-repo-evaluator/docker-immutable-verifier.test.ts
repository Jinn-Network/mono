import { describe, expect, it } from 'vitest';
import type { AutopilotEvaluationContext } from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  makeDockerImmutableMechanicalVerifier,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/docker-immutable-verifier.js';

const CONTEXT = {} as AutopilotEvaluationContext;

describe('Docker immutable mechanical verifier', () => {
  it('reports Docker unavailability before a review is claimed', async () => {
    const verifier = makeDockerImmutableMechanicalVerifier({
      runDocker: async (_args, label) => label === 'docker-readiness'
        ? { status: 'failed', detail: 'Cannot connect to the Docker daemon' }
        : { status: 'passed' },
    });

    await expect(verifier.isReady?.()).resolves.toEqual({
      ready: false,
      reason: 'Docker immutable verifier unavailable: Cannot connect to the Docker daemon',
    });
  });

  it('prepares the pinned image and validates its offline native toolchain', async () => {
    const calls: Array<{ args: readonly string[]; label: string }> = [];
    const verifier = makeDockerImmutableMechanicalVerifier({
      runDocker: async (args, label) => {
        calls.push({ args, label });
        return label === 'verification-image-inspect'
          ? { status: 'failed', detail: 'not found' }
          : { status: 'passed' };
      },
    });

    await expect(verifier.isReady?.()).resolves.toEqual({ ready: true });
    expect(calls.map(({ label }) => label)).toEqual([
      'docker-readiness',
      'verification-image-inspect',
      'verification-image-pull',
      'verification-native-toolchain-smoke',
    ]);
    expect(
      calls.find(({ label }) =>
        label === 'verification-native-toolchain-smoke')?.args,
    ).toContain('/tmp:rw,exec,nosuid,nodev,size=134217728');
  });

  it('copies the checkout read-only and executes candidate checks offline', async () => {
    const calls: Array<{ args: readonly string[]; label: string }> = [];
    const verifier = makeDockerImmutableMechanicalVerifier({
      containerName: () => 'jinn-evaluator-verify-test',
      pathExists: async (path) =>
        path.endsWith('/client/test/harnesses/engine/engine.test.ts'),
      runDocker: async (args, label) => {
        calls.push({ args, label });
        return { status: 'passed' };
      },
    });

    await expect(verifier.verify({
      context: CONTEXT,
      checkoutDir: '/trusted/exact-head',
      changedFiles: ['client/src/harnesses/engine/engine.ts'],
    })).resolves.toEqual({
      kind: 'passed',
      checks: [
        'client:typecheck',
        'client:test',
      ],
    });

    const create = calls.find(({ label }) => label === 'sandbox-container-create')!;
    expect(create.args[0]).toBe('run');
    expect(create.args).toContain('--detach');
    expect(create.args).toContain('--rm');
    expect(create.args).toContain('jinn.autopilot.evaluator-verification=true');
    expect(create.args).toContain('sleep 7200');
    expect(create.args.join(' ')).not.toContain('/trusted/exact-head');
    expect(create.args).toContain(
      '/source:rw,nosuid,nodev,noexec,size=1073741824',
    );
    expect(create.args).toContain(
      '/workspace:rw,exec,nosuid,nodev,size=6442450944',
    );
    expect(create.args).toContain('8g');
    expect(create.args).toContain('YARN_IGNORE_PATH=1');
    expect(create.args).toContain('YARN_NODE_LINKER=node-modules');
    expect(create.args).toContain('YARN_ENABLE_SCRIPTS=false');
    expect(calls.find(({ label }) => label === 'sandbox-source-upload'))
      .toEqual({
        args: [
          'cp',
          '/trusted/exact-head/.',
          'jinn-evaluator-verify-test:/source',
        ],
        label: 'sandbox-source-upload',
      });
    const seed = calls.find(({ label }) => label === 'sandbox-source-copy')!;
    expect(seed.args.join(' ')).toContain('node_modules');
    expect(seed.args.join(' ')).toContain('dist');
    const candidate = calls.filter(({ label }) =>
      label.endsWith(':typecheck') || label.endsWith(':test'));
    expect(candidate.map(({ label }) => label)).toEqual([
      'client:typecheck',
      'client:test',
    ]);
    for (const call of candidate) {
      expect(call.args[0]).toBe('exec');
    }
    expect(calls.filter(({ label }) => label.endsWith(':install')))
      .toHaveLength(5);
    for (const install of calls.filter(({ label }) => label.endsWith(':install'))) {
      expect(install.args.slice(-4)).toEqual([
        'yarn@4.13.0',
        'install',
        '--immutable',
        '--mode=skip-build',
      ]);
    }
    const disconnectIndex = calls.findIndex(({ label }) =>
      label === 'sandbox-network-disconnect');
    expect(disconnectIndex).toBeLessThan(
      calls.findIndex(({ label }) => label === 'client:typecheck'),
    );
    expect(calls.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        'packages/core:trusted-native-rebuild',
        'client:trusted-native-rebuild',
      ]),
    );
    for (const rebuild of calls.filter(({ label }) =>
      label.endsWith(':trusted-native-rebuild')
    )) {
      expect(rebuild.args).toContain('npm_config_nodedir=/usr/local');
    }
    const labels = calls.map(({ label }) => label);
    expect(labels.indexOf('packages/sdk:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/plugin:trusted-bootstrap-build'));
    expect(labels.indexOf('packages/plugin:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/core:trusted-bootstrap-build'));
    expect(labels.indexOf('packages/core:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/layer:trusted-bootstrap-build'));
    expect(labels.indexOf('packages/layer:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('client:typecheck'));
    expect(calls.at(-1)?.label).toBe('sandbox-container-remove');
  });

  it('removes the container with a fresh signal after session cancellation', async () => {
    const controller = new AbortController();
    const calls: Array<{
      readonly label: string;
      readonly aborted: boolean | undefined;
    }> = [];
    const verifier = makeDockerImmutableMechanicalVerifier({
      containerName: () => 'jinn-evaluator-verify-cancel-cleanup',
      pathExists: async () => false,
      runDocker: async (_args, label, abort) => {
        calls.push({ label, aborted: abort?.aborted });
        if (label === 'client:test') controller.abort();
        return { status: 'passed' };
      },
    });

    await expect(verifier.verify({
      context: CONTEXT,
      checkoutDir: '/trusted/exact-head',
      changedFiles: ['client/src/harnesses/engine/engine.ts'],
      abort: controller.signal,
    })).resolves.toMatchObject({ kind: 'passed' });

    expect(calls.at(-1)).toEqual({
      label: 'sandbox-container-remove',
      aborted: false,
    });
  });

  it('classifies candidate check failures without skipping volume cleanup', async () => {
    const labels: string[] = [];
    const verifier = makeDockerImmutableMechanicalVerifier({
      containerName: () => 'jinn-evaluator-verify-failed',
      pathExists: async () => false,
      runDocker: async (_args, label) => {
        labels.push(label);
        return label === 'packages/sdk:typecheck'
          ? { status: 'failed', detail: 'TS2322' }
          : { status: 'passed' };
      },
    });

    await expect(verifier.verify({
      context: CONTEXT,
      checkoutDir: '/trusted/exact-head',
      changedFiles: ['packages/sdk/src/autopilot-session.ts'],
    })).resolves.toEqual({
      kind: 'failed',
      check: 'packages/sdk:typecheck',
      detail: 'TS2322',
    });
    expect(labels.at(-1)).toBe('sandbox-container-remove');
    expect(labels).not.toContain('packages/sdk:test');
  });
});
