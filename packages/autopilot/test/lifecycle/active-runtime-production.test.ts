// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionActiveRuntime,
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import {
  decodeCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'secret',
  }]);
}

describe('decodeCapabilityAttestation timestamps', () => {
  it('accepts second-precision ISO-8601 timestamps', () => {
    const decoded = decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00Z',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    });
    expect(decoded.verifiedAt).toBe('2026-07-20T11:00:00Z');
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '20 July 2026',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    })).toThrow('verifiedAt is invalid');
  });
});

describe('production active runtime preflight', () => {
  it('rejects active mode when no live capability attestation is configured', async () => {
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        'JINN_AUTOPILOT_CAPABILITY_ATTESTATION',
      ),
    });
  });

  it('requires the dedicated canonical HTTPS remote without mutating local Git config', async () => {
    const calls: string[][] = [];
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);
    const accepted = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });
    await expect(accepted()).resolves.toEqual({ ok: true });
    await expect(accepted()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]);

    const rejected = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'git@example.invalid:Jinn-Network/mono.git\n',
    });
    await expect(rejected()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('canonical HTTPS'),
    });
  });

  it('fails closed when Cursor runtime probe cannot find the agent binary', async () => {
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);

    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/Cursor Agent CLI is missing|Cursor runtime probe failed/i),
    });
  });

  it('uses marketplace one-shot preflight while retaining host GitHub authority checks', async () => {
    const marketplacePreflight = vi.fn(async () => ({ ok: true as const }));
    const marketplaceRecovery = vi.fn(async () => ({ ok: true as const }));
    const remoteReads: string[][] = [];
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      executionBackendKind: 'marketplace',
      marketplacePreflight,
      marketplaceRecovery,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: () => ({}) as never,
      runner: async (_command, args) => {
        remoteReads.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });

    await expect(preflight()).resolves.toEqual({ ok: true });
    expect(remoteReads).toEqual([[
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]]);
    expect(marketplacePreflight).toHaveBeenCalledOnce();
    expect(marketplaceRecovery).toHaveBeenCalledOnce();
  });

  it('rejects marketplace deadlines that do not precede V2 staleness', async () => {
    const marketplacePreflight = vi.fn(async () => ({ ok: true as const }));
    const marketplaceRecovery = vi.fn(async () => ({ ok: true as const }));
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      executionBackendKind: 'marketplace',
      marketplacePreflight,
      marketplaceRecovery,
      staleAfterMs: 90 * 60 * 1000,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: () => ({}) as never,
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toEqual({
      ok: false,
      detail:
        'marketplace submission deadline must be shorter than V2 staleness',
    });
    expect(marketplacePreflight).not.toHaveBeenCalled();
    expect(marketplaceRecovery).not.toHaveBeenCalled();
  });

  it('reattaches preparing work and recovers its running handle before capacity is read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-recovery-'));
    try {
      const attemptId = '11111111-1111-4111-8111-111111111111';
      const attemptDir = join(
        root,
        'v2',
        'runner-a',
        'implement',
        `issue-42-${attemptId}`,
      );
      mkdirSync(attemptDir, { recursive: true });
      const manifestPath = join(attemptDir, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify({
        version: 2,
        attemptId,
        runnerId: 'runner-a',
        host: 'host-a',
        phase: 'implement',
        subject: 'issue-42',
        issueNumber: 42,
        prNumber: 84,
        branch: 'autopilot/issue-42',
        targetBase: 'next',
        expectedHead: '1'.repeat(40),
        claimOid: '1'.repeat(40),
        selectedLogin: 'implementation-bot',
        repository: {
          root: '/repo',
          gitCommonDir: '/repo/.git',
          remoteName: 'jinn-autopilot-v2',
          remoteUrlHash: '2'.repeat(64),
        },
        execution: { backend: 'marketplace' },
        processState: 'preparing',
        pid: null,
        paths: {
          attemptDir,
          worktree: join(attemptDir, 'worktree'),
          manifest: manifestPath,
          log: join(attemptDir, 'session.log'),
          ghConfigDir: join(attemptDir, 'gh-config'),
          askpass: join(attemptDir, 'askpass'),
          tokenFile: join(attemptDir, 'gh-token'),
        },
        timestamps: {
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      }, null, 2)}\n`);
      const recovered = {
        backend: 'marketplace' as const,
        taskId: 'task-42',
        taskCid: 'bafy-task-42',
        deadline: '2026-07-20T13:30:00.000Z',
        requestFile: join(attemptDir, 'marketplace-request.json'),
      };
      const marketplaceBackend = {
        start: vi.fn(),
        recoverPreparing: vi.fn(async () => recovered),
        recover: vi.fn()
          .mockResolvedValueOnce({ state: 'running' as const })
          .mockResolvedValueOnce({
            state: 'failed' as const,
            detail: 'Marketplace task deadline expired',
          }),
        cancel: vi.fn(),
        preflight: vi.fn(async () => ({ ok: true as const })),
      };
      const runtime = makeProductionActiveRuntime({
        repositoryPath: '/repo',
        worktreeBase: root,
        runnerId: 'runner-a',
        credentials: pool(),
        authorAllowlist: new Set(['implementation-bot']),
        readSnapshot: vi.fn(),
        readPullRequestByNumber: vi.fn(),
        readProjectItemForReconciliation: vi.fn(),
        readBranchHeadByName: vi.fn(),
        readIssueByNumber: vi.fn(),
        readBlockedByIssueNumbers: vi.fn(),
        readOpenPullRequestsByIssue: vi.fn(),
        readIssueActionContext: vi.fn(),
        config: DEFAULT_CONFIG,
        spawn: vi.fn(),
        executionBackendKind: 'marketplace',
        marketplaceBackend,
        caps: { implementation: 1, review: 1 },
        implementationBackpressureThreshold: 1,
        staleAfterMs: 120 * 60 * 1000,
        environment: {
          JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
        },
        now: () => NOW,
        readCapabilityAttestation: () => ({}) as never,
        runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
      });

      await expect(runtime.preflight()).resolves.toEqual({ ok: true });
      expect(marketplaceBackend.recoverPreparing).toHaveBeenCalledWith(
        manifestPath,
      );
      expect(marketplaceBackend.recover).toHaveBeenCalledWith(recovered);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        processState: 'running',
        pid: null,
        execution: {
          backend: 'marketplace',
          taskId: 'task-42',
          taskCid: 'bafy-task-42',
        },
      });

      await expect(runtime.preflight()).resolves.toEqual({ ok: true });
      expect(marketplaceBackend.recoverPreparing).toHaveBeenCalledOnce();
      expect(marketplaceBackend.recover).toHaveBeenCalledTimes(2);
      expect(marketplaceBackend.recover).toHaveBeenLastCalledWith(recovered);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        processState: 'exited',
        pid: null,
        execution: {
          backend: 'marketplace',
          taskId: 'task-42',
          taskCid: 'bafy-task-42',
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
