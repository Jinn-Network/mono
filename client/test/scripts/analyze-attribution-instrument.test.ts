import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/analyze-attribution-instrument.ts';
const TSX = 'node_modules/.bin/tsx';

function fixture(window = {
  startsAt: '2020-07-21T08:00:00.000Z',
  endsAt: '2020-07-22T08:00:00.000Z',
}): { preregistration: unknown; facts: unknown } {
  const marketplaceArms = ['seedsOnly', 'rawEvidence', 'distilled'] as const;
  const cells = marketplaceArms.flatMap((marketplaceArm) =>
    (['off', 'on'] as const).map((autoload) => ({
      marketplaceArm,
      autoload,
      corpusSnapshotRef: `bafy-${marketplaceArm}`,
    })));
  const instanceIds = Array.from({ length: 6 }, (_, index) => `task-${index}`);
  return {
    preregistration: {
      schema: 'jinn.attribution-preregistration.v1',
      instrumentId: 'cli-readout',
      registeredAt: '2020-07-20T08:00:00.000Z',
      design: 'matched-crossed-3x2',
      window,
      primaryOutcome: 'completed-with-accepted-diff',
      primaryMarketplaceArm: 'rawEvidence',
      alpha: 0.05,
      minimumMatchedPairs: 6,
      minimumDiscordantPairs: 6,
      executionOrderSeed: 'sha256:fixed-before-run',
      runtime: {
        modelRef: 'provider/model@version',
        harnessRef: 'swe-rebench-v2.v1',
        graderRef: 'eval-semantics:v1',
        taskSourceRef: 'held-out-slate:v3',
        sourceRevision: '33abcbd1ed7ebe98c6c774ff2857afb023deaf7d',
      },
      population: { instanceIds },
      cells,
    },
    facts: {
      schema: 'jinn.attribution-facts.v1',
      instrumentId: 'cli-readout',
      completedAt: '2020-07-22T09:00:00.000Z',
      runtime: {
        modelRef: 'provider/model@version',
        harnessRef: 'swe-rebench-v2.v1',
        graderRef: 'eval-semantics:v1',
        taskSourceRef: 'held-out-slate:v3',
        sourceRevision: '33abcbd1ed7ebe98c6c774ff2857afb023deaf7d',
      },
      cells: cells.map((cell) => ({
        ...cell,
        results: instanceIds.map((instanceId, index) => ({
          instanceId,
          passed: cell.marketplaceArm === 'rawEvidence'
            ? cell.autoload === 'on'
            : index % 2 === 0,
          unscorable: false,
          sessionKind: 'user',
          origin: 'marketplace',
          verdictRef: `verdict:${instanceId}:${cell.marketplaceArm}:${cell.autoload}`,
          deliveredRefs: cell.autoload === 'on' ? [`sha256:${instanceId}`] : [],
        })),
      })),
    },
  };
}

function writeFixture(dir: string, data = fixture()): { preregPath: string; factsPath: string } {
  const preregPath = join(dir, 'preregistration.json');
  const factsPath = join(dir, 'facts.json');
  writeFileSync(preregPath, `${JSON.stringify(data.preregistration, null, 2)}\n`);
  writeFileSync(factsPath, `${JSON.stringify(data.facts, null, 2)}\n`);
  return { preregPath, factsPath };
}

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

describe('analyze-attribution-instrument CLI', () => {
  it('prints a JSON readout to stdout and writes no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const { preregPath, factsPath } = writeFixture(dir);
    const before = readdirSync(dir).sort();

    const result = run([
      '--prereg', preregPath,
      '--facts', factsPath,
      '--format', 'json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'jinn.attribution-readout.v1',
      instrumentId: 'cli-readout',
      primary: {
        marketplaceArm: 'rawEvidence',
        signal: 'helped',
        matchedN: 6,
      },
    });
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('prints the Markdown representation when requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const { preregPath, factsPath } = writeFixture(dir);

    const result = run([
      '--prereg', preregPath,
      '--facts', factsPath,
      '--format', 'markdown',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Stage 2 attribution readout');
    expect(result.stdout).toContain('Mechanical signal: helped');
    expect(result.stdout).toContain('Interpretation and downstream posture decisions remain human');
  });

  it('fails loud on missing or malformed inputs without leaking a stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{');

    const missing = run(['--prereg', join(dir, 'missing.json'), '--facts', malformed]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/unable to read preregistration/i);
    expect(missing.stderr).not.toContain('at analyzeAttributionInstrument');

    const invalid = run(['--prereg', malformed, '--facts', malformed]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/invalid JSON/i);
    expect(readFileSync(malformed, 'utf8')).toBe('{');
  });

  it('refuses a readout while the preregistered window is open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const data = fixture({
      startsAt: '2099-07-21T08:00:00.000Z',
      endsAt: '2099-07-22T08:00:00.000Z',
    });
    (data.preregistration as { registeredAt: string }).registeredAt = '2099-07-20T08:00:00.000Z';
    (data.facts as { completedAt: string }).completedAt = '2099-07-22T09:00:00.000Z';
    const { preregPath, factsPath } = writeFixture(dir, data);

    const result = run(['--prereg', preregPath, '--facts', factsPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fixed evaluation window has not closed/i);
  });
});
