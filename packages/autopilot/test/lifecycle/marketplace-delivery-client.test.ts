import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAttemptManifest,
  readAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  observeMarketplaceSolutionDelivery,
} from '../../src/lifecycle/marketplace-delivery-client.js';

const directories: string[] = [];
const CREATION_TX = `0x${'a'.repeat(64)}`;
const DELIVERY_TX = `0x${'b'.repeat(64)}`;

function sdkFixture(name: string): unknown {
  return JSON.parse(readFileSync(
    join(
      import.meta.dirname,
      '../../../sdk/test/fixtures/autopilot-session',
      `${name}.json`,
    ),
    'utf8',
  ));
}

function attempt() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-observer-'));
  directories.push(root);
  const session = sdkFixture('session-implement');
  const requestFile = join(root, 'marketplace-request.json');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(requestFile, `${JSON.stringify({
    schemaVersion: 'jinn-task-submit-request.v1',
    spec: { session },
  }, null, 2)}\n`, { mode: 0o600 });
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
    expectedHead: '2'.repeat(40),
    claimOid: '1'.repeat(40),
    selectedLogin: 'jinn-autopilot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      remoteUrlHash: 'c'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      taskId: '501',
      taskCid: 'bafy-task',
      deadline: '2026-07-24T14:00:00.000Z',
      requestFile,
      creationTransactionHash: CREATION_TX,
      creationBlockNumber: 100,
      solverNetManifestCid: 'bafy-solvernet',
    },
    processState: 'running',
    pid: null,
    paths: {
      attemptDir: root,
      worktree: join(root, 'worktree'),
      manifest: manifestPath,
      log: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpass: join(root, 'askpass.sh'),
      tokenFile: join(root, 'gh-token'),
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
  return { root, manifest, session };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Autopilot marketplace delivery client', () => {
  it('invokes exact observation and durably records verified Solution provenance', async () => {
    const fixture = attempt();
    const runner = vi.fn(async () => JSON.stringify({
      schemaVersion: 1,
      verb: 'tasks observe-autopilot-delivery',
      observation: {
        status: 'verified',
        role: 'solution',
        task: {
          taskId: '501',
          taskCid: 'bafy-task',
          createdAtBlock: 100,
          createdAtTx: CREATION_TX,
        },
        attempt: {
          attemptIndex: 0,
          requestId: '0xrequest',
          operator: `0x${'1'.repeat(40)}`,
        },
        delivery: {
          envelopeCid: 'bafy-envelope',
          publisherAgentId: '7',
          transactionHash: DELIVERY_TX,
          blockNumber: 120,
        },
        result: sdkFixture('mutation-complete'),
      },
    }));

    const result = await observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner,
        environment: { JINN_CONFIG: '/operator/config.json' },
        now: () => new Date('2026-07-24T12:05:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      status: 'verified',
      reference: {
        taskId: '501',
        attemptIndex: 0,
        requestId: '0xrequest',
        deliveryEnvelopeCid: 'bafy-envelope',
      },
      delivery: {
        operator: {
          id: '7',
          address: `0x${'1'.repeat(40)}`,
        },
      },
    });
    expect(runner).toHaveBeenCalledWith('jinn', [
      'tasks',
      'observe-autopilot-delivery',
      '--expectation-file',
      join(fixture.root, 'marketplace-solution-observation.json'),
      '--json',
    ], {
      env: { JINN_CONFIG: '/operator/config.json' },
      replaceEnv: true,
    });
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({
        backend: 'marketplace',
        attemptIndex: 0,
        requestId: '0xrequest',
        deliveryTx: DELIVERY_TX,
        deliveryBlockNumber: 120,
        deliveryEnvelopeCid: 'bafy-envelope',
      });
  });

  it('keeps pending observations recoverable without changing delivery state', async () => {
    const fixture = attempt();
    await expect(observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner: async () => JSON.stringify({
          observation: {
            status: 'pending',
            reason: 'attempt-not-indexed',
          },
        }),
      },
    )).resolves.toEqual({
      status: 'pending',
      reason: 'attempt-not-indexed',
    });
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .not.toHaveProperty('attemptIndex');
  });

  it('fails closed when verified Task creation provenance contradicts the manifest', async () => {
    const fixture = attempt();
    await expect(observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner: async () => JSON.stringify({
          observation: {
            status: 'verified',
            role: 'solution',
            task: {
              taskId: '501',
              taskCid: 'bafy-task',
              createdAtBlock: 100,
              createdAtTx: `0x${'f'.repeat(64)}`,
            },
            attempt: {
              attemptIndex: 0,
              requestId: '0xrequest',
              operator: `0x${'1'.repeat(40)}`,
            },
            delivery: {
              envelopeCid: 'bafy-envelope',
              publisherAgentId: '7',
              transactionHash: DELIVERY_TX,
              blockNumber: 120,
            },
            result: sdkFixture('mutation-complete'),
          },
        }),
      },
    )).rejects.toThrow('contradicts');
  });
});
