import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import { FleetStateStore } from '@/earning/store.js';
import {
  createDefaultFleetState,
  createDefaultServiceState,
} from '@/earning/types.js';
import { encryptMnemonic } from '@/earning/wallet.js';
import { makeCommandCtx } from '@test/cli.js';
import { marketplaceTaskSelectionSidecarPath } from '@/tasks/submit-selection.js';
import { MechRequesterAdapter } from '@/adapters/mech/requester-adapter.js';

vi.mock('@/tasks/submit-preflight.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/tasks/submit-preflight.js')>(),
  resolveMarketplaceTaskSolverNet: vi.fn(async () => 'bafy-dry-run-manifest'),
  runMarketplaceTaskSubmitPreflight: vi.fn(async () => undefined),
}));

const V2_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function machineRequest(startTs = 1_900_000_000_000) {
  const endTs = startTs + 3_600_000;
  const claimEndTs = startTs + 900_000;
  const submissionDeadlineTs = startTs + 3_300_000;
  return {
    schemaVersion: 'jinn-task-submit-request.v1',
    id: `autopilot:${V2_ATTEMPT_ID}`,
    description: 'Dry-run without SQLite',
    solverType: 'jinn-repo.v1',
    createdAt: startTs,
    window: { startTs, endTs },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: startTs,
      claimWindowEndTs: claimEndTs,
      submissionDeadlineTs,
      claimLeaseTtlSeconds: 1800,
      requiredVerdicts: 1,
    },
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${V2_ATTEMPT_ID}`,
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      problem_statement: 'Dry-run without SQLite',
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        repository: 'Jinn-Network/mono',
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        issueNumber: 42,
        prNumber: 314,
        targetBase: 'next',
        branch: 'autopilot/issue-42',
        claimOid: 'b'.repeat(40),
        expectedHead: 'c'.repeat(40),
        v2AttemptId: V2_ATTEMPT_ID,
        runnerId: 'runner-1',
        taskSnapshot: {
          title: 'Issue 42',
          body: 'Implement it',
          prBody: 'Draft',
          baseSha: 'd'.repeat(40),
          targetBaseOid: 'd'.repeat(40),
        },
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        deadline: new Date(startTs + 1_800_000).toISOString(),
        receiptAuthors: ['jinn-autopilot'],
      },
    },
  };
}

describe('machine Task dry-run filesystem behavior', () => {
  it('uses the signer/fleet JSON path without creating or migrating SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-dry-run-fs-'));
    const earningDir = join(dir, 'earning');
    const absentDbParent = join(dir, 'must-remain-absent');
    const requestPath = join(dir, 'request.json');
    const configPath = join(dir, 'config.json');
    const password = 'test-password';
    const mnemonic = 'test test test test test test test test test test test junk';
    const fleetStore = new FleetStateStore(earningDir);
    await fleetStore.saveMnemonicKeystore(await encryptMnemonic(mnemonic, password));
    const service = {
      ...createDefaultServiceState(1, '0x1111111111111111111111111111111111111111'),
      safe_address: '0x00112233445566778899aabbccddeeff00112233',
      mech_address: '0x2222222222222222222222222222222222222222',
      step: 'complete' as const,
    };
    await fleetStore.save({
      ...createDefaultFleetState('base-sepolia'),
      services: [service],
    });
    writeFileSync(requestPath, JSON.stringify(machineRequest()));
    writeFileSync(configPath, JSON.stringify({
      network: 'testnet',
      earningDir,
      dbPath: join(absentDbParent, 'jinn.db'),
      rpcUrl: 'http://127.0.0.1:1',
    }));

    const made = makeCommandCtx({
      argv: [
        'submit',
        '--request-file',
        requestPath,
        '--config',
        configPath,
        '--dry-run',
        '--json',
      ],
      env: { JINN_PASSWORD: password },
    });
    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      dryRun: true,
      verb: 'tasks submit',
    });
    expect(existsSync(absentDbParent)).toBe(false);
    expect(existsSync(marketplaceTaskSelectionSidecarPath(requestPath))).toBe(false);
  });

  it('rejects an expired live request before sidecar, SQLite, adapter, or broadcast mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-live-expired-fs-'));
    const earningDir = join(dir, 'earning');
    const absentDbParent = join(dir, 'must-remain-absent');
    const requestPath = join(dir, 'request.json');
    const configPath = join(dir, 'config.json');
    const password = 'test-password';
    const mnemonic = 'test test test test test test test test test test test junk';
    const fleetStore = new FleetStateStore(earningDir);
    await fleetStore.saveMnemonicKeystore(await encryptMnemonic(mnemonic, password));
    await fleetStore.save({
      ...createDefaultFleetState('base-sepolia'),
      services: [{
        ...createDefaultServiceState(1, '0x1111111111111111111111111111111111111111'),
        safe_address: '0x00112233445566778899aabbccddeeff00112233',
        mech_address: '0x2222222222222222222222222222222222222222',
        step: 'complete' as const,
      }],
    });
    writeFileSync(requestPath, JSON.stringify(machineRequest(1_700_000_000_000)));
    writeFileSync(configPath, JSON.stringify({
      network: 'testnet',
      earningDir,
      dbPath: join(absentDbParent, 'jinn.db'),
      rpcUrl: 'http://127.0.0.1:1',
    }));
    const initialize = vi.spyOn(MechRequesterAdapter.prototype, 'initialize').mockResolvedValue();
    const postTask = vi.spyOn(MechRequesterAdapter.prototype, 'postTask').mockResolvedValue({
      taskId: 'must-not-post',
      taskCid: `f01551220${'ab'.repeat(32)}`,
    });

    const made = makeCommandCtx({
      argv: [
        'submit',
        '--request-file',
        requestPath,
        '--config',
        configPath,
        '--yes',
        '--json',
      ],
      env: { JINN_PASSWORD: password },
    });
    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringMatching(/freshness|expired|deadline/i),
    });
    expect(existsSync(marketplaceTaskSelectionSidecarPath(requestPath))).toBe(false);
    expect(existsSync(absentDbParent)).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(postTask).not.toHaveBeenCalled();
    initialize.mockRestore();
    postTask.mockRestore();
  });
});
