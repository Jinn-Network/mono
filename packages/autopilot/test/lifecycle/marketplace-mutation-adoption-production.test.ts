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
