import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  makeProductionMarketplaceAdoptionReceiptPorts,
  makeProductionMarketplaceVerificationPort,
  MarketplaceVerificationUnreapedError,
} from '../../src/lifecycle/marketplace-mutation-adoption-production.js';

const HEAD = '1'.repeat(40);
const directories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-production-'));
  directories.push(root);
  const manifestPath = join(root, 'manifest.json');
  const tokenFile = join(root, 'gh-token');
  writeFileSync(tokenFile, 'attempt-secret\n', { mode: 0o600 });
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: '123e4567-e89b-42d3-a456-426614174001',
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    subject: 'issue-2001',
    issueNumber: 2001,
    prNumber: 2101,
    branch: 'codex/issue-2001',
    targetBase: 'next',
    expectedHead: HEAD,
    claimOid: '2'.repeat(40),
    selectedLogin: 'jinn-autopilot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      remoteUrlHash: 'c'.repeat(64),
    },
    execution: { backend: 'local' },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: root,
      worktree: join(root, 'worktree'),
      manifest: manifestPath,
      log: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpass: join(root, 'askpass.sh'),
      tokenFile,
    },
    timestamps: {
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
      childStartedAt: '2026-07-24T12:00:00.000Z',
    },
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production marketplace adoption receipt ports', () => {
  it('requires the exact active review generation for an accepted Solution receipt', async () => {
    const manifest = fixture();
    const generation = '123e4567-e89b-42d3-a456-426614174010';
    const reviewRefOid = '5'.repeat(40);
    let state = 'active';
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({ headRefOid: HEAD });
      }
      if (command === 'git' && args.includes('ls-remote')) {
        return `${reviewRefOid}\trefs/jinn-autopilot/review-claims/v1/2101\n`;
      }
      if (command === 'git' && args.includes('fetch')) return '';
      if (command === 'git' && args.includes('rev-list')) {
        return `${reviewRefOid}\n`;
      }
      if (command === 'git' && args.includes('show')) {
        return JSON.stringify({
          protocolVersion: 2,
          prNumber: 2101,
          generation,
          attempt: '123e4567-e89b-42d3-a456-426614174099',
          reviewer: 'review-bot',
          head: HEAD,
          state,
          recordedAt: '2026-07-24T12:00:00.000Z',
        });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
    });
    const receipt = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'accepted',
      role: 'solution',
      operation: 'implementation-complete',
      taskId: '501',
      attemptIndex: 0,
      requestId: 'request',
      deliveryEnvelopeCid: 'bafy-envelope',
      v2AttemptId: manifest.attemptId,
      claimOid: manifest.claimOid,
      prNumber: 2101,
      expectedHead: manifest.expectedHead,
      resultingHead: HEAD,
      reviewGeneration: generation,
      reviewRefOid,
      recordedAt: '2026-07-24T12:01:00.000Z',
    } as const;
    const exactFacts = {
      role: 'solution' as const,
      correlation: receipt,
      prHead: HEAD,
    };

    await expect(ports.verifyReceiptFacts({
      exactFacts,
      receipt,
    })).resolves.toBe(true);
    state = 'human';
    await expect(ports.verifyReceiptFacts({
      exactFacts,
      receipt,
    })).resolves.toBe(false);
  });

  it('uses the attempt credential and preserves exact-head comment readback', async () => {
    const manifest = fixture();
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
    }> = [];
    const runner = vi.fn(async (
      command: string,
      args: string[],
      options?: { readonly env?: Record<string, string> },
    ) => {
      calls.push({
        command,
        args,
        environment: options?.env ?? {},
      });
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: HEAD });
      if (args.includes('POST')) return JSON.stringify({ id: 73 });
      return JSON.stringify([
        {
          id: 71,
          user: null,
          body: null,
          created_at: '2026-07-24T12:00:00.000Z',
          updated_at: '2026-07-24T12:00:00.000Z',
        },
        {
          id: 72,
          user: { login: 'jinn-autopilot' },
          body: 'receipt',
          created_at: '2026-07-24T12:01:00.000Z',
          updated_at: '2026-07-24T12:01:00.000Z',
        },
      ]);
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
      environment: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ambient-secret',
      },
    });

    await expect(ports.listPrIssueComments({ prNumber: 2101 }))
      .resolves.toEqual({
        comments: [{
          id: 72,
          authorLogin: 'jinn-autopilot',
          body: 'receipt',
          createdAt: '2026-07-24T12:01:00.000Z',
          updatedAt: '2026-07-24T12:01:00.000Z',
        }],
      });
    await expect(ports.verifyReceiptFacts({
      exactFacts: {
        role: 'solution',
        correlation: {
          taskId: '501',
          attemptIndex: 0,
          requestId: 'request',
          deliveryEnvelopeCid: 'bafy-envelope',
          v2AttemptId: manifest.attemptId,
          claimOid: manifest.claimOid,
          prNumber: 2101,
          expectedHead: HEAD,
        },
        prHead: HEAD,
      },
      receipt: {} as never,
    })).resolves.toBe(true);
    await expect(ports.createPrComment({
      prNumber: 2101,
      expectedHead: HEAD,
      body: 'canonical receipt',
    })).resolves.toEqual({ commentId: 73 });
    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.environment.GH_TOKEN).toBe('attempt-secret');
      expect(call.environment.GITHUB_TOKEN).toBe('');
    }
  });

  it('continues pagination from raw full pages after filtering deleted authors', async () => {
    const manifest = fixture();
    const rawPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      user: index === 0 ? null : { login: `user-${index}` },
      body: index === 0 ? null : `comment-${index}`,
      created_at: '2026-07-24T12:01:00.000Z',
      updated_at: '2026-07-24T12:01:00.000Z',
    }));
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner: async () => JSON.stringify(rawPage),
    });

    await expect(ports.listPrIssueComments({ prNumber: 2101 }))
      .resolves.toMatchObject({
        comments: expect.arrayContaining([
          expect.objectContaining({ id: 100, body: 'comment-99' }),
        ]),
        nextCursor: '2',
      });
    const page = await ports.listPrIssueComments({ prNumber: 2101 });
    expect(page.comments).toHaveLength(99);
  });

  it('binds accepted review findings to the exact stale generation, native review, labels, and child', async () => {
    const manifest = fixture();
    const generation = '123e4567-e89b-42d3-a456-426614174010';
    const attempt = '123e4567-e89b-42d3-a456-426614174099';
    const marker = '123e4567-e89b-42d3-a456-426614174098';
    const rootOid = '5'.repeat(40);
    const currentOid = '6'.repeat(40);
    const intentOid = '7'.repeat(40);
    const advancedOid = '8'.repeat(40);
    const advancedHead = '9'.repeat(40);
    let advanced = false;
    let childState = 'OPEN';
    const common = {
      protocolVersion: 2,
      prNumber: 2101,
      generation,
      attempt,
      reviewer: 'jinn-autopilot',
      head: HEAD,
      recordedAt: '2026-07-24T12:00:00.000Z',
    };
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          headRefOid: advanced ? advancedHead : HEAD,
          labels: advanced ? [] : [{ name: 'review:changes-requested' }],
        });
      }
      if (command === 'gh' && args[0] === 'issue') {
        return JSON.stringify({
          number: 2201,
          state: childState,
          body: '<!-- jinn-autopilot:child pr=2101 kind=review-finding -->',
          labels: [
            { name: 'review-finding' },
            { name: 'effort:medium' },
            { name: 'priority:p1' },
          ],
        });
      }
      if (command === 'gh' && args[0] === 'api') {
        return JSON.stringify([[
          {
            id: 90,
            user: null,
            state: 'APPROVED',
            commit_id: null,
            body: null,
            submitted_at: null,
          },
          {
            id: 91,
            user: { login: 'jinn-autopilot' },
            state: 'CHANGES_REQUESTED',
            commit_id: HEAD,
            body:
              `Findings.\n\n<!-- jinn-autopilot-review:v2 generation=${generation} `
              + `attempt=${attempt} intent=${marker} reviewer=jinn-autopilot `
              + `head=${HEAD} verdict=REQUEST_CHANGES -->`,
            submitted_at: '2026-07-24T12:01:00.000Z',
          },
        ]]);
      }
      if (command === 'git' && args.includes('ls-remote')) {
        return `${advanced ? advancedOid : currentOid}`
          + '\trefs/jinn-autopilot/review-claims/v1/2101\n';
      }
      if (command === 'git' && args.includes('fetch')) return '';
      if (command === 'git' && args.includes('rev-list')) {
        return advanced
          ? `${advancedOid}\n${currentOid}\n${intentOid}\n${rootOid}\n`
          : `${currentOid}\n${intentOid}\n${rootOid}\n`;
      }
      if (command === 'git' && args.includes('show')) {
        const target = args.find((entry) =>
          entry.endsWith(':jinn-autopilot-review.json'));
        if (target?.startsWith(advancedOid)) {
          return JSON.stringify({
            ...common,
            generation: '123e4567-e89b-42d3-a456-426614174020',
            attempt: '123e4567-e89b-42d3-a456-426614174021',
            head: advancedHead,
            state: 'active',
            recordedAt: '2026-07-24T12:03:00.000Z',
          });
        }
        if (target?.startsWith(currentOid)) {
          return JSON.stringify({ ...common, state: 'stale' });
        }
        if (target?.startsWith(intentOid)) {
          return JSON.stringify({
            ...common,
            state: 'verdict-intent',
            verdict: { state: 'REQUEST_CHANGES', marker },
          });
        }
        return JSON.stringify({ ...common, state: 'active' });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
    });
    const receipt = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'accepted',
      role: 'verdict',
      operation: 'review-findings',
      taskId: '501',
      attemptIndex: 0,
      requestId: 'request',
      deliveryEnvelopeCid: 'bafy-envelope',
      v2AttemptId: manifest.attemptId,
      claimOid: manifest.claimOid,
      prNumber: 2101,
      expectedHead: manifest.expectedHead,
      resultingHead: HEAD,
      reviewedHead: HEAD,
      reviewGeneration: generation,
      reviewRefOid: rootOid,
      childIssueNumber: 2201,
      recordedAt: '2026-07-24T12:02:00.000Z',
    } as const;

    await expect(ports.verifyReceiptFacts({
      exactFacts: {
        role: 'verdict',
        correlation: receipt,
        prHead: HEAD,
      },
      receipt,
    })).resolves.toBe(true);
    childState = 'CLOSED';
    await expect(ports.verifyReceiptFacts({
      exactFacts: {
        role: 'verdict',
        correlation: receipt,
        prHead: HEAD,
      },
      receipt,
    })).resolves.toBe(false);
    advanced = true;
    await expect(ports.verifyReceiptFacts({
      exactFacts: {
        role: 'verdict',
        correlation: receipt,
        prHead: HEAD,
      },
      receipt,
    })).resolves.toBe(true);
  });

  it('fails closed when the PR head changes during receipt publication', async () => {
    const manifest = fixture();
    let headReads = 0;
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'pr') {
        headReads += 1;
        return JSON.stringify({
          headRefOid: headReads === 1 ? HEAD : '9'.repeat(40),
        });
      }
      return JSON.stringify({ id: 73 });
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
    });

    await expect(ports.createPrComment({
      prNumber: 2101,
      expectedHead: HEAD,
      body: 'canonical receipt',
    })).rejects.toThrow(
      'Marketplace adoption receipt head changed during publication',
    );
  });
});

describe('production marketplace verification port', () => {
  it('uses an install mode accepted by the pinned Yarn CLI', () => {
    const help = execFileSync(
      'corepack',
      ['yarn@4.13.0', 'install', '--help'],
      { encoding: 'utf8' },
    );
    expect(help).toContain('skip-build');
    expect(help).not.toContain('skip-builds');
  });

  it('runs candidate checks offline in a credential-free quota-bounded container', async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly label: string }> = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin', GH_TOKEN: 'must-not-cross-the-boundary' },
      {
        containerName: () => 'jinn-autopilot-verify-test',
        runDocker: async (args, label) => {
          calls.push({ args, label });
          return { status: 'passed' };
        },
      },
    );

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/attempt/worktree',
      touchedPaths: ['packages/autopilot/src/index.ts'],
    })).resolves.toMatchObject({
      status: 'passed',
      workspaces: ['packages/autopilot'],
    });

    expect(calls[0]?.label).toBe('sandbox-container-create');
    const create = calls[0]!;
    expect(create.args[0]).toBe('run');
    expect(create.args).toContain('--detach');
    expect(create.args).toContain('--rm');
    expect(create.args).toContain('jinn.autopilot.verification=true');
    expect(create.args).toContain('sleep 7200');
    expect(create.args).toContain(
      'type=bind,src=/attempt/worktree,dst=/source,readonly',
    );
    expect(create.args).toContain(
      '/workspace:rw,nosuid,nodev,size=6442450944',
    );
    expect(create.args).toContain('8g');
    expect(create.args).toContain('--read-only');
    expect(create.args).toContain('--cap-drop');
    expect(create.args).toContain('ALL');
    expect(create.args).toContain('--security-opt');
    expect(create.args).toContain('no-new-privileges:true');
    expect(create.args).toContain('YARN_IGNORE_PATH=1');
    expect(create.args).toContain('YARN_NODE_LINKER=node-modules');
    expect(create.args).toContain('YARN_ENABLE_SCRIPTS=false');
    expect(create.args.join(' ')).not.toContain('must-not-cross-the-boundary');
    const seed = calls.find(({ label }) => label === 'sandbox-source-copy')!;
    expect(seed.args.join(' ')).toContain("node_modules");
    expect(seed.args.join(' ')).toContain("dist");

    const candidateCalls = calls.filter(({ label }) =>
      label.startsWith('packages/autopilot:'));
    expect(candidateCalls.map(({ label }) => label)).toEqual([
      'packages/autopilot:install',
      'packages/autopilot:typecheck',
      'packages/autopilot:test',
    ]);
    for (const call of candidateCalls) {
      expect(call.args[0]).toBe('exec');
      expect(call.args.join(' ')).not.toContain('must-not-cross-the-boundary');
    }
    const install = candidateCalls[0]!;
    expect(install.args.slice(-4)).toEqual([
      'yarn@4.13.0',
      'install',
      '--immutable',
      '--mode=skip-build',
    ]);
    const disconnectIndex = calls.findIndex(({ label }) =>
      label === 'sandbox-network-disconnect');
    expect(disconnectIndex).toBeGreaterThan(
      calls.findIndex(({ label }) => label === 'packages/autopilot:install'),
    );
    expect(disconnectIndex).toBeLessThan(
      calls.findIndex(({ label }) => label === 'packages/autopilot:typecheck'),
    );
    expect(calls.at(-1)).toEqual({
      args: ['rm', '-f', 'jinn-autopilot-verify-test'],
      label: 'sandbox-container-remove',
    });
  });

  it('rebuilds native dependencies offline against the image-provided headers', async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly label: string }> = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin' },
      {
        containerName: () => 'jinn-autopilot-verify-native',
        runDocker: async (args, label) => {
          calls.push({ args, label });
          return { status: 'passed' };
        },
      },
    );

    await port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/attempt/worktree',
      touchedPaths: ['packages/core/src/index.ts'],
    });

    const rebuilds = calls.filter(({ label }) =>
      label.endsWith(':trusted-native-rebuild')
    );
    expect(rebuilds).not.toHaveLength(0);
    for (const rebuild of rebuilds) {
      expect(rebuild.args).toContain('npm_config_nodedir=/usr/local');
      expect(
        calls.findIndex(({ label }) => label === 'sandbox-network-disconnect'),
      ).toBeLessThan(calls.indexOf(rebuild));
    }
    const labels = calls.map(({ label }) => label);
    expect(labels.indexOf('packages/plugin:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/core:trusted-bootstrap-build'));
    expect(labels.indexOf('packages/core:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/layer:trusted-bootstrap-build'));
    expect(labels.indexOf('packages/layer:trusted-bootstrap-build'))
      .toBeLessThan(labels.indexOf('packages/core:typecheck'));
  });

  it('uses an independent bounded deadline to remove the container', async () => {
    const calls: Array<{
      readonly label: string;
      readonly timeoutMs: number | undefined;
    }> = [];
    let now = Date.parse('2026-07-24T00:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const port = makeProductionMarketplaceVerificationPort(
        { PATH: '/usr/bin' },
        {
          containerName: () => 'jinn-autopilot-verify-cleanup-deadline',
          runDocker: async (_args, label, timeoutMs) => {
            calls.push({ label, timeoutMs });
            if (label === 'packages/autopilot:test') {
              now += 26 * 60_000;
            }
            return { status: 'passed' };
          },
        },
      );

      await expect(port.verify({
        profile: 'jinn-mono.v1',
        repositoryPath: '/attempt/worktree',
        touchedPaths: ['packages/autopilot/src/index.ts'],
      })).resolves.toMatchObject({ status: 'passed' });

      expect(calls.at(-1)).toEqual({
        label: 'sandbox-container-remove',
        timeoutMs: 30_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('preflights the pinned image and its offline native toolchain', async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly label: string }> = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin' },
      {
        runDocker: async (args, label) => {
          calls.push({ args, label });
          return { status: 'passed' };
        },
      },
    );

    await expect(port.preflight?.()).resolves.toEqual({ ok: true });
    expect(calls.map(({ label }) => label)).toEqual([
      'docker-readiness',
      'verification-image-inspect',
      'verification-native-toolchain-smoke',
    ]);
    const smoke = calls.at(-1)!;
    expect(smoke.args).toContain('--network');
    expect(smoke.args).toContain('none');
    expect(smoke.args.join(' ')).toContain('npm_config_nodedir=/usr/local');
    expect(smoke.args.join(' ')).toContain('node-gyp');
  });

  it('always removes the disposable container and returns a bounded failed check', async () => {
    const labels: string[] = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin' },
      {
        containerName: () => 'jinn-autopilot-verify-failed',
        runDocker: async (_args, label) => {
          labels.push(label);
          return label === 'packages/autopilot:typecheck'
            ? { status: 'failed', detail: 'candidate check failed' }
            : { status: 'passed' };
        },
      },
    );

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/attempt/worktree',
      touchedPaths: ['packages/autopilot/src/index.ts'],
    })).resolves.toMatchObject({
      status: 'failed',
      failedCommand: 'packages/autopilot:typecheck',
      detail: 'candidate check failed',
    });
    expect(labels.at(-1)).toBe('sandbox-container-remove');
    expect(labels).not.toContain('packages/autopilot:test');
  });

  it('quarantines the container when the Docker process cannot be reaped', async () => {
    const labels: string[] = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin' },
      {
        containerName: () => 'jinn-autopilot-verify-unreaped',
        runDocker: async (_args, label) => {
          labels.push(label);
          if (label === 'packages/autopilot:typecheck') {
            throw new MarketplaceVerificationUnreapedError();
          }
          return { status: 'passed' };
        },
      },
    );

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/attempt/worktree',
      touchedPaths: ['packages/autopilot/src/index.ts'],
    })).rejects.toThrow(/did not close after SIGKILL/);
    expect(labels).not.toContain('sandbox-container-remove');
  });
});
