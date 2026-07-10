import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCompatiblePilotManifest,
  attemptKey,
  attemptRecordFileName,
  buildAttemptSpecs,
  buildPilotManifest,
  loadAttemptRecords,
  recordsToOutcomes,
  selectRunnableAttempts,
  writeAttemptRecord,
  writePatch,
  type PilotAttemptRecord,
  type PilotSemanticConfig,
} from '../../src/pilot/resume.js';

function cfg(overrides: Partial<PilotSemanticConfig> = {}): PilotSemanticConfig {
  return {
    instances: [
      { instance_id: 'alpha/repo__bug-1', hf_dataset: 'ds', hf_split: 'train' },
      { instance_id: 'beta__bug-2', hf_dataset: 'ds', hf_split: 'train' },
    ],
    repeats: 2,
    arms: [
      { name: 'stock', skills: [] },
      { name: 'mini', skills: ['mini-skill'] },
      { name: 'gpt55', skills: ['normal-skill'] },
    ],
    maxTurns: 20,
    gradeTimeoutMs: 600_000,
    provider: 'openai-codex',
    model: 'gpt-5.4-mini',
    taskSource: 'held-out-slate:v3',
    slateHash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function record(
  id: string,
  arm: string,
  repeat: number,
  overrides: Partial<PilotAttemptRecord> = {},
): PilotAttemptRecord {
  return {
    schema: 'jinn.pilot.attempt.v1',
    instance_id: id,
    arm,
    repeat,
    status: 'graded',
    passed: true,
    costUsd: 0.03,
    ...overrides,
  };
}

describe('pilot resume durability', () => {
  it('uses safe deterministic attempt record paths for repo-like ids', () => {
    const spec = { instance_id: 'foo/bar__baz-1:case', arm: 'stock', repeat: 3 };
    const file = attemptRecordFileName(spec);

    expect(file).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    expect(attemptRecordFileName(spec)).toBe(file);
    expect(attemptKey(spec)).toBe('foo/bar__baz-1:case:stock:3');
  });

  it('writes attempt records and patches, then loads records keyed by attempt', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-resume-'));
    const r = record('foo/bar__baz-1', 'B', 1, {
      sessionId: '20260709_abc',
      tokens: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 1 },
    });

    const patchRelPath = writePatch(outDir, r, 'diff --git a/x b/x\n+ok\n');
    writeAttemptRecord(outDir, { ...r, patchRelPath });

    const loaded = loadAttemptRecords(outDir);
    expect(loaded.get(attemptKey(r))).toMatchObject({ status: 'graded', sessionId: '20260709_abc', patchRelPath });
    expect(readFileSync(join(outDir, patchRelPath), 'utf-8')).toContain('+ok');
    expect(existsSync(join(outDir, 'attempts', attemptRecordFileName(r)))).toBe(true);
  });

  it('reconstructs SolveOutcome rows from terminal attempt records', () => {
    const records: PilotAttemptRecord[] = [
      record('alpha', 'stock', 0, { status: 'graded', passed: false, costUsd: 0.05 }),
      record('alpha', 'mini', 0, { status: 'ungradeable', passed: null, costUsd: 0.02 }),
      record('beta', 'stock', 0, { status: 'solve-error', passed: null, costUsd: 0, error: 'spawn failed' }),
      record('beta', 'mini', 0, { status: 'grade-error', passed: null, costUsd: 0.01, error: 'docker failed' }),
    ];

    expect(recordsToOutcomes(records)).toEqual([
      { instance_id: 'alpha', arm: 'stock', repeat: 0, passed: false, costUsd: 0.05 },
      { instance_id: 'alpha', arm: 'mini', repeat: 0, passed: null, costUsd: 0.02 },
      { instance_id: 'beta', arm: 'stock', repeat: 0, passed: null, costUsd: 0 },
      { instance_id: 'beta', arm: 'mini', repeat: 0, passed: null, costUsd: 0.01 },
    ]);
  });

  it('detects semantic config mismatches but allows runtime path changes', () => {
    const manifest = buildPilotManifest(cfg(), { generatedAt: '2026-07-09T00:00:00.000Z' });

    expect(() => assertCompatiblePilotManifest(manifest, cfg())).not.toThrow();
    expect(() => assertCompatiblePilotManifest(manifest, cfg({
      arms: [
        { name: 'stock', skills: [] },
        { name: 'mini', skills: ['different-skill'] },
        { name: 'gpt55', skills: ['normal-skill'] },
      ],
    }))).toThrow(/different frozen pilot config/i);
    expect(() => assertCompatiblePilotManifest(manifest, cfg({
      arms: [
        { name: 'stock', skills: [] },
        { name: 'mini', skills: ['mini-skill'] },
        { name: 'gpt55', skills: ['normal-skill'], jinnAgentHome: '/tmp/different-home' },
      ],
    }))).not.toThrow();
    expect(() => assertCompatiblePilotManifest(manifest, cfg({
      model: 'gpt-5.5',
    }))).toThrow(/model/i);
    expect(() => assertCompatiblePilotManifest(manifest, cfg({
      slateHash: `sha256:${'b'.repeat(64)}`,
    }))).toThrow(/slateHash/i);
  });

  it('treats legacy skills manifests as the old A/B arm shape', () => {
    const legacy = {
      schema: 'jinn.pilot.manifest.v1',
      generatedAt: '2026-07-09T00:00:00.000Z',
      attemptCount: 2,
      semanticConfig: {
        instances: [{ instance_id: 'alpha', hf_dataset: 'ds', hf_split: 'train' }],
        repeats: 1,
        // Legacy pre-configurable-arms manifest shape.
        skills: ['legacy-skill'],
        maxTurns: 20,
        gradeTimeoutMs: 600_000,
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
      },
    } as unknown as ReturnType<typeof buildPilotManifest>;

    expect(() => assertCompatiblePilotManifest(legacy, cfg({
      instances: [{ instance_id: 'alpha', hf_dataset: 'ds', hf_split: 'train' }],
      repeats: 1,
      arms: [
        { name: 'A', skills: [] },
        { name: 'B', skills: ['legacy-skill'], jinnAgentHome: '/tmp/runtime-home' },
      ],
    }))).not.toThrow();
  });

  it('selects missing attempts first, and retries errors only when requested', () => {
    const specs = buildAttemptSpecs(cfg({ repeats: 1 }));
    const records = new Map<string, PilotAttemptRecord>();
    records.set(attemptKey(specs[0]!), record(specs[0]!.instance_id, specs[0]!.arm, specs[0]!.repeat));
    records.set(attemptKey(specs[1]!), record(specs[1]!.instance_id, specs[1]!.arm, specs[1]!.repeat, {
      status: 'solve-error',
      passed: null,
      costUsd: 0,
      error: 'temporary failure',
    }));

    expect(selectRunnableAttempts(specs, records, { retryErrors: false, maxNewSolves: Infinity }))
      .toEqual([specs[2], specs[3], specs[4], specs[5]]);
    expect(selectRunnableAttempts(specs, records, { retryErrors: true, maxNewSolves: 2 }))
      .toEqual([specs[1], specs[2]]);
  });

  it('builds one attempt per configured arm without duplicating the baseline', () => {
    expect(buildAttemptSpecs(cfg({ instances: [{ instance_id: 'alpha', hf_dataset: 'ds', hf_split: 'train' }], repeats: 1 })))
      .toEqual([
        { instance_id: 'alpha', arm: 'stock', repeat: 0 },
        { instance_id: 'alpha', arm: 'mini', repeat: 0 },
        { instance_id: 'alpha', arm: 'gpt55', repeat: 0 },
      ]);
  });

  it('treats maxNewSolves=0 as report-only mode', () => {
    const specs = buildAttemptSpecs(cfg({ repeats: 1 }));
    expect(selectRunnableAttempts(specs, new Map(), { retryErrors: false, maxNewSolves: 0 })).toEqual([]);
  });

  it('refuses to mix dry-run and real records in one durable store', () => {
    const dryManifest = buildPilotManifest(cfg({ mode: 'dry-run' }), { generatedAt: '2026-07-10T00:00:00.000Z' });
    expect(() => assertCompatiblePilotManifest(dryManifest, cfg({ mode: 'real' })))
      .toThrow(/different frozen pilot config for mode/i);
    expect(() => assertCompatiblePilotManifest(dryManifest, cfg({ mode: 'dry-run' }))).not.toThrow();

    const realManifest = buildPilotManifest(cfg({ mode: 'real' }), { generatedAt: '2026-07-10T00:00:00.000Z' });
    expect(() => assertCompatiblePilotManifest(realManifest, cfg({ mode: 'dry-run' })))
      .toThrow(/different frozen pilot config for mode/i);
  });

  it('treats a legacy manifest without a mode field as a real-mode store', () => {
    // Pre-mode-marker manifests were only ever meant for real runs; a dry run
    // against one must fail closed rather than pollute it with fake records.
    const legacy = buildPilotManifest(cfg(), { generatedAt: '2026-07-10T00:00:00.000Z' });
    delete (legacy.semanticConfig as { mode?: string }).mode;

    expect(() => assertCompatiblePilotManifest(legacy, cfg({ mode: 'real' }))).not.toThrow();
    expect(() => assertCompatiblePilotManifest(legacy, cfg({ mode: 'dry-run' })))
      .toThrow(/different frozen pilot config for mode/i);
  });
});
