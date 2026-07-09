import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { HarnessLayer, CorpusSearchHit, CorpusRecord } from '../src/consume.js';
import { runJinnLayerCli, type DistillCliDeps, type DistilCliDeps } from '../src/cli.js';
import type { CapturedTask } from '../src/capture.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import type { AttemptRef, BridgeEvidence } from '../src/bridge.js';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from '../src/distill.js';
import type { MetaCluster } from '../src/cluster.js';
import { parseSkillMarkdown } from '../src/skill-package.js';

async function withEnv(updates: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeHit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    title: 'prediction.v1 / solution',
    ref: 'bafyPred',
    solverType: 'prediction.v1',
    role: 'solution',
    artifactTypes: ['output.prediction.v1'],
    evidenceTier: 'self-signed',
    generatedAt: 1745978400,
    publishedAt: 1745978400,
    operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
    task: { cid: 'bafyTask', requestId: '0x' + 'b'.repeat(64) },
    ...overrides,
  };
}

function fakeLayer(opts: { hits?: CorpusSearchHit[]; record?: CorpusRecord }): HarnessLayer {
  return {
    config: {
      discoveryUrl: 'https://indexer.test',
      ipfsGatewayUrl: 'https://gateway.test',
      dbPath: ':memory:',
    },
    corpus: {
      search: vi.fn().mockResolvedValue(opts.hits ?? []),
      get: vi.fn().mockResolvedValue(opts.record),
    },
  };
}

function capture(): { writer: { write: (s: string) => boolean }; out: () => string } {
  let buf = '';
  return {
    writer: { write: (s: string) => { buf += s; return true; } },
    out: () => buf,
  };
}

describe('jinn-layer CLI', () => {
  it('corpus search prints titles, refs, and provenance fields', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({ hits: [fakeHit()] });
    const code = await runJinnLayerCli(['corpus', 'search', 'prediction'], { layer, writer });
    expect(code).toBe(0);
    expect(layer.corpus.search).toHaveBeenCalledWith('prediction', { limit: 20 });
    const text = out();
    expect(text).toContain('prediction.v1 / solution');
    expect(text).toContain('bafyPred');
    expect(text).toContain('self-signed');
    expect(text).toContain('agentId=7');
    expect(text).toContain('bafyTask');
    // generatedAt is unix seconds here — rendered as an ISO date.
    expect(text).toContain('2025-04-30T02:00:00.000Z');
    // publishedAt is backing-dependent (block number on the HTTP indexer) —
    // rendered raw, never as a date.
    expect(text).toContain('published      1745978400');
  });

  it('renders millisecond generatedAt values as sane ISO dates', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({ hits: [fakeHit({ generatedAt: 1745978400000 })] });
    await runJinnLayerCli(['corpus', 'search', 'prediction'], { layer, writer });
    expect(out()).toContain('2025-04-30T02:00:00.000Z');
    expect(out()).not.toContain('+05');
  });

  it('corpus get prints the record and artifact summary', async () => {
    const { writer, out } = capture();
    const content = Buffer.from('artifact body', 'utf-8');
    const record: CorpusRecord = {
      ref: 'bafyPred',
      envelope: { solverType: 'prediction.v1', role: 'solution' } as CorpusRecord['envelope'],
      provenance: {
        operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
        evidenceTier: 'self-signed',
        publishedAt: 1745978400,
      },
      artifacts: [{
        sha256: 'c'.repeat(64),
        artifactType: 'output.prediction.v1',
        content,
        source: 'origin',
        sizeBytes: content.length,
      }],
    };
    const layer = fakeLayer({ record });
    const code = await runJinnLayerCli(['corpus', 'get', 'bafyPred'], { layer, writer });
    expect(code).toBe(0);
    expect(layer.corpus.get).toHaveBeenCalledWith('bafyPred');
    const text = out();
    expect(text).toContain('bafyPred');
    expect(text).toContain('output.prediction.v1');
    expect(text).toContain('artifact body');
  });

  it('unknown verbs exit non-zero with usage', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({});
    const code = await runJinnLayerCli(['bogus'], { layer, writer });
    expect(code).not.toBe(0);
    expect(out()).toContain('Usage');
  });
});

describe('jinn-layer capture preview', () => {
  const fixturePath = fileURLToPath(
    new URL('./fixtures/seeded-secrets-task.json', import.meta.url),
  );

  it('renders the redaction diff and the envelope as it would publish', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview', fixturePath], { writer });
    expect(code).toBe(0);
    const text = out();
    // The before → after diff is local display; the seeded secrets appear
    // there (that IS the audit surface) with their scrubbed replacements.
    expect(text).toContain('never leaves this machine');
    expect(text).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('jane.doe@example-corp.com');
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('/users/anon');
    // The envelope section — what would actually publish — carries none of them.
    const marker = 'envelope as it would publish';
    expect(text).toContain(marker);
    const envelopeSection = text.slice(text.indexOf(marker));
    expect(envelopeSection).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(envelopeSection).not.toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(envelopeSection).not.toContain('jane.doe@example-corp.com');
    expect(envelopeSection).not.toContain('janedoe');
  });

  it('--json emits the report with before values stripped (persistence-safe)', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview', fixturePath, '--json'], { writer });
    expect(code).toBe(0);
    const report = JSON.parse(out());
    expect(report.envelope.schemaVersion).toBe('jinn.trace-envelope.v0');
    expect(report.redactions.length).toBeGreaterThan(0);
    for (const r of report.redactions) {
      expect(r).not.toHaveProperty('before');
    }
    // No seeded secret anywhere in the serialisable output.
    expect(out()).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out()).not.toContain('jane.doe@example-corp.com');
  });

  it('capture preview without a task file exits 2 with usage', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview'], { writer });
    expect(code).toBe(2);
    expect(out()).toContain('Usage');
  });
});

function skillRecord(payloadOverrides: Record<string, unknown> = {}): CorpusRecord {
  const companion = Buffer.from('# examples\n', 'utf-8');
  const payload = {
    schemaVersion: 'jinn.skill.v1',
    skill: { name: 'write-tests', skillMd: '# write-tests\n\nAlways write a failing test first.' },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: companion.toString('base64'),
        sha256: createHash('sha256').update(companion).digest('hex'),
      },
    ],
    ...payloadOverrides,
    provenance: {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: '0x' + 'a'.repeat(40) },
      seed: { skill: 'acme/skills/write-tests', source: 'https://github.com/acme/skills', licence: 'MIT' },
    },
  };
  const content = Buffer.from(JSON.stringify(payload), 'utf-8');
  return {
    ref: 'bafySkill',
    envelope: {
      solverType: 'capture.v0',
      role: 'capture',
      participant: { safeAddress: '0x' + 'a'.repeat(40), agentEoa: '0x' + 'b'.repeat(40) },
      artifacts: [],
    } as unknown as CorpusRecord['envelope'],
    provenance: {
      operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
      evidenceTier: 'self-signed',
      publishedAt: 1745978400,
    },
    artifacts: [
      {
        sha256: 'c'.repeat(64),
        artifactType: 'jinn.skill.v1',
        content,
        source: 'origin',
        sizeBytes: content.length,
      },
    ],
  };
}

describe('jinn-layer skills install', () => {
  it('installs SKILL.md and companion files from a jinn.skill.v1 record', async () => {
    const { writer, out } = capture();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-skills-'));
    const layer = fakeLayer({ record: skillRecord() });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', dir],
      { layer, writer },
    );
    expect(code).toBe(0);
    expect(layer.corpus.get).toHaveBeenCalledWith('bafySkill');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('failing test first');
    expect(readFileSync(join(dir, 'reference', 'EXAMPLES.md'), 'utf-8')).toBe('# examples\n');
    const text = out();
    expect(text).toContain(dir);
    expect(text).toContain('imported');
    expect(text).toContain('https://github.com/acme/skills');
  });

  it('exits 1 with a clear message when the record carries no skill', async () => {
    const { writer, out } = capture();
    const record = skillRecord();
    record.artifacts = []; // neither shape present
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('no skill');
  });

  it('requires a <ref> argument', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['skills', 'install'], { layer: fakeLayer({}), writer });
    expect(code).toBe(2);
    expect(out()).toContain('skills install requires a <ref>');
  });

  it('defaults the install directory to a safe slug of the skill name', async () => {
    const { writer, out } = capture();
    const base = mkdtempSync(join(tmpdir(), 'jinn-skills-'));
    const cwd = join(base, 'a', 'b');
    mkdirSync(cwd, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      // Publisher-controlled name shaped as a traversal — the default dir
      // must be a slug inside cwd, never the literal path.
      const record = skillRecord({
        skill: { name: '../../.config/pwn', skillMd: '# pwn\n' },
        files: [],
      });
      const code = await runJinnLayerCli(
        ['skills', 'install', 'bafySkill'],
        { layer: fakeLayer({ record }), writer },
      );
      expect(code).toBe(0);
      expect(readFileSync(join(cwd, 'config-pwn', 'SKILL.md'), 'utf-8')).toBe('# pwn\n');
      expect(existsSync(join(base, '.config'))).toBe(false);
      expect(out()).toContain(join(cwd, 'config-pwn'));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('verifies all companion digests before writing anything', async () => {
    const { writer, out } = capture();
    const dir = join(mkdtempSync(join(tmpdir(), 'jinn-skills-')), 'skill');
    const good = Buffer.from('good\n', 'utf-8');
    const record = skillRecord({
      files: [
        {
          path: 'a.md',
          contentBase64: good.toString('base64'),
          sha256: createHash('sha256').update(good).digest('hex'),
        },
        {
          path: 'b.md',
          contentBase64: Buffer.from('tampered\n', 'utf-8').toString('base64'),
          sha256: 'd'.repeat(64),
        },
      ],
    });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', dir],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('sha256 mismatch');
    // All-or-nothing: the aborted install leaves no partial tree on disk.
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a corrupt jinn.skill.v1 artifact cleanly instead of throwing', async () => {
    const { writer, out } = capture();
    const record = skillRecord();
    record.artifacts[0]!.content = Buffer.from('not json', 'utf-8');
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('error: record bafySkill carries a malformed jinn.skill.v1 artifact');
  });

  it('reports a schema-invalid jinn.skill.v1 artifact cleanly instead of throwing', async () => {
    const { writer, out } = capture();
    const record = skillRecord({
      files: [
        {
          path: '../escape.md',
          contentBase64: Buffer.from('x', 'utf-8').toString('base64'),
          sha256: createHash('sha256').update('x').digest('hex'),
        },
      ],
    });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('malformed jinn.skill.v1');
  });
});

describe('jinn-layer distill run', () => {
  type RecordedProvider = 'claude' | 'codex';

  function dref(instanceId: string, polarity: 'pass' | 'fail'): AttemptRef {
    return {
      requestId: `0x${instanceId}`,
      chainId: 84532,
      instanceId,
      model: '',
      manifestCid: '',
      polarity,
      verdictManifestCid: `bafyVerdict-${instanceId}`,
    };
  }

  function fakePublishDeps(): HarnessPublishDeps {
    let n = 0;
    return {
      participant: { safeAddress: `0x${'1'.repeat(40)}`, agentEoa: `0x${'2'.repeat(40)}` },
      signer: { address: `0x${'2'.repeat(40)}`, privateKey: `0x${'a'.repeat(64)}` },
      clientGitSha: 'sha',
      defaultArtifactEndpoint: 'http://127.0.0.1:7331',
      ledger: createMemoryLedger(),
      publishArtifact: async () => ({ cid: `bafyArt${++n}`, sha256: 'a'.repeat(64) }),
      publishEnvelope: async () => ({ cid: `bafyEnv${++n}`, sha256: 'b'.repeat(64) }),
      anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
    };
  }

  function stubDeps(over: Partial<DistillCliDeps> = {}): DistillCliDeps {
    return {
      verdictSource: {
        list: async () => [
          dref('flask__flask-1', 'pass'),
          dref('pytest__pytest-2', 'fail'),
          dref('django__django-99999', 'pass'), // held-out → excluded
        ],
      },
      fetchEvidence: async (r: AttemptRef): Promise<BridgeEvidence> => ({
        taskSummary: `fix the bug in ${r.instanceId}`,
        patch: `diff --git a/x.py b/x.py\n+ return qs.distinct()  # for ${r.instanceId}\n`,
      }),
      distill: async (c: DistillCluster): Promise<DistillLLMOutput> => ({
        name: `orm-${c.tier}-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
        description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
        body: [
          '## When to use',
          'A queryset returns duplicate rows after a join or prefetch.',
          '## Strategy',
          'Collapse the duplicates at the ORM layer, near the join that produced them.',
          '## Steps',
          '1. Identify the fan-out join. 2. Apply .distinct() after it.',
          '## Pitfalls',
          'An order_by on a joined column can re-expand the collapsed rows.',
          '## Verify',
          'Assert the row count equals the expected unique count.',
        ].join('\n\n'),
      }),
      publishDeps: fakePublishDeps(),
      slateInstanceIds: new Set(['django__django-99999']),
      ...over,
    };
  }

  const META_OUT = {
    name: 'cross-instance-orm-dedup',
    description: 'Use when a class of ORM queries fans out rows. Not for: single-table reads.',
    body: [
      '## When to use', 'A class of queries returns duplicate rows after a join.',
      '## Strategy', 'Collapse duplicates at the ORM layer across the shared pattern.',
      '## Steps', '1. Spot the fan-out. 2. Dedup at the join.',
      '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
      '## Verify', 'Assert the row count equals the expected unique count.',
    ].join('\n\n'),
    supports: ['s1', 's2'],
  };

  function stubMetaDeps(): Partial<DistillCliDeps> {
    return {
      verdictSource: {
        list: async () => [
          dref('flask__flask-1', 'pass'),
          dref('requests__requests-3', 'pass'),
        ],
      },
      metaDistill: async (_c: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
    };
  }

  function recordingDistillerFactory(calls: Array<{ provider: RecordedProvider; model: string }>) {
    return (provider: RecordedProvider, model: string) => {
      calls.push({ provider, model });
      return {
        distill: async (c: DistillCluster): Promise<DistillLLMOutput> => ({
          name: `factory-${provider}-${c.tier}-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
          description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
          body: [
            '## When to use',
            'A queryset returns duplicate rows after a join or prefetch.',
            '## Strategy',
            'Collapse the duplicates at the ORM layer, near the join that produced them.',
            '## Steps',
            '1. Identify the fan-out join. 2. Apply .distinct() after it.',
            '## Pitfalls',
            'An order_by on a joined column can re-expand the collapsed rows.',
            '## Verify',
            'Assert the row count equals the expected unique count.',
          ].join('\n\n'),
        }),
        metaDistill: async (_c: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
      };
    };
  }

  it('runs the pipeline under stubs and writes SKILL.md packages', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
      writer,
      distillDeps: stubDeps(),
    });
    expect(code).toBe(0);

    const text = out();
    expect(text).toContain('distilled: published 2');
    expect(text).toContain('PUBLISHED strategic-pattern');
    expect(text).toContain('PUBLISHED failure-lesson');
    expect(text).toContain(outDir);

    // One directory per published skill, each with a conformant SKILL.md.
    const dirs = readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(2);
    for (const d of dirs) {
      const md = readFileSync(join(outDir, d.name, 'SKILL.md'), 'utf-8');
      const pkg = parseSkillMarkdown(md);
      expect(pkg.name).toBe(d.name);
      expect(['strategic-pattern', 'failure-lesson']).toContain(pkg.jinn.skillKind);
      expect(pkg.jinn.distribution).toBe('coding');
      // The held-out instance never surfaces in a distilled body.
      expect(md).not.toContain('django__django-99999');
    }
  });

  it('--json emits the pipeline result with the out dir', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--out', outDir, '--json'], {
      writer,
      distillDeps: stubDeps(),
    });
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.outDir).toBe(outDir);
    expect(result.distilled.published).toHaveLength(2);
    expect(result.clusterCount).toBe(2);
    // The held-out instance is excluded at the bridge.
    expect(result.bridge.excludedHeldOut.length).toBeGreaterThan(0);
  });

  it('AC4: --meta runs stage-2 and shows a cross-instance skill with evidenceTokens > skillTokens', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir, '--json'], {
      writer,
      distillDeps: stubDeps(stubMetaDeps()),
    });
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.metaDistilled.published).toHaveLength(1);
    const meta = result.metaDistilled.published[0];
    expect(meta.skillKind).toBe('cross-instance');
    expect(meta.pkg.jinn.evidenceTokens).toBeGreaterThan(meta.pkg.jinn.skillTokens);
  });

  it('--meta prints the meta section in human output', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir], {
      writer,
      distillDeps: stubDeps(stubMetaDeps()),
    });
    const text = out();
    expect(text).toContain('meta-distilled: published 1');
    expect(text).toMatch(/META cross-instance .*evidenceTokens=\d+ skillTokens=\d+/);
  });

  it('without --meta, no meta section is printed (stage-1 unchanged)', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--out', outDir], { writer, distillDeps: stubDeps() });
    expect(out()).not.toContain('meta-distilled');
  });

  it('--distiller codex selects Codex ports with the Codex default model', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--distiller', 'codex', '--out', outDir], {
        writer,
        distillDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls).toEqual([{ provider: 'codex', model: 'gpt-5.5' }]);
    });
  });

  it('JINN_DISTILL_PROVIDER=codex selects Codex when no --distiller flag is passed', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'codex', JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
        writer,
        distillDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    });
  });

  it('--distiller overrides JINN_DISTILL_PROVIDER', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'claude', JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--distiller', 'codex', '--out', outDir], {
        writer,
        distillDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]!.provider).toBe('codex');
    });
  });

  it('JINN_DISTILL_MODEL overrides the selected provider default', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'codex', JINN_DISTILL_MODEL: 'gpt-5.4-mini' }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
        writer,
        distillDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]).toEqual({ provider: 'codex', model: 'gpt-5.4-mini' });
    });
  });

  it('--local-only bypasses live publish deps and still writes local skill output', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--local-only', '--out', outDir, '--json'], {
      writer,
      distillDeps: stubDeps({ publishDeps: undefined }),
    });

    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.bridge.bridged).toHaveLength(2);
    expect(result.bridge.bridged.every((b: { envelopeRef: string; anchorTx: string | null }) => b.envelopeRef.startsWith('local:envelope:'))).toBe(true);
    expect(result.bridge.bridged.every((b: { anchorTx: string | null }) => b.anchorTx === null)).toBe(true);
    expect(result.outDir).toBe(outDir);
    expect(readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory())).toHaveLength(2);
  });

  it('--local-only overrides injected publish deps', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--local-only', '--out', outDir, '--json'], {
      writer,
      distillDeps: stubDeps(),
    });

    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.bridge.bridged.every((b: { envelopeRef: string }) => b.envelopeRef.startsWith('local:envelope:'))).toBe(true);
    expect(result.bridge.bridged.every((b: { anchorTx: string | null }) => b.anchorTx === null)).toBe(true);
  });
});

describe('jinn-layer distil (own captures, rung 1)', () => {
  const VALID_DISTILL: DistillLLMOutput = {
    name: 'orm-fanout-dedup',
    description: 'Use when a join fans out duplicate rows. Not for: single-table reads.',
    body: [
      '## When to use', 'A queryset returns duplicate rows after a join or prefetch.',
      '## Strategy', 'Collapse the duplicates at the ORM layer, near the join that produced them.',
      '## Steps', '1. Identify the fan-out join. 2. Apply .distinct() after it.',
      '## Pitfalls', 'An order_by on a joined column can re-expand the collapsed rows.',
      '## Verify', 'Assert the row count equals the expected unique count.',
    ].join('\n\n'),
  };

  /** An evaluator-verified own capture that runs on a CHEAP runtime model. */
  function ownCapture(over: Partial<CapturedTask> = {}): CapturedTask {
    return {
      session: { sessionId: 'own-orm-dedup', capturedAt: '2026-07-09T08:00:00.000Z' },
      task: { summary: 'fix duplicate rows after a join in the report query', distributionTags: ['coding'] },
      // Runtime model is the CHEAP knob — the distiller model is separate.
      environment: { harness: { name: 'claude-code', version: '1.0.0' }, model: 'claude-haiku-4-5', tools: [] },
      steps: [
        {
          spanId: 'patch',
          parentSpanId: null,
          name: 'tool:apply_patch',
          startTimeUnixNano: '1720000000000000000',
          endTimeUnixNano: '1720000000000000000',
          attributes: { patch: 'diff --git a/report.py b/report.py\n+ return qs.distinct()  # dedup after join\n' },
          redactedKeys: [],
        },
      ],
      outcome: { status: 'completed', verifiabilityTier: 'evaluator-verified' },
      cost: { durationMs: 1000 },
      provenance: 'contributed',
      ...over,
    };
  }

  /** Write CapturedTask files into a fresh captures dir; returns the dir. */
  function capturesDirWith(...tasks: CapturedTask[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-captures-'));
    for (const t of tasks) writeFileSync(join(dir, `${t.session.sessionId}.json`), JSON.stringify(t));
    return dir;
  }

  function stubDistilDeps(over: Partial<DistilCliDeps> = {}): DistilCliDeps {
    return { distill: async () => VALID_DISTILL, ...over };
  }

  it('AC: distils a fixture capture and installs a parseable SKILL.md on disk', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(ownCapture());
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));

    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDir, '--out', outDir],
      { writer, distilDeps: stubDistilDeps() },
    );

    expect(code).toBe(0);
    // The skill is installed to disk under <out>/<name>/SKILL.md — the same
    // shape `skills install` writes, via the shared createLocalSkillSink.
    const md = readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8');
    const pkg = parseSkillMarkdown(md);
    expect(pkg.name).toBe('orm-fanout-dedup');
    expect(pkg.jinn.skillKind).toBe('strategic-pattern');
    expect(out()).toContain('INSTALLED strategic-pattern');
  });

  it('AC: install-all — every produced skill lands in the install dir', async () => {
    const { writer, out } = capture();
    // Two distinct own sessions → two clusters → two installed skills.
    const capturesDir = capturesDirWith(
      ownCapture(),
      ownCapture({
        session: { sessionId: 'own-nplusone', capturedAt: '2026-07-09T08:30:00.000Z' },
      }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
    // Give each cluster a distinct skill name so both install side by side.
    let n = 0;
    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDir, '--out', outDir, '--json'],
      { writer, distilDeps: stubDistilDeps({ distill: async () => ({ ...VALID_DISTILL, name: `skill-${++n}` }) }) },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.distilled.published).toHaveLength(2);
    const dirs = readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(2);
  });

  it('AC: the distiller model is honored and recorded distinct from the runtime model', async () => {
    const { writer } = capture();
    const capturesDir = capturesDirWith(ownCapture()); // runtime model: claude-haiku-4-5
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
    const calls: Array<{ provider: string; model: string }> = [];

    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDir, '--out', outDir, '--distiller-model', 'claude-opus-4-8'],
      {
        writer,
        distilDeps: {
          // No distill port → the provider factory resolves it from the model,
          // proving the chosen distiller model reaches the factory.
          distillerFactory: (provider, model) => {
            calls.push({ provider, model });
            return { distill: async () => VALID_DISTILL, metaDistill: async () => { throw new Error('unused'); } };
          },
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([{ provider: 'claude', model: 'claude-opus-4-8' }]);
    // Provenance records the DISTILLER model, not the capture's runtime model.
    const pkg = parseSkillMarkdown(readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8'));
    expect(pkg.jinn.distillModel).toBe('claude-opus-4-8');
    expect(pkg.jinn.distillModel).not.toBe('claude-haiku-4-5');
  });

  it('selects the most recent captures under --limit', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(
      ownCapture({ session: { sessionId: 'old', capturedAt: '2026-07-01T00:00:00.000Z' } }),
      ownCapture({ session: { sessionId: 'recent', capturedAt: '2026-07-09T00:00:00.000Z' } }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
    const seen: string[] = [];
    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDir, '--out', outDir, '--limit', '1', '--json'],
      {
        writer,
        distilDeps: {
          distill: async (c: DistillCluster) => {
            seen.push(...c.instanceIds);
            return VALID_DISTILL;
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).capturesConsidered).toBe(1);
    // Only the recent session's capture reached the distiller.
    expect(seen).toEqual(['recent']);
  });

  it('reads captures from JINN_LAYER_CAPTURES_DIR when no --captures flag is passed', async () => {
    await withEnv({ JINN_LAYER_CAPTURES_DIR: capturesDirWith(ownCapture()) }, async () => {
      const { writer, out } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
      const code = await runJinnLayerCli(['distil', '--out', outDir], { writer, distilDeps: stubDistilDeps() });
      expect(code).toBe(0);
      expect(out()).toContain('INSTALLED');
    });
  });

  it('exits 0 with a clear message when there are no local captures', async () => {
    const { writer, out } = capture();
    const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
    const code = await runJinnLayerCli(
      ['distil', '--captures', emptyDir, '--out', outDir],
      { writer, distilDeps: stubDistilDeps() },
    );
    expect(code).toBe(0);
    expect(out()).toContain('No local captures');
  });

  it('skips a malformed capture file without corrupting --json stdout', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(ownCapture());
    writeFileSync(join(capturesDir, 'broken.json'), '{ not valid json');
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distil-out-'));
    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDir, '--out', outDir, '--json'],
      { writer, distilDeps: stubDistilDeps() },
    );
    expect(code).toBe(0);
    // The malformed-file warning goes to stderr, so stdout is still one JSON line.
    const result = JSON.parse(out());
    expect(result.capturesConsidered).toBe(1);
    expect(result.distilled.published).toHaveLength(1);
  });

  it('emits parseable JSON (not a plain message) when there are no captures under --json', async () => {
    const { writer, out } = capture();
    const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const code = await runJinnLayerCli(
      ['distil', '--captures', emptyDir, '--json'],
      { writer, distilDeps: stubDistilDeps() },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).capturesConsidered).toBe(0);
  });

  it('rejects an unknown --distiller value', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distil', '--captures', capturesDirWith(ownCapture()), '--distiller', 'gpt'],
      { writer, distilDeps: stubDistilDeps() },
    );
    expect(code).toBe(2);
    expect(out()).toContain('distiller must be "claude" or "codex"');
  });
});
