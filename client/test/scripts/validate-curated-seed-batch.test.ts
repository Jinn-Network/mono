import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCuratedSeedBatchArgs,
  runCuratedSeedBatchValidator,
} from '../../scripts/validate-curated-seed-batch.js';

const STAGE1_FIXTURES_DIR = fileURLToPath(
  new URL('../../../packages/layer/fixtures/stage1-seeds', import.meta.url),
);

function validEpisode(index: number): Record<string, unknown> {
  const baseCommit = String(index).repeat(40);
  const sourceCommit = String(index + 3).repeat(40);
  return {
    id: `cli-curated-${index}`,
    repo: 'Jinn-Network/mono',
    baseCommit,
    taskSummary: `Fix verified mono behavior ${index}`,
    tags: ['mono', `subsystem-${index}`, 'retrieval:visible.v1'],
    steps: [
      { label: 'failure', title: 'failure', text: 'real failing command output' },
      { label: 'fix', title: 'fix', text: 'bounded verified correction' },
      { label: 'command', title: 'command', text: 'real passing command output' },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'A specific mono behavior failed. The bounded correction fixed it. The scoped test passed.',
    attribution: {
      origin: 'operator-recorded-session',
      sourceUrl: `https://github.com/Jinn-Network/mono/commit/${sourceCommit}`,
    },
  };
}

describe('validate-curated-seed-batch CLI', () => {
  it('parses an explicit candidate directory while defaulting to the mono repository', () => {
    expect(
      parseCuratedSeedBatchArgs([
        '--episodes-dir',
        '/tmp/curated candidates',
        '--json',
      ]),
    ).toEqual({
      episodesDir: '/tmp/curated candidates',
      repoSlug: 'Jinn-Network/mono',
      json: true,
    });
  });

  it('requires an explicit directory and rejects unknown arguments', () => {
    expect(() => parseCuratedSeedBatchArgs([])).toThrow(/--episodes-dir is required/);
    expect(() =>
      parseCuratedSeedBatchArgs(['--episodes-dir', '/tmp/episodes', '--publish']),
    ).toThrow(/unknown argument: --publish/);
  });

  it('reports the checked-in Stage 1 fixtures as one-of-three, exits nonzero, and never claims live or publish success', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runCuratedSeedBatchValidator(
      [
        '--episodes-dir',
        STAGE1_FIXTURES_DIR,
        '--repo',
        'Jinn-Network/mono',
        '--json',
      ],
      { stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(report).toMatchObject({
      automatedStatus: 'fail',
      eligibleRecordCount: 1,
      requiredRecords: 3,
      humanCurationRequired: true,
      publishAuthorized: false,
      liveProbe: { status: 'not-run' },
    });
  });

  it('exits zero for an exact-K mechanically eligible temporary batch while retaining every human/live boundary', async () => {
    const episodesDir = mkdtempSync(join(tmpdir(), 'jinn-curated-cli-'));
    try {
      for (const index of [1, 2, 3]) {
        writeFileSync(
          join(episodesDir, `cli-curated-${index}.episode.json`),
          `${JSON.stringify(validEpisode(index), null, 2)}\n`,
        );
      }
      const stdout = vi.fn();
      const exitCode = await runCuratedSeedBatchValidator(
        ['--episodes-dir', episodesDir, '--json'],
        { stdout, stderr: vi.fn() },
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
      expect(report).toMatchObject({
        automatedStatus: 'pass',
        eligibleRecordCount: 3,
        requiredRecords: 3,
        humanCurationRequired: true,
        publishAuthorized: false,
        liveProbe: { status: 'not-run' },
      });
    } finally {
      rmSync(episodesDir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked candidate files instead of reading outside the directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-curated-symlink-'));
    const episodesDir = join(root, 'episodes');
    const outside = join(root, 'outside.json');
    try {
      writeFileSync(outside, `${JSON.stringify(validEpisode(1))}\n`);
      mkdirSync(episodesDir);
      symlinkSync(outside, join(episodesDir, 'linked.episode.json'));

      await expect(
        runCuratedSeedBatchValidator(
          ['--episodes-dir', episodesDir, '--json'],
          { stdout: vi.fn(), stderr: vi.fn() },
        ),
      ).rejects.toThrow(/symbolic link|regular file/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized candidate files before parsing them', async () => {
    const episodesDir = mkdtempSync(join(tmpdir(), 'jinn-curated-oversized-'));
    try {
      writeFileSync(
        join(episodesDir, 'oversized.episode.json'),
        ' '.repeat(1_048_577),
      );
      await expect(
        runCuratedSeedBatchValidator(
          ['--episodes-dir', episodesDir, '--json'],
          { stdout: vi.fn(), stderr: vi.fn() },
        ),
      ).rejects.toThrow(/exceeds.*byte/i);
    } finally {
      rmSync(episodesDir, { recursive: true, force: true });
    }
  });

  it('rejects candidate directories over the bounded file-count ceiling', async () => {
    const episodesDir = mkdtempSync(join(tmpdir(), 'jinn-curated-too-many-'));
    try {
      for (let index = 0; index < 101; index += 1) {
        writeFileSync(join(episodesDir, `${index}.episode.json`), '{}');
      }
      await expect(
        runCuratedSeedBatchValidator(
          ['--episodes-dir', episodesDir, '--json'],
          { stdout: vi.fn(), stderr: vi.fn() },
        ),
      ).rejects.toThrow(/101 candidate files; maximum is 100/);
    } finally {
      rmSync(episodesDir, { recursive: true, force: true });
    }
  });
});
