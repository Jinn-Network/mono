import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readAttributionEvidenceBundle,
  readBoundedRegularFile,
  readBoundedRegularFileDescriptor,
} from '../../scripts/attribution-files.js';
import { createAttributionVerdictProof } from '../eval/attribution-verdict-fixture.js';

const SCRIPT = 'scripts/analyze-attribution-instrument.ts';
const EXPORTER = 'scripts/export-attribution-facts.ts';
const TSX = 'node_modules/.bin/tsx';
const hash = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ref = (character: string): string => `sha256:${character.repeat(64)}`;

function fixture() {
  const instanceIds = Array.from({ length: 6 }, (_, index) => `task-${index}`);
  const runtime = {
    modelRef: 'provider/model@version',
    harnessRef: 'daemon-task-engine.v1',
    graderRef: 'eval-semantics:v1',
    taskSourceRef: ref('1'),
    sourceRevision: '4bb1c1a21b9cc8966fa29ba67b3211eca3a676fa',
  };
  const cells = [
    { autoload: 'off', corpusSnapshotRef: ref('2'), treatmentConfigDigest: ref('3') },
    { autoload: 'on', corpusSnapshotRef: ref('2'), treatmentConfigDigest: ref('4') },
  ] as const;
  const preregistration = {
    schema: 'jinn.attribution-preregistration.v1',
    instrumentId: 'cli-daemon-readout',
    registeredAt: '2020-07-20T08:00:00.000Z',
    design: 'matched-daemon-autoload-1x2',
    window: { startsAt: '2020-07-21T08:00:00.000Z', endsAt: '2020-07-22T08:00:00.000Z' },
    primaryOutcome: 'completed-with-accepted-diff',
    alpha: 0.05,
    minimumMatchedPairs: 6,
    minimumDiscordantPairs: 6,
    executionOrderSeed: '2',
    runtime,
    population: { instanceIds },
    cells,
  };
  const facts = {
    schema: 'jinn.attribution-facts.v1',
    instrumentId: preregistration.instrumentId,
    completedAt: '2020-07-22T09:00:00.000Z',
    evidenceManifestDigest: ref('0'),
    cells: cells.map((cell, cellIndex) => ({
      ...cell,
      runtime,
      isolation: {
        runId: `run-${cell.autoload}`,
        agentHomeDigest: ref(cell.autoload === 'off' ? '5' : '6'),
        storeDigest: ref(cell.autoload === 'off' ? '7' : '8'),
      },
      startedAt: `2020-07-21T${cellIndex === 0 ? '08' : '14'}:00:00.000Z`,
      completedAt: `2020-07-21T${cellIndex === 0 ? '13' : '19'}:00:00.000Z`,
      results: instanceIds.map((instanceId, index) => ({
        instanceId,
        startedAt: `2020-07-21T${cellIndex === 0 ? '09' : '15'}:0${index}:00.000Z`,
        completedAt: `2020-07-21T${cellIndex === 0 ? '09' : '15'}:0${index}:30.000Z`,
        passed: cell.autoload === 'on',
        unscorable: false,
        sessionKind: 'user',
        origin: 'marketplace',
        verdictRef: `verdict:${cell.autoload}:${instanceId}`,
        verdictEvidenceDigest: ref('0'),
        deliveredRefs: cell.autoload === 'on' ? [ref(String(index + 1))] : [],
        cost: {
          inputTokens: 100 + index,
          outputTokens: 20 + index,
          usdMicros: 1_000 + index,
          usdMicrosEstimated: false,
        },
      })),
    })),
  };
  return { preregistration, facts };
}

async function materialize(dir: string, data = fixture()) {
  const files: Array<{ path: string; content: string; digest: string }> = [];
  for (let cellIndex = 0; cellIndex < data.facts.cells.length; cellIndex++) {
    const cell = data.facts.cells[cellIndex]!;
    for (let resultIndex = 0; resultIndex < cell.results.length; resultIndex++) {
      const result = cell.results[resultIndex]!;
      const verdictProof = await createAttributionVerdictProof({
        instanceId: result.instanceId,
        acceptedDiff: result.passed === true,
        nonce: cellIndex * 1_000 + resultIndex,
      });
      result.verdictRef =
        `verdict:${verdictProof.marketplace.verdict.chainId}:`
        + `${verdictProof.marketplace.verdict.taskId}:`
        + `${verdictProof.marketplace.verdict.attemptIndex}:`
        + `${verdictProof.marketplace.verdict.verdictIndex}:`
        + verdictProof.marketplace.verdict.requestId;
      const receipt = {
        schema: 'jinn.attribution-verdict-receipt.v1',
        instrumentId: data.facts.instrumentId,
        autoload: cell.autoload,
        corpusSnapshotRef: cell.corpusSnapshotRef,
        treatmentConfigDigest: cell.treatmentConfigDigest,
        runtime: cell.runtime,
        isolation: cell.isolation,
        cellStartedAt: cell.startedAt,
        cellCompletedAt: cell.completedAt,
        instanceId: result.instanceId,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        sessionKind: result.sessionKind,
        origin: 'marketplace',
        verdictProof,
        deliveredRefs: result.deliveredRefs,
        cost: result.cost,
      };
      const content = `${JSON.stringify(receipt)}\n`;
      const digest = hash(content);
      result.verdictEvidenceDigest = digest;
      files.push({
        path: `cells/${cell.autoload}/${result.instanceId}.json`,
        content,
        digest,
      });
    }
  }
  const manifest = `${files.map((file) => `${file.digest.slice(7)}  ${file.path}`).sort().join('\n')}\n`;
  data.facts.evidenceManifestDigest = hash(manifest);
  const preregPath = join(dir, 'preregistration.json');
  const factsPath = join(dir, 'facts.json');
  const evidencePath = join(dir, 'cell-evidence.sha256');
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, file.content);
  }
  writeFileSync(preregPath, JSON.stringify(data.preregistration));
  writeFileSync(factsPath, JSON.stringify(data.facts));
  writeFileSync(evidencePath, manifest);
  return { preregPath, factsPath, evidencePath, files, data };
}

function run(paths: Awaited<ReturnType<typeof materialize>>, format = 'json') {
  return spawnSync(TSX, [
    SCRIPT,
    '--prereg', paths.preregPath,
    '--facts', paths.factsPath,
    '--evidence-manifest', paths.evidencePath,
    '--format', format,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

function runExporter(paths: Awaited<ReturnType<typeof materialize>>) {
  return spawnSync(TSX, [
    EXPORTER,
    '--prereg', paths.preregPath,
    '--evidence-manifest', paths.evidencePath,
    '--completed-at', paths.data.facts.completedAt,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

describe('daemon attribution CLI', () => {
  it('exports deterministic analyzer-ready facts from receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths = await materialize(dir);
    const first = runExporter(paths);
    const second = runExporter(paths);

    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toEqual(paths.data.facts);
  });

  it('prints byte-stable JSON and Markdown and writes no files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths = await materialize(dir);
    const before = readdirSync(dir).sort();
    const jsonFirst = run(paths);
    const jsonSecond = run(paths);
    const markdownFirst = run(paths, 'markdown');
    const markdownSecond = run(paths, 'markdown');

    expect(jsonFirst.status).toBe(0);
    expect(jsonFirst.stderr).toBe('');
    expect(jsonFirst.stdout).toBe(jsonSecond.stdout);
    expect(JSON.parse(jsonFirst.stdout).comparison).toMatchObject({
      signal: 'helped',
      matchedN: 6,
    });
    expect(markdownFirst.status).toBe(0);
    expect(markdownFirst.stdout).toBe(markdownSecond.stdout);
    expect(markdownFirst.stdout).toContain('daemon autoload off → on');
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it.each([
    ['runtime drift', (data: ReturnType<typeof fixture>) => { data.facts.cells[0]!.runtime.modelRef = 'other'; }],
    ['population drift', (data: ReturnType<typeof fixture>) => { data.facts.cells[0]!.results[0]!.instanceId = 'other'; }],
    ['host internal', (data: ReturnType<typeof fixture>) => { data.facts.cells[0]!.results[0]!.sessionKind = 'host-internal'; }],
    ['synthetic', (data: ReturnType<typeof fixture>) => { data.facts.cells[0]!.results[0]!.origin = 'synthetic'; }],
    ['off delivery', (data: ReturnType<typeof fixture>) => { data.facts.cells[0]!.results[0]!.deliveredRefs = [ref('9')]; }],
  ])('exits nonzero without stdout on %s', async (_name, mutate) => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const data = fixture();
    const paths = await materialize(dir, data);
    mutate(data);
    writeFileSync(paths.factsPath, JSON.stringify(data.facts));
    const result = run(paths);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('rejects receipt tampering and facts/receipt contradiction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths = await materialize(dir);
    writeFileSync(join(dir, paths.files[0]!.path), 'tampered');
    expect(run(paths)).toMatchObject({ status: 1, stdout: '' });

    const dir2 = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths2 = await materialize(dir2);
    paths2.data.facts.cells[1]!.results[0]!.deliveredRefs = [ref('9')];
    writeFileSync(paths2.factsPath, JSON.stringify(paths2.data.facts));
    const contradicted = run(paths2);
    expect(contradicted.status).toBe(1);
    expect(contradicted.stdout).toBe('');
    expect(contradicted.stderr).toMatch(/facts do not match/i);
  });

  it('rejects unsafe and symlink-escaping evidence paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths = await materialize(dir);
    writeFileSync(paths.evidencePath, `${'a'.repeat(64)}  cells/../outside\n`);
    expect(run(paths)).toMatchObject({ status: 1, stdout: '' });

    const dir2 = mkdtempSync(join(tmpdir(), 'jinn-attribution-cli-'));
    const paths2 = await materialize(dir2);
    const outsideDir = mkdtempSync(join(tmpdir(), 'jinn-attribution-outside-'));
    const outside = join(outsideDir, 'receipt');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(dir2, 'cells', 'escape'));
    const contentHash = hash(readFileSync(outside)).slice(7);
    writeFileSync(paths2.evidencePath, `${contentHash}  cells/escape\n`);
    paths2.data.facts.evidenceManifestDigest = hash(`${contentHash}  cells/escape\n`);
    writeFileSync(paths2.factsPath, JSON.stringify(paths2.data.facts));
    expect(run(paths2)).toMatchObject({ status: 1, stdout: '' });
  });

  it('bounds individual, aggregate, and growing evidence reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-attribution-bounds-'));
    const oversizedPath = join(dir, 'oversized');
    writeFileSync(oversizedPath, 'ab');
    expect(() => readBoundedRegularFile(oversizedPath, 1, 'oversized')).toThrow(
      /maximum byte size/i,
    );

    const growingPath = join(dir, 'growing');
    writeFileSync(growingPath, 'a');
    const fd = openSync(growingPath, constants.O_RDONLY);
    try {
      const initialSize = fstatSync(fd).size;
      appendFileSync(growingPath, 'b');
      expect(() =>
        readBoundedRegularFileDescriptor(fd, initialSize, 8, 'growing'),
      ).toThrow(/grew/i);
    } finally {
      closeSync(fd);
    }

    const cells = join(dir, 'cells');
    mkdirSync(cells);
    const files = [
      { path: 'cells/a', content: 'abc' },
      { path: 'cells/b', content: 'def' },
    ];
    for (const file of files) writeFileSync(join(dir, file.path), file.content);
    const manifest = `${files.map((file) =>
      `${hash(file.content).slice(7)}  ${file.path}`).join('\n')}\n`;
    const manifestPath = join(dir, 'evidence.sha256');
    writeFileSync(manifestPath, manifest);
    expect(() => readAttributionEvidenceBundle(manifestPath, 5)).toThrow(
      /aggregate evidence.*maximum/i,
    );
  });

  it('keeps runbook Bash parseable and every analyzer call evidence-bound', () => {
    const runbook = readFileSync(
      join(process.cwd(), '..', 'docs', 'runbooks', 'stage2-attribution-instrument.md'),
      'utf8',
    );
    const bash = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join('\n');
    expect(spawnSync('/bin/bash', ['-n'], { input: bash }).status).toBe(0);
    expect(runbook.match(/attribution:(?:analyze|export-facts)/g)?.length).toBe(
      runbook.match(/--evidence-manifest/g)?.length,
    );
    expect(runbook.match(/attribution:export-facts/g)?.length).toBe(2);
    const createdAtFetches = runbook.match(/--jq '\.created_at'/g)?.length ?? 0;
    expect(runbook.match(/--jq '\.updated_at'/g)?.length ?? 0).toBe(createdAtFetches);
    expect(
      runbook.match(
        /test "\$(?:REMOTE_)?ANCHOR_CREATED_AT" = "\$(?:REMOTE_)?ANCHOR_UPDATED_AT"/g,
      )?.length ?? 0,
    ).toBe(createdAtFetches);
    expect(runbook).toContain('DERIVED_CELL_ORDER');
    expect(runbook).toContain('executionOrderSeed');
    expect(runbook).toContain('createHash("sha256")');
    expect(runbook).toContain('"verdictCode": 1');
    expect(runbook).toMatch(/Pass\s*=\s*1[\s\S]*Fail\s*=\s*2/);
  });
});
