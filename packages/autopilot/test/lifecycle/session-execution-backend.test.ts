import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../../src/dispatcher/coordinator-session.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  makeLocalSessionExecutionBackend,
  type ClaimedSessionInput,
} from '../../src/lifecycle/session-execution-backend.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const hermesHomeFixture = vi.hoisted(() => ({ root: '' }));

vi.mock('../../src/dispatcher/hermes-home.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/dispatcher/hermes-home.js')
  >();
  const { join: joinPath } = await import('node:path');
  return {
    ...actual,
    prepareHermesHome: (options: { sessionId: string }) => ({
      hermesHome: joinPath(hermesHomeFixture.root, options.sessionId),
    }),
  };
});

const INPUT: ClaimedSessionInput = {
  kind: 'mutation',
  workflow: 'implement',
  issue: {
    number: 42,
    title: 'Implement the backend',
    body: 'Use the approved design.',
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
    manifestPath: '/attempt/manifest.json',
    worktreePath: '/attempt/worktree',
    logPath: '/attempt/session.log',
    ghConfigDir: '/attempt/gh-config',
    askpassPath: '/attempt/askpass',
  },
};

describe('local SessionExecutionBackend', () => {
  beforeEach(() => {
    hermesHomeFixture.root = mkdtempSync(
      join(tmpdir(), 'autopilot-local-backend-hermes-'),
    );
  });

  afterEach(() => {
    const fixtureRoot = hermesHomeFixture.root;
    hermesHomeFixture.root = '';
    if (fixtureRoot.length > 0) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('wraps the current coordinator spawn and durable child tracking', async () => {
    const trackChild = vi.fn();
    const spawn = vi.fn<SpawnFn>(() => ({ pid: 4242 }));
    const backend = makeLocalSessionExecutionBackend({
      config: DEFAULT_CONFIG,
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      ambientEnvironment: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ambient-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/ambient/manifest.json',
      },
      spawn,
      trackChild,
      isPidAlive: (pid) => pid === 4242,
      cancelProcess: vi.fn(),
    });

    await expect(backend.start(INPUT)).resolves.toEqual({
      backend: 'local',
      pid: 4242,
    });
    expect(spawn).toHaveBeenCalledOnce();
    const spawnOptions = spawn.mock.calls[0]![2] as unknown as {
      env: NodeJS.ProcessEnv;
      cwd: string;
    };
    expect(spawnOptions.cwd).toBe('/attempt/worktree');
    expect(spawnOptions.env.GH_TOKEN).toBe('selected-secret');
    expect(spawnOptions.env.GITHUB_TOKEN).toBeUndefined();
    expect(spawnOptions.env.JINN_AUTOPILOT_SESSION_MANIFEST)
      .toBe('/attempt/manifest.json');
    expect(trackChild).toHaveBeenCalledWith(
      '/attempt/manifest.json',
      expect.objectContaining({ pid: 4242 }),
    );
    await expect(backend.recover({ backend: 'local', pid: 4242 }))
      .resolves.toEqual({ state: 'running' });
  });

  it('gives distinct child workflows their own coordinator identities', async () => {
    const calls: Array<{
      args: string[];
      opts: Parameters<SpawnFn>[2];
    }> = [];
    let nextPid = 5000;
    const spawn = vi.fn<SpawnFn>((_command, args, opts) => {
      calls.push({ args, opts });
      nextPid += 1;
      return { pid: nextPid };
    });
    const backend = makeLocalSessionExecutionBackend({
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'hermes',
      },
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      ambientEnvironment: { PATH: '/usr/bin' },
      spawn,
      trackChild: vi.fn(),
      isPidAlive: () => true,
      cancelProcess: vi.fn(),
    });
    const childInputs: ClaimedSessionInput[] = [
      {
        ...INPUT,
        workflow: 'fix-child',
        childIssueNumber: 101,
        parentPrNumber: INPUT.pr.number,
        attempt: {
          ...INPUT.attempt,
          manifestPath: '/attempt/101/manifest.json',
          worktreePath: '/attempt/101/worktree',
          logPath: '/attempt/101/session.log',
        },
      },
      {
        ...INPUT,
        workflow: 'reconcile',
        childIssueNumber: 102,
        parentPrNumber: INPUT.pr.number,
        attempt: {
          ...INPUT.attempt,
          manifestPath: '/attempt/102/manifest.json',
          worktreePath: '/attempt/102/worktree',
          logPath: '/attempt/102/session.log',
        },
      },
    ];

    await backend.start(childInputs[0]!);
    await backend.start(childInputs[1]!);

    expect(calls).toHaveLength(2);
    expect(calls.map(({ opts }) => (
      (opts.env as NodeJS.ProcessEnv).HERMES_HOME
    ))).toEqual([
      join(hermesHomeFixture.root, 'implement-101'),
      join(hermesHomeFixture.root, 'implement-102'),
    ]);
    expect(calls.map(({ opts }) => opts.logPath)).toEqual([
      '/attempt/101/session.log',
      '/attempt/102/session.log',
    ]);
    expect(calls[0]!.args[calls[0]!.args.indexOf('-q') + 1]).toContain(
      'fix-child skill on child issue #101',
    );
    expect(calls[1]!.args[calls[1]!.args.indexOf('-q') + 1]).toContain(
      'reconcile skill on child issue #102',
    );
  });
});
