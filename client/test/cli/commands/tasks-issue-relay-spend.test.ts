import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import { Store } from '@/store/store.js';
import { makeCommandCtx } from '@test/cli.js';

const SAFE = '0x00112233445566778899AABbCCdDeeFf00112233';
const MECH = '0x2222222222222222222222222222222222222222';
const MANIFEST = 'bafy-relay-solvernet';
const BASE_RATE_WEI = 20n;

const createCliExecutionContext = vi.hoisted(() => vi.fn());
const createCliReadOnlySignerContext = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  ctx: {
    publicClient: {},
    fleetState: {
      services: [{
        index: 0,
        step: 'complete',
        safe_address: SAFE,
        mech_address: MECH,
      }],
    },
  },
})));
const getMechDeliveryRate = vi.hoisted(() => vi.fn(async () => BASE_RATE_WEI));
const gatherIntrospectionRaw = vi.hoisted(() => vi.fn());

vi.mock('@/cli/execution-context.js', () => ({
  createCliExecutionContext,
  createCliReadOnlySignerContext,
  pickPrimaryMechService: (
    services: Array<{ safe_address?: string; mech_address?: string }>,
  ) => services.find((service) => service.safe_address && service.mech_address),
}));
vi.mock('@/cli/introspection-context.js', () => ({ gatherIntrospectionRaw }));
vi.mock('@/adapters/mech/contracts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/adapters/mech/contracts.js')>()),
  getMechDeliveryRate,
}));

const temporaryStores: Store[] = [];

afterEach(() => {
  for (const store of temporaryStores.splice(0)) store.close();
  createCliExecutionContext.mockReset();
  createCliReadOnlySignerContext.mockClear();
  getMechDeliveryRate.mockClear();
  gatherIntrospectionRaw.mockClear();
});

function relayFixture(options: {
  readonly canonicalSpecBytes?: number;
} = {}): {
  readonly configPath: string;
  readonly specPath: string;
  readonly argv: string[];
} {
  const directory = mkdtempSync(join(tmpdir(), 'jinn-relay-spend-'));
  const configPath = join(directory, 'config.json');
  const specPath = join(directory, 'spec.json');
  writeFileSync(configPath, JSON.stringify({
    joinedSolverNets: {
      [MANIFEST]: {
        manifestCid: MANIFEST,
        name: 'jinn-repo',
        contract: { id: 'jinn-repo', version: 'v1' },
        roles: ['solver'],
      },
    },
  }));
  const relay = {
    schemaVersion: 'jinn-issue-relay-round.v1',
    generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    round: 0,
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: 'a'.repeat(40),
    purpose: 'initial',
    findings: [],
  };
  const spec = {
    schemaVersion: 'jinn-repo.v1',
    source: 'live-issue',
    instance_id: 'relay:test:0',
    repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40),
    language: 'typescript',
    problem_statement: 'Fix the frozen issue.',
    issue_number: 42,
    relay,
  };
  if (options.canonicalSpecBytes !== undefined) {
    const empty = { ...spec, problem_statement: '' };
    const fixedBytes = Buffer.byteLength(`${JSON.stringify(empty, null, 2)}\n`);
    spec.problem_statement =
      'x'.repeat(options.canonicalSpecBytes - fixedBytes);
    if (
      Buffer.byteLength(`${JSON.stringify(spec, null, 2)}\n`)
      !== options.canonicalSpecBytes
    ) {
      throw new Error('Failed to synthesize an exact-size Relay spec fixture');
    }
  }
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return {
    configPath,
    specPath,
    argv: [
      'submit',
      '--id', 'relay:test:0',
      '--description', 'Jinn Issue Relay round 0',
      '--solver-net', 'jinn-repo',
      '--solver-type', 'jinn-repo.v1',
      '--spec-file', specPath,
      '--max-claims', '1',
      '--required-verdicts', '1',
      '--max-spend-wei', '100',
      '--config', configPath,
      '--yes',
      '--json',
    ],
  };
}

describe('Issue Relay loose-flag spend contract', () => {
  it('rejects a Relay spec over 2 MiB before signer or funding resolution', async () => {
    const fixture = relayFixture({
      canonicalSpecBytes: 2 * 1024 * 1024 + 1,
    });
    const made = makeCommandCtx({
      argv: [
        ...fixture.argv.slice(0, -2),
        '--dry-run',
        '--yes',
        '--json',
      ],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringMatching(/spec.*2 MiB|spec.*byte limit/i),
    });
    expect(createCliReadOnlySignerContext).not.toHaveBeenCalled();
    expect(getMechDeliveryRate).not.toHaveBeenCalled();
  });

  it('dry-run accepts an exact 2 MiB Relay spec and reports the funding plan', async () => {
    const fixture = relayFixture({
      canonicalSpecBytes: 2 * 1024 * 1024,
    });
    const made = makeCommandCtx({
      argv: [
        ...fixture.argv.slice(0, -2),
        '--dry-run',
        '--yes',
        '--json',
      ],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      schemaVersion: 1,
      dryRun: true,
      verb: 'tasks submit',
      plan: [{
        id: 'relay:test:0',
        creatorMultisig: SAFE,
        asset: 'native',
        txCount: 1,
        solverNetManifestCid: MANIFEST,
        proposedSpendWei: '40',
      }],
    });
    expect(createCliReadOnlySignerContext).toHaveBeenCalledOnce();
    expect(gatherIntrospectionRaw).not.toHaveBeenCalled();
  });

  it('returns a machine failure envelope when spend resolution is unavailable', async () => {
    const fixture = relayFixture();
    getMechDeliveryRate.mockRejectedValueOnce(new Error('rate RPC unavailable'));
    const made = makeCommandCtx({
      argv: [
        ...fixture.argv.slice(0, -2),
        '--dry-run',
        '--yes',
        '--json',
      ],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      message: expect.stringMatching(/rate RPC unavailable/i),
    });
    expect(made.exits).toEqual([40]);
  });

  it('rejects changed economics at the funding fence without broadcasting', async () => {
    const fixture = relayFixture();
    const store = new Store(':memory:');
    temporaryStores.push(store);
    const broadcast = vi.fn();
    const adapter = {
      postTask: vi.fn(async (
        _task: unknown,
        options?: {
          assertFunding?: (facts: {
            creatorSafe: string;
            solverNetManifestCid: string;
            proposedSpendWei: bigint;
          }) => void | Promise<void>;
        },
      ) => {
        await options?.assertFunding?.({
          creatorSafe: SAFE,
          solverNetManifestCid: MANIFEST,
          proposedSpendWei: 41n,
        });
        broadcast();
        return {
          taskId: '501',
          taskCid: `f01551220${'ab'.repeat(32)}`,
          txHash: `0x${'cd'.repeat(32)}`,
          blockNumber: 100,
        };
      }),
    };
    createCliExecutionContext.mockResolvedValue({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: SAFE,
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const made = makeCommandCtx({
      argv: fixture.argv,
      env: {
        JINN_RELAY_EXPECTED_CREATOR_SAFE: SAFE,
        JINN_RELAY_EXPECTED_SOLVERNET_MANIFEST_CID: MANIFEST,
        JINN_RELAY_EXPECTED_SPEND_WEI: '40',
      },
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'fatal',
      message: expect.stringMatching(/spend|economics|40.*41|41.*40/i),
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
