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

vi.mock('@/tasks/submit-preflight.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/tasks/submit-preflight.js')>(),
  resolveMarketplaceTaskSolverNet: vi.fn(async () => 'bafy-dry-run-manifest'),
  runMarketplaceTaskSubmitPreflight: vi.fn(async () => undefined),
}));

const V2_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function machineRequest() {
  return {
    schemaVersion: 'jinn-task-submit-request.v1',
    id: `autopilot:${V2_ATTEMPT_ID}`,
    description: 'Dry-run without SQLite',
    solverType: 'jinn-repo.v1',
    createdAt: 1_784_761_200_000,
    window: { startTs: 1_784_761_200_000, endTs: 1_784_764_800_000 },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: 1_784_761_200_000,
      claimWindowEndTs: 1_784_762_100_000,
      submissionDeadlineTs: 1_784_764_500_000,
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
      problem_statement: 'Dry-run without SQLite',
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        repository: 'Jinn-Network/mono',
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
        },
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        deadline: '2026-07-22T23:50:00.000Z',
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
});
