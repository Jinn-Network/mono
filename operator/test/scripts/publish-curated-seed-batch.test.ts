import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalEpisodeSeedSource,
  createMemoryLedger,
  planEpisodes,
  type HarnessPublishDeps,
} from '@jinn-network/jinn-layer';
import {
  parseCuratedSeedPublisherArgs,
  runCuratedSeedPublisher,
} from '../../scripts/publish-curated-seed-batch.js';

const TEST_IDENTITY = {
  privateKey: `0x${'a'.repeat(64)}` as const,
  safeAddress: `0x${'1'.repeat(40)}` as const,
  agentId: 42n,
  agentAddress: `0x${'2'.repeat(40)}`,
  serviceIndex: 1,
};

function validEpisode(index: number): Record<string, unknown> {
  const sourceCommit = 'abcdef0123456789abcdef0123456789abcdef01'.split('');
  sourceCommit[index] = String(index);
  return {
    id: `launch-record-${index}`,
    repo: 'Jinn-Network/mono',
    baseCommit: String(index).repeat(40),
    taskSummary: `Fix verified mono behavior ${index}`,
    tags: ['mono', `subsystem-${index}`, 'retrieval:visible.v1'],
    steps: [
      {
        label: 'failure',
        title: 'Observed failure',
        text: `Scoped test ${index} failed before the correction.`,
      },
      {
        label: 'fix',
        title: 'Bounded correction',
        text: `The implementation corrected behavior ${index}.`,
      },
      {
        label: 'command',
        title: 'Verification',
        text: `The same scoped test ${index} passed after the correction.`,
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis:
      `Behavior ${index} failed under a reproducible condition. ` +
      'The correction was limited to the responsible boundary. ' +
      'The focused regression test passed after the change.',
    attribution: {
      origin: 'operator-recorded-session',
      sourceUrl:
        `https://github.com/Jinn-Network/mono/commit/${sourceCommit.join('')}`,
    },
  };
}

async function batchFixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-curated-publisher-'));
  const episodesDir = join(root, 'episodes');
  const reportPath = join(root, 'approved-report.json');
  const statePath = join(root, 'seed-import-state.json');
  mkdirSync(episodesDir);
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(
      join(episodesDir, `${index}.episode.json`),
      `${JSON.stringify(validEpisode(index), null, 2)}\n`,
    );
  }
  const report = await planEpisodes(createLocalEpisodeSeedSource(episodesDir));
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { root, episodesDir, reportPath, statePath, report };
}

function fakePublishDeps(options: { failEnvelope?: boolean } = {}): HarnessPublishDeps {
  let counter = 0;
  return {
    participant: {
      safeAddress: TEST_IDENTITY.safeAddress,
      agentEoa: TEST_IDENTITY.agentAddress as `0x${string}`,
    },
    signer: {
      address: `0x${'2'.repeat(40)}`,
      privateKey: TEST_IDENTITY.privateKey,
    },
    clientGitSha: 'test-client',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async () => ({
      cid: `bafyArtifact${++counter}`,
      sha256: 'a'.repeat(64),
    }),
    publishEnvelope: async () => {
      if (options.failEnvelope) {
        throw new Error('transport ended after upload');
      }
      return {
        cid: `bafyEnvelope${++counter}`,
        sha256: 'b'.repeat(64),
      };
    },
    anchorEnvelope: async () => ({
      txHash: `0x${'e'.repeat(64)}`,
      blockNumber: 1,
    }),
  };
}

describe('authorized curated seed publisher', () => {
  const temporaryDirectories: string[] = [];
  const originalSeedStatePath = process.env['JINN_LAYER_SEED_STATE_PATH'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSeedStatePath === undefined) {
      delete process.env['JINN_LAYER_SEED_STATE_PATH'];
    } else {
      process.env['JINN_LAYER_SEED_STATE_PATH'] = originalSeedStatePath;
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses the documented operator arguments and rejects unsafe ambiguity', () => {
    expect(
      parseCuratedSeedPublisherArgs([
        '--episodes-dir',
        '/tmp/episodes',
        '--report',
        '/tmp/report.json',
        '--password-fd',
        '7',
        '--json',
        '--yes',
      ]),
    ).toEqual({
      episodesDir: '/tmp/episodes',
      reportPath: '/tmp/report.json',
      passwordFd: 7,
      json: true,
      yes: true,
    });
    expect(() => parseCuratedSeedPublisherArgs([])).toThrow(
      /--episodes-dir is required/,
    );
    expect(() =>
      parseCuratedSeedPublisherArgs([
        '--episodes-dir',
        '/tmp/episodes',
        '--report',
        '/tmp/report.json',
        '--network',
        'mainnet',
      ]),
    ).toThrow(/unknown argument: --network/);
  });

  it('previews an approved batch without constructing publish dependencies, executing the layer, or writing seed state', async () => {
    const fixture = await batchFixture(3);
    temporaryDirectories.push(fixture.root);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const createPublishDeps = vi.fn(() => fakePublishDeps());
    const runLayerCli = vi.fn(async () => 0);

    const exitCode = await runCuratedSeedPublisher(
      [
        '--episodes-dir',
        fixture.episodesDir,
        '--report',
        fixture.reportPath,
        '--json',
      ],
      {
        stdout,
        stderr,
        deriveOperatorIdentity: async () => TEST_IDENTITY,
        createPublishDeps,
        runLayerCli,
        env: { JINN_LAYER_SEED_STATE_PATH: fixture.statePath },
      },
    );

    expect(exitCode).toBe(0);
    expect(createPublishDeps).not.toHaveBeenCalled();
    expect(runLayerCli).not.toHaveBeenCalled();
    expect(existsSync(fixture.statePath)).toBe(false);
    const preview = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(preview).toMatchObject({
      schemaVersion: 'jinn.curated-seed-publish-preview.v1',
      mode: 'preview',
      chainId: 84532,
      operator: {
        safeAddress: TEST_IDENTITY.safeAddress,
        agentId: '42',
        agentAddress: TEST_IDENTITY.agentAddress,
        serviceIndex: 1,
      },
      recordCount: 3,
    });
    expect(JSON.stringify(preview)).not.toContain(TEST_IDENTITY.privateKey);
  });

  it('rejects a mechanically ineligible batch before reading operator identity', async () => {
    const fixture = await batchFixture(2);
    temporaryDirectories.push(fixture.root);
    const deriveIdentity = vi.fn(async () => TEST_IDENTITY);

    const exitCode = await runCuratedSeedPublisher(
      [
        '--episodes-dir',
        fixture.episodesDir,
        '--report',
        fixture.reportPath,
      ],
      {
        stdout: vi.fn(),
        stderr: vi.fn(),
        deriveOperatorIdentity: deriveIdentity,
      },
    );

    expect(exitCode).toBe(1);
    expect(deriveIdentity).not.toHaveBeenCalled();
  });

  it('rejects changed candidate content before reading operator identity or creating live dependencies', async () => {
    const fixture = await batchFixture(3);
    temporaryDirectories.push(fixture.root);
    const changed = validEpisode(1);
    changed.synthesis = 'The approved content was changed after the plan was generated.';
    writeFileSync(
      join(fixture.episodesDir, '1.episode.json'),
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    const deriveIdentity = vi.fn(async () => TEST_IDENTITY);
    const createPublishDeps = vi.fn(() => fakePublishDeps());
    const stderr = vi.fn();

    const exitCode = await runCuratedSeedPublisher(
      [
        '--episodes-dir',
        fixture.episodesDir,
        '--report',
        fixture.reportPath,
        '--yes',
      ],
      {
        stdout: vi.fn(),
        stderr,
        deriveOperatorIdentity: deriveIdentity,
        createPublishDeps,
      },
    );

    expect(exitCode).toBe(1);
    expect(deriveIdentity).not.toHaveBeenCalled();
    expect(createPublishDeps).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(' ')).toMatch(/report.*current candidate/i);
  });

  it('injects live dependencies only after --yes and delegates the exact approved report to the parked layer command', async () => {
    const fixture = await batchFixture(3);
    temporaryDirectories.push(fixture.root);
    const calls: Array<{ argv: readonly string[]; hasPublishDeps: boolean }> = [];
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runCuratedSeedPublisher(
      [
        '--episodes-dir',
        fixture.episodesDir,
        '--report',
        fixture.reportPath,
        '--password-fd',
        '7',
        '--yes',
      ],
      {
        stdout,
        stderr,
        deriveOperatorIdentity: async (argv) => {
          expect(argv).toContain('--password-fd');
          return TEST_IDENTITY;
        },
        createPublishDeps: () => fakePublishDeps(),
        runLayerCli: async (argv, options) => {
          calls.push({ argv, hasPublishDeps: options.publishDeps !== undefined });
          return 0;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        argv: [
          'seed',
          'execute',
          fixture.reportPath,
          '--episodes-dir',
          fixture.episodesDir,
        ],
        hasPublishDeps: true,
      },
    ]);
    const output = [
      ...stdout.mock.calls.flat(),
      ...stderr.mock.calls.flat(),
    ].join('\n');
    expect(output).not.toContain(TEST_IDENTITY.privateKey);
  });

  it('imports five approved records and skips all five on an idempotent rerun', async () => {
    const fixture = await batchFixture(5);
    temporaryDirectories.push(fixture.root);
    process.env['JINN_LAYER_SEED_STATE_PATH'] = fixture.statePath;

    const run = async () => {
      const stdout = vi.fn();
      const stderr = vi.fn();
      const code = await runCuratedSeedPublisher(
        [
          '--episodes-dir',
          fixture.episodesDir,
          '--report',
          fixture.reportPath,
          '--json',
          '--yes',
        ],
        {
          stdout,
          stderr,
          deriveOperatorIdentity: async () => TEST_IDENTITY,
          createPublishDeps: () => fakePublishDeps(),
        },
      );
      return {
        code,
        result: JSON.parse(stdout.mock.calls.at(-1)?.[0] as string),
        stderr: stderr.mock.calls.flat().join('\n'),
      };
    };

    const first = await run();
    expect(first.code, `${JSON.stringify(first.result)}\n${first.stderr}`).toBe(0);
    expect(first.result.imported).toHaveLength(5);
    expect(first.result.skipped).toHaveLength(0);
    expect(JSON.parse(readFileSync(fixture.statePath, 'utf8'))).toHaveProperty(
      'episode:launch-record-1',
    );

    const second = await run();
    expect(second.code).toBe(0);
    expect(second.result.imported).toHaveLength(0);
    expect(second.result.skipped).toHaveLength(5);
  });

  it('propagates an ambiguous publication result as nonzero and tells the operator not to retry', async () => {
    const fixture = await batchFixture(3);
    temporaryDirectories.push(fixture.root);
    process.env['JINN_LAYER_SEED_STATE_PATH'] = fixture.statePath;
    const stdout = vi.fn();

    const exitCode = await runCuratedSeedPublisher(
      [
        '--episodes-dir',
        fixture.episodesDir,
        '--report',
        fixture.reportPath,
        '--json',
        '--yes',
      ],
      {
        stdout,
        stderr: vi.fn(),
        deriveOperatorIdentity: async () => TEST_IDENTITY,
        createPublishDeps: () => fakePublishDeps({ failEnvelope: true }),
      },
    );

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout.mock.calls.at(-1)?.[0] as string);
    expect(result.errors[0]?.error).toMatch(/do not auto-retry/i);
    expect(result.imported).toHaveLength(0);
  });
});
