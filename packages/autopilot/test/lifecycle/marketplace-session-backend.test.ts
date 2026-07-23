import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeMarketplaceSessionBackend,
} from '../../src/lifecycle/marketplace-session-backend.js';
import type { ClaimedSessionInput } from '../../src/lifecycle/session-execution-backend.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(root: string): ClaimedSessionInput {
  return {
    kind: 'mutation',
    workflow: 'implement',
    issue: {
      number: 42,
      title: 'Implement the marketplace backend',
      body: 'Use the approved backend-neutral session contract.',
    },
    pr: {
      number: 84,
      body: 'Closes #42',
    },
    targetBase: gitRefName('next'),
    branch: gitRefName('autopilot/42'),
    claimOid: gitOid('1'.repeat(40)),
    expectedHead: gitOid('1'.repeat(40)),
    baseSha: gitOid('0'.repeat(40)),
    v2AttemptId: '11111111-1111-4111-8111-111111111111',
    runnerId: 'runner-a',
    selectedLogin: 'implementation-bot',
    effort: 'High',
    deadline: '2026-07-23T13:00:00.000Z',
    receiptAuthors: ['implementation-bot'],
    attempt: {
      manifestPath: join(root, 'manifest.json'),
      worktreePath: join(root, 'worktree'),
      logPath: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpassPath: join(root, 'askpass'),
    },
  };
}

describe('marketplace SessionExecutionBackend', () => {
  it('writes one immutable request and invokes only the one-shot machine submit command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-backend-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), '{}');
    const calls: Array<{
      command: string;
      args: string[];
      env?: Record<string, string>;
      replaceEnv?: boolean;
    }> = [];
    const runner = vi.fn(async (
      command: string,
      args: string[],
      options?: { env?: Record<string, string>; replaceEnv?: boolean },
    ) => {
      calls.push({
        command,
        args,
        env: options?.env,
        replaceEnv: options?.replaceEnv,
      });
      return JSON.stringify({
        taskId: '501',
        taskCid: 'bafy-task',
        creationTransactionHash: `0x${'a'.repeat(64)}`,
        creationBlockNumber: 123,
        solverNetManifestCid: 'bafy-manifest',
        idempotent: false,
      });
    });
    const backend = makeMarketplaceSessionBackend({
      runner,
      environment: {
        PATH: '/usr/bin',
        HOME: '/operator/home',
        JINN_RPC_URL: 'https://rpc.example',
        JINN_CONFIG: '/operator/config.json',
        JINN_PASSWORD: 'local-keystore-password',
        HTTPS_PROXY: 'https://proxy.example',
        NODE_EXTRA_CA_CERTS: '/operator/ca.pem',
        GH_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        JINN_IMPL_GH_TOKEN: 'must-not-leak',
        CUSTOM_GITHUB_PAT: 'must-not-leak',
        GH_CONFIG_DIR: '/must/not/leak/gh',
        GIT_ASKPASS: '/must/not/leak/askpass',
        SSH_AUTH_SOCK: '/must/not/leak/ssh-agent',
        GIT_SSH: '/must/not/leak/git-ssh',
        GIT_SSH_COMMAND: '/must/not/leak/git-ssh-command',
        GIT_CONFIG_GLOBAL: '/must/not/leak/gitconfig',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/must/not/leak/manifest',
        OPENAI_API_KEY: 'must-not-leak',
        UNRELATED_SECRET: 'must-not-leak',
      },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    const handle = await backend.start(input(root));

    expect(handle).toMatchObject({
      backend: 'marketplace',
      taskId: '501',
      taskCid: 'bafy-task',
      deadline: '2026-07-23T13:30:00.000Z',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('jinn');
    expect(calls[0]!.args).toEqual([
      'tasks', 'submit',
      '--request-file', join(root, 'marketplace-request.json'),
      '--yes',
      '--json',
    ]);
    expect(calls[0]!.replaceEnv).toBe(true);
    expect(calls[0]!.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/operator/home',
      JINN_RPC_URL: 'https://rpc.example',
      JINN_CONFIG: '/operator/config.json',
      JINN_PASSWORD: 'local-keystore-password',
      HTTPS_PROXY: 'https://proxy.example',
      NODE_EXTRA_CA_CERTS: '/operator/ca.pem',
    });
    const requestText = readFileSync(join(root, 'marketplace-request.json'), 'utf8');
    const request = JSON.parse(requestText) as Record<string, unknown>;
    expect(request).toMatchObject({
      schemaVersion: 'jinn-task-submit-request.v1',
      id: 'autopilot:11111111-1111-4111-8111-111111111111',
      solverType: 'jinn-repo.v1',
      claimPolicy: {
        mode: 'exclusive',
        maxClaims: 1,
        maxClaimsPerOperator: 1,
        claimWindowStartTs: Date.parse('2026-07-23T12:00:00.000Z'),
        claimWindowEndTs: Date.parse('2026-07-23T12:15:00.000Z'),
        submissionDeadlineTs: Date.parse('2026-07-23T13:30:00.000Z'),
        requiredVerdicts: 1,
      },
      window: {
        startTs: Date.parse('2026-07-23T12:00:00.000Z'),
        endTs: Date.parse('2026-07-23T13:30:00.000Z'),
      },
      spec: {
        schemaVersion: 'jinn-repo.v1',
        source: 'autopilot-session',
        instance_id: 'autopilot:11111111-1111-4111-8111-111111111111',
        repo: 'Jinn-Network/mono',
        base_commit: '1'.repeat(40),
        language: 'typescript',
        session: {
          schemaVersion: 'jinn-autopilot-session.v1',
          workflow: 'implement',
          v2AttemptId: '11111111-1111-4111-8111-111111111111',
          deadline: '2026-07-23T13:00:00.000Z',
        },
      },
    });
    expect(request).not.toHaveProperty('solverNet');
    expect(request).not.toHaveProperty('solverNetManifestCid');
    expect(requestText).not.toContain('must-not-leak');
    expect(requestText).not.toContain('/must/not/leak');
    expect(statSync(join(root, 'marketplace-request.json')).mode & 0o777).toBe(0o600);

    await expect(backend.start(input(root))).resolves.toMatchObject({
      backend: 'marketplace',
      taskId: '501',
    });
    expect(readFileSync(join(root, 'marketplace-request.json'), 'utf8')).toBe(requestText);
  });

  it('fails closed instead of spawning or falling back when submission fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-backend-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), '{}');
    const backend = makeMarketplaceSessionBackend({
      runner: async () => {
        throw new Error('network unavailable');
      },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await expect(backend.start(input(root))).rejects.toThrow('network unavailable');
  });

  it('includes an explicit manifest override without requiring a local joined net', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-backend-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), '{}');
    const runner = vi.fn(async (
      _command: string,
      _args: string[],
    ) => JSON.stringify({
        taskId: '501',
        taskCid: 'bafy-task',
      }));
    const backend = makeMarketplaceSessionBackend({
      runner,
      solverNetManifestCid: 'bafy-explicit-manifest',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await backend.start(input(root));

    const request = JSON.parse(readFileSync(
      join(root, 'marketplace-request.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(request).toMatchObject({
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-explicit-manifest',
    });
    expect(request).not.toHaveProperty('solverNet');
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![1]).toEqual([
      'tasks', 'submit',
      '--request-file', join(root, 'marketplace-request.json'),
      '--yes',
      '--json',
    ]);
  });

  it('uses the explicit manifest override in the exact dry-run preflight request', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const backend = makeMarketplaceSessionBackend({
      runner: async (_command, args) => {
        const requestPath = args[args.indexOf('--request-file') + 1]!;
        requests.push(JSON.parse(readFileSync(requestPath, 'utf8')));
        return JSON.stringify({ dryRun: true, verb: 'tasks submit' });
      },
      solverNetManifestCid: 'bafy-explicit-manifest',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await expect(backend.preflight()).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      expect.objectContaining({
        solverType: 'jinn-repo.v1',
        solverNetManifestCid: 'bafy-explicit-manifest',
      }),
    ]);
  });

  it('preflights the exact one-shot path without broadcasting', async () => {
    const calls: string[][] = [];
    const backend = makeMarketplaceSessionBackend({
      runner: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({ dryRun: true, verb: 'tasks submit' });
      },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await expect(backend.preflight()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining([
      'tasks',
      'submit',
      '--request-file',
      '--yes',
      '--json',
      '--dry-run',
    ]));
  });

  it('recovers a broadcast-before-manifest crash by idempotently resubmitting the immutable request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-backend-'));
    roots.push(root);
    writeFileSync(join(root, 'manifest.json'), '{}');
    const calls: string[][] = [];
    const backend = makeMarketplaceSessionBackend({
      runner: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          taskId: '501',
          taskCid: 'bafy-task',
          idempotent: calls.length > 1,
        });
      },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await backend.start(input(root));
    const requestBefore = readFileSync(
      join(root, 'marketplace-request.json'),
      'utf8',
    );
    await expect(backend.recoverPreparing(join(root, 'manifest.json')))
      .resolves.toEqual({
        backend: 'marketplace',
        taskId: '501',
        taskCid: 'bafy-task',
        deadline: '2026-07-23T13:30:00.000Z',
        requestFile: join(root, 'marketplace-request.json'),
      });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(readFileSync(join(root, 'marketplace-request.json'), 'utf8'))
      .toBe(requestBefore);
  });

  it('reports an expired submitted handle as failed across backend restarts', async () => {
    const options = {
      runner: async () => '',
      now: () => new Date('2026-07-23T14:00:00.000Z'),
    };
    const handle = {
      backend: 'marketplace' as const,
      taskId: '501',
      taskCid: 'bafy-task',
      deadline: '2026-07-23T13:30:00.000Z',
      requestFile: '/attempt/marketplace-request.json',
    };

    await expect(makeMarketplaceSessionBackend(options).recover(handle))
      .resolves.toEqual({
        state: 'failed',
        detail: 'Marketplace task deadline expired',
      });
    await expect(makeMarketplaceSessionBackend(options).recover(handle))
      .resolves.toEqual({
      state: 'failed',
      detail: 'Marketplace task deadline expired',
    });
  });

  it('durably stops accepting a cancelled task across backend restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-backend-'));
    roots.push(root);
    const handle = {
      backend: 'marketplace' as const,
      taskId: '501',
      taskCid: 'bafy-task',
      deadline: '2026-07-23T13:30:00.000Z',
      requestFile: join(root, 'marketplace-request.json'),
    };
    const options = {
      runner: async () => '',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    };

    await makeMarketplaceSessionBackend(options).cancel(
      handle,
      'authority was released',
    );

    await expect(makeMarketplaceSessionBackend(options).recover(handle))
      .resolves.toEqual({
        state: 'cancelled',
        detail: 'authority was released',
      });
    expect(statSync(join(root, 'marketplace-cancellation.json')).mode & 0o777)
      .toBe(0o600);
  });
});
