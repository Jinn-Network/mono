import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  makeProductionMarketplaceAdoptionReceiptPorts,
  makeProductionMarketplaceVerificationPort,
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
      return JSON.stringify([{
        id: 72,
        user: { login: 'jinn-autopilot' },
        body: 'receipt',
        created_at: '2026-07-24T12:01:00.000Z',
        updated_at: '2026-07-24T12:01:00.000Z',
      }]);
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
  it('runs candidate checks in a credential-free disposable Docker volume', async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly label: string }> = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin', GH_TOKEN: 'must-not-cross-the-boundary' },
      {
        volumeName: () => 'jinn-autopilot-verify-test',
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

    expect(calls[0]).toEqual({
      args: ['volume', 'create', 'jinn-autopilot-verify-test'],
      label: 'sandbox-volume-create',
    });
    const seed = calls.find(({ label }) => label === 'sandbox-source-copy');
    expect(seed?.args).toContain(
      'type=bind,src=/attempt/worktree,dst=/source,readonly',
    );
    expect(seed?.args).toContain(
      'type=volume,src=jinn-autopilot-verify-test,dst=/workspace',
    );
    expect(seed?.args).toContain('--network');
    expect(seed?.args).toContain('none');

    const candidateCalls = calls.filter(({ label }) =>
      label.startsWith('packages/autopilot:'));
    expect(candidateCalls.map(({ label }) => label)).toEqual([
      'packages/autopilot:install',
      'packages/autopilot:typecheck',
      'packages/autopilot:test',
    ]);
    for (const call of candidateCalls) {
      expect(call.args).not.toContain(
        'type=bind,src=/attempt/worktree,dst=/source,readonly',
      );
      expect(call.args).toContain(
        'type=volume,src=jinn-autopilot-verify-test,dst=/workspace',
      );
      expect(call.args).toContain('--read-only');
      expect(call.args).toContain('--cap-drop');
      expect(call.args).toContain('ALL');
      expect(call.args).toContain('--security-opt');
      expect(call.args).toContain('no-new-privileges:true');
      expect(call.args.join(' ')).not.toContain('must-not-cross-the-boundary');
    }
    const install = candidateCalls[0]!;
    expect(install.args).toContain('bridge');
    expect(install.args.slice(-4)).toEqual([
      'yarn',
      'install',
      '--immutable',
      '--mode=skip-builds',
    ]);
    for (const call of candidateCalls.slice(1)) {
      const networkIndex = call.args.indexOf('--network');
      expect(call.args[networkIndex + 1]).toBe('none');
    }
    expect(calls.at(-1)).toEqual({
      args: ['volume', 'rm', '-f', 'jinn-autopilot-verify-test'],
      label: 'sandbox-volume-remove',
    });
  });

  it('always removes the disposable volume and returns a bounded failed check', async () => {
    const labels: string[] = [];
    const port = makeProductionMarketplaceVerificationPort(
      { PATH: '/usr/bin' },
      {
        volumeName: () => 'jinn-autopilot-verify-failed',
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
    expect(labels.at(-1)).toBe('sandbox-volume-remove');
    expect(labels).not.toContain('packages/autopilot:test');
  });
});
