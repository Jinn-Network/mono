/**
 * Evidence-episode seed lane tests (issue #1771).
 *
 * Mirrors seed-import.test.ts's mocking style: all sources and publish deps
 * are mocked — nothing reaches the filesystem beyond a tmpdir, IPFS, or chain
 * from this suite. `seed execute --episodes-dir` against the real testnet is
 * the human-gated step (docs/runbooks/stage1-evidence-seeding.md).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import { parseTraceEnvelopeV0 } from '../src/envelope.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../src/publish.js';
import {
  createLocalEpisodeSeedSource,
  parseSeedEpisode,
  SeedEpisodeSchema,
  type SeedEpisode,
  type EpisodeSource,
} from '../src/seed-import/episode-fetch.js';
import { planEpisodes } from '../src/seed-import/episode-plan.js';
import { executeEpisodes } from '../src/seed-import/episode-execute.js';
import { parseEpisodeImportReport, type EpisodeImportReport } from '../src/seed-import/episode-report.js';
import { createMemorySeedImportState } from '../src/seed-import/state.js';
import { runJinnLayerCli } from '../src/cli.js';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

const STAGE1_FIXTURES_DIR = fileURLToPath(
  new URL('../fixtures/stage1-seeds', import.meta.url),
);

function episode(overrides: Partial<SeedEpisode> = {}): SeedEpisode {
  return {
    id: 'source-fixture',
    repo: 'acme/widgets',
    taskSummary: 'Fix a flaky widget test by awaiting the async fetch before asserting',
    tags: ['acme', 'widgets', 'flake'],
    steps: [
      { label: 'failure', title: 'run failing test', text: '$ yarn test\nFAIL widget.test.ts' },
      { label: 'note', title: 'diagnose', text: 'The assertion runs before the fetch resolves.' },
      { label: 'fix', title: 'await the fetch', text: 'await waitFor(() => expect(fetchMock).toHaveBeenCalled());' },
      { label: 'command', title: 'rerun', text: '$ yarn test\nPASS widget.test.ts' },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'The test asserted before the async fetch settled. Waiting on the fetch mock directly fixes the race. This is the general pattern for this class of flake.',
    attribution: { origin: 'operator-recorded-session' },
    ...overrides,
  };
}

function mockEpisodeSource(episodes: SeedEpisode[]): EpisodeSource & { listCalls: number } {
  const source = {
    name: 'mock-episodes',
    listCalls: 0,
    async list() {
      source.listCalls += 1;
      return episodes;
    },
  };
  return source;
}

function mockPublishDeps(): {
  deps: HarnessPublishDeps;
  published: Array<{ artifactType: string; payload: unknown }>;
  envelopes: SignedEnvelope[];
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: SignedEnvelope[] = [];
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async (input) => {
      published.push(input);
      return { cid: `bafy-artifact-${published.length}`, sha256: 'a'.repeat(64) };
    },
    publishEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return { cid: `bafy-envelope-${envelopes.length}`, sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
  return { deps, published, envelopes };
}

describe('SeedEpisodeSchema / parseSeedEpisode', () => {
  it('parses a well-formed episode', () => {
    expect(() => parseSeedEpisode(episode())).not.toThrow();
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(() => parseSeedEpisode({ ...episode(), extra: 'nope' })).toThrow();
  });

  it('rejects a baseCommit that is not a full 40-char sha', () => {
    expect(() => parseSeedEpisode({ ...episode(), baseCommit: '163e070d' })).toThrow();
  });

  it('rejects an excerpt label outside the five-value vocabulary', () => {
    const bad = episode({
      steps: [{ label: 'summary' as never, title: 't', text: 'x' }],
    });
    expect(() => parseSeedEpisode(bad)).toThrow();
  });

  it('accepts a valid full 40-char baseCommit', () => {
    const withCommit = episode({ baseCommit: '3651de92ccda900dc6d052b94035f9a86d5b21be' });
    expect(SeedEpisodeSchema.parse(withCommit).baseCommit).toBe('3651de92ccda900dc6d052b94035f9a86d5b21be');
  });
});

describe('createLocalEpisodeSeedSource', () => {
  it('reads *.episode.json files from a directory, sorted, ignoring other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-episodes-'));
    writeFileSync(join(dir, 'b.episode.json'), JSON.stringify(episode({ id: 'b' })));
    writeFileSync(join(dir, 'a.episode.json'), JSON.stringify(episode({ id: 'a' })));
    writeFileSync(join(dir, 'skill.json'), JSON.stringify({ skill: 'x', source: 'y', licence: 'MIT', skillMd: '# x' }));
    writeFileSync(join(dir, 'README.md'), '# not a seed file');

    const source = createLocalEpisodeSeedSource(dir);
    const episodes = await source.list();
    expect(episodes.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('throws on a malformed episode file (fail-loud, not silently skipped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-episodes-'));
    writeFileSync(join(dir, 'bad.episode.json'), JSON.stringify({ id: 'bad' }));
    const source = createLocalEpisodeSeedSource(dir);
    await expect(source.list()).rejects.toThrow();
  });
});

describe('planEpisodes()', () => {
  it('produces one import row per episode', async () => {
    const source = mockEpisodeSource([episode({ id: 'a' }), episode({ id: 'b' })]);
    const report = await planEpisodes(source);
    expect(report).toHaveLength(2);
    expect(report.every((r) => r.verdict === 'import')).toBe(true);
    expect(report.every((r) => /^[0-9a-f]{64}$/.test((r as Record<string, unknown>)['contentDigest'] as string))).toBe(true);
    expect(source.listCalls).toBe(1);
  });

  it('performs zero writes — takes only a source, no publish deps', async () => {
    const source = mockEpisodeSource([episode()]);
    const report = await planEpisodes(source);
    expect(parseEpisodeImportReport(report)).toEqual(report);
  });

  it('flags a different-content duplicate id as skip, first occurrence wins', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'dup', taskSummary: 'first occurrence' }),
      episode({ id: 'dup', taskSummary: 'second occurrence' }),
    ]);
    const report = await planEpisodes(source);
    expect(report[0]).toMatchObject({ id: 'dup', verdict: 'import' });
    expect(report[1]).toMatchObject({ id: 'dup', verdict: 'skip' });
    expect(report[1]!.reason).toContain('duplicate id');
    expect((report[0] as Record<string, unknown>)['contentDigest']).not.toBe(
      (report[1] as Record<string, unknown>)['contentDigest'],
    );
  });
});

describe('executeEpisodes()', () => {
  it('publishes only verdict=import rows with provenance imported + the step convention', async () => {
    const source = mockEpisodeSource([episode()]);
    const report = await planEpisodes(source);
    const { deps, published } = mockPublishDeps();
    const result = await executeEpisodes(report, source, deps);

    expect(published.map((p) => p.artifactType)).toEqual([TRACE_ENVELOPE_ARTIFACT_TYPE]);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    expect(envelope.provenance).toBe('imported');
    expect(envelope.task.summary).toBe(episode().taskSummary);
    expect(envelope.task.distributionTags).toEqual(
      expect.arrayContaining(['seed-import', 'acme', 'widgets', 'flake']),
    );

    // Content steps carry the label/title/text convention.
    expect(envelope.steps).toHaveLength(5); // 4 content steps + 1 synthesis/attribution step
    const failureStep = envelope.steps.find((s) => s.name === 'seed:step:failure')!;
    expect(failureStep.attributes['seed.step.label']).toBe('failure');
    expect(failureStep.attributes['seed.step.title']).toBe('run failing test');
    expect(String(failureStep.attributes['seed.step.text'])).toContain('FAIL widget.test.ts');
    const fixStep = envelope.steps.find((s) => s.name === 'seed:step:fix')!;
    expect(fixStep.attributes['seed.step.label']).toBe('fix');

    // Final step carries synthesis + attribution.
    const metaStep = envelope.steps[envelope.steps.length - 1]!;
    expect(metaStep.name).toBe('seed:synthesis');
    expect(metaStep.attributes['seed.synthesis']).toContain('general pattern');
    expect(metaStep.attributes['seed.attribution']).toMatchObject({
      repo: 'acme/widgets',
      origin: 'operator-recorded-session',
    });
    // Fresh publish: no supersedes marker yet.
    expect((metaStep.attributes['seed.attribution'] as Record<string, unknown>)['supersedes']).toBeUndefined();

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ id: 'source-fixture', supersedes: null });
  });

  it('ledger records every import', async () => {
    const source = mockEpisodeSource([episode()]);
    const { deps } = mockPublishDeps();
    await executeEpisodes(await planEpisodes(source), source, deps);
    const entries = deps.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('published');
  });

  it('a different-content duplicate id publishes the first occurrence, not the last', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'dup', taskSummary: 'first occurrence' }),
      episode({ id: 'dup', taskSummary: 'second occurrence' }),
    ]);
    const report = await planEpisodes(source);
    const { deps, published } = mockPublishDeps();
    const result = await executeEpisodes(report, source, deps);
    expect(published).toHaveLength(1); // only the first "dup" publishes
    expect(parseTraceEnvelopeV0(published[0]!.payload).task.summary).toBe('first occurrence');
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('duplicate id');
  });

  it('rejects an execute-time episode whose canonical content differs from the approved row', async () => {
    const approved = mockEpisodeSource([episode({ taskSummary: 'approved content' })]);
    const report = await planEpisodes(approved);
    const changed = mockEpisodeSource([episode({ taskSummary: 'changed after approval' })]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(report, changed, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'source-fixture',
        error: expect.stringMatching(/approved content digest.*does not match/i),
      }),
    ]);
  });

  it('rejects substituting the approved episode id while keeping all other content identical', async () => {
    const approved = mockEpisodeSource([episode({ id: 'approved-id' })]);
    const [approvedRow] = await planEpisodes(approved);
    const substituted = episode({ id: 'substituted-id' });
    const source = mockEpisodeSource([substituted]);
    const report: EpisodeImportReport = [
      { ...approvedRow!, id: substituted.id },
    ];
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(report, source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'substituted-id',
        error: expect.stringMatching(/approved content digest.*does not match/i),
      }),
    ]);
  });

  it.each([
    ['email address', 'Contact the reporter at jane.doe@example.com for repro steps.'],
    ['home-dir path', 'Logs were written to /Users/jdoe/project/output.log.'],
    ['AWS access-key id', 'Found a stray credential: AKIAIOSFODNN7EXAMPLE in the diff.'],
  ])('rejects %s before any publish call', async (_label, sensitiveText) => {
    const source = mockEpisodeSource([
      episode({
        steps: [{ label: 'note', title: 'sensitive fixture', text: sensitiveText }],
      }),
    ]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'source-fixture',
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });

  it.each([
    ['id/sessionId', { id: 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012' }],
    ['tag/distributionTag', { tags: ['acme', 'contact-jane.doe@example.com'] }],
  ])('rejects sensitive %s before any publish call', async (_label, overrides) => {
    const source = mockEpisodeSource([episode(overrides)]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });

  it.each([
    ['payment-card-shaped string', 'Customer card: 4111 1111 1111 1111.'],
    ['phone-shaped string', 'Call the customer at +1 (415) 555-2671.'],
    [
      'JWT-shaped string',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyJ9.c2lnbmF0dXJlU3ludGhldGljVmFsdWU',
    ],
    ['unprefixed high-entropy blob', 'Credential: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['SSN-shaped string', 'Reporter SSN on file: 123-45-6789.'],
    ['medical-record identifier', 'Medical record MRN: MED123456.'],
    ['government-identity identifier', 'Passport: A1234567.'],
    ['financial-account identifier', 'Bank account: 1234 5678.'],
  ])('accepts a %s under the seed profile (documented residual, #1409/#1784)', async (_label, residualText) => {
    // The seed profile deliberately does not run openredaction or the
    // entropy fallback (build.ts's buildSeedScrubPipeline doc comment,
    // #1409): seeds are public, transformed, human-reviewed prose, and those
    // probabilistic stages false-positive on ordinary words and hex-looking
    // ids in that content (#1784). Every structured identifier or PII class
    // detected only by openredaction is therefore residual risk — not just
    // the representative payment, contact, government identity, medical,
    // and financial cases sampled here. JWTs and unprefixed high-entropy
    // blobs are likewise residuals from the omitted entropy fallback. The
    // trace profile still catches these classes; seed curators must catch
    // them by review. This test pins that trade-off as intentional, not a
    // complete enumeration of openredaction's 570+ pattern surface.
    const source = mockEpisodeSource([
      episode({
        steps: [{ label: 'note', title: 'residual fixture', text: residualText }],
      }),
    ]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  describe('idempotency + supersedes', () => {
    it('re-running executeEpisodes() with the same state store over unchanged content publishes nothing new', async () => {
      const source = mockEpisodeSource([episode()]);
      const report = await planEpisodes(source);
      const { deps, published } = mockPublishDeps();
      const state = createMemorySeedImportState();

      const first = await executeEpisodes(report, source, deps, { state });
      expect(first.imported).toHaveLength(1);
      expect(published).toHaveLength(1);

      const second = await executeEpisodes(report, source, deps, { state });
      expect(second.imported).toHaveLength(0);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0]!.reason).toContain(first.imported[0]!.envelopeRef);
      expect(published).toHaveLength(1); // no new publish call
    });

    it('re-running executeEpisodes() over CHANGED content republishes and sets seed.attribution.supersedes', async () => {
      const source1 = mockEpisodeSource([episode({ synthesis: episode().synthesis + ' Version one.' })]);
      const { deps, published } = mockPublishDeps();
      const state = createMemorySeedImportState();

      const first = await executeEpisodes(await planEpisodes(source1), source1, deps, { state });
      const firstRef = first.imported[0]!.envelopeRef;

      const source2 = mockEpisodeSource([episode({ synthesis: episode().synthesis + ' Version two — changed.' })]);
      const second = await executeEpisodes(await planEpisodes(source2), source2, deps, { state });
      expect(second.imported).toHaveLength(1);
      expect(second.imported[0]!.envelopeRef).not.toBe(firstRef);
      expect(second.imported[0]!.supersedes).toBe(firstRef);

      const secondEnvelope = parseTraceEnvelopeV0(published[1]!.payload);
      const metaStep = secondEnvelope.steps[secondEnvelope.steps.length - 1]!;
      expect((metaStep.attributes['seed.attribution'] as Record<string, unknown>)['supersedes']).toBe(firstRef);
    });

    it('without an injected state store, each executeEpisodes() call starts fresh', async () => {
      const source = mockEpisodeSource([episode()]);
      const report = await planEpisodes(source);
      const { deps, published } = mockPublishDeps();

      const first = await executeEpisodes(report, source, deps);
      const second = await executeEpisodes(report, source, deps);
      expect(first.imported).toHaveLength(1);
      expect(second.imported).toHaveLength(1);
      expect(second.imported[0]!.envelopeRef).not.toBe(first.imported[0]!.envelopeRef);
      expect(published).toHaveLength(2);
    });
  });

  it('stops the batch after post-publication state persistence fails', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'first' }),
      episode({ id: 'second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    const state = {
      get: () => undefined,
      set: () => {
        throw new Error('synthetic state disk full');
      },
    };

    const result = await executeEpisodes(await planEpisodes(source), source, deps, { state });

    expect(published).toHaveLength(1);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      id: 'first',
      stateWarning: expect.stringMatching(/recovery required/i),
    });
    expect(result.errors).toEqual([]);
  });

  it('stops the batch after state lookup fails and never publishes later rows', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'first' }),
      episode({ id: 'second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    let getCalls = 0;
    const state = {
      get: () => {
        getCalls += 1;
        if (getCalls === 1) throw new Error('synthetic state read failure');
        return undefined;
      },
      set: () => undefined,
    };

    const result = await executeEpisodes(await planEpisodes(source), source, deps, { state });

    expect(getCalls).toBe(1);
    expect(published).toHaveLength(0);
    expect(result.imported).toEqual([]);
    expect(result.errors).toEqual([
      {
        id: 'first',
        error: 'synthetic state read failure',
      },
    ]);
  });

  it('persists the anchored ref, exposes a ledger warning, and stops after ledger append fails', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'first' }),
      episode({ id: 'second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    deps.ledger = {
      append: () => {
        throw new Error('synthetic ledger disk full');
      },
      list: () => [],
    };
    const records: Array<{ identity: string; envelopeRef: string }> = [];
    const state = {
      get: () => undefined,
      set: (identity: string, record: { envelopeRef: string }) => {
        records.push({ identity, envelopeRef: record.envelopeRef });
      },
    };

    const result = await executeEpisodes(await planEpisodes(source), source, deps, { state });

    expect(published).toHaveLength(1);
    expect(records).toEqual([
      { identity: 'episode:first', envelopeRef: expect.stringContaining('bafy-envelope') },
    ]);
    expect(result.imported).toEqual([
      expect.objectContaining({
        id: 'first',
        ledgerWarning: expect.stringMatching(/anchored.*ledger/i),
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  it('halts after an ambiguous publication error and never publishes later rows', async () => {
    const source = mockEpisodeSource([
      episode({ id: 'first' }),
      episode({ id: 'second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    let envelopeCalls = 0;
    deps.publishEnvelope = async () => {
      envelopeCalls += 1;
      throw new Error('synthetic transport timeout');
    };

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(envelopeCalls).toBe(1);
    expect(published).toHaveLength(1); // first row's trace artifact only
    expect(result.imported).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'first',
        error: expect.stringMatching(/publication outcome unknown; do not auto-retry/i),
      }),
    ]);
  });
});

describe('executeEpisodes() against the checked-in stage1-seeds fixture set (issue #1784)', () => {
  it('imports all three fixture episodes cleanly under the seed-lane scrub profile', async () => {
    const source = createLocalEpisodeSeedSource(STAGE1_FIXTURES_DIR);
    const report = await planEpisodes(source);
    expect(report.every((row) => row.verdict === 'import')).toBe(true);

    const { deps, published } = mockPublishDeps();
    const result = await executeEpisodes(report, source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported.map((r) => r.id).sort()).toEqual([
      'distractor-operator-claims',
      'distractor-sympy-printing',
      'source-dashboard-flake',
    ]);
    expect(result.skipped).toEqual([]);
    expect(published).toHaveLength(3);
  });
});

describe('jinn-layer seed CLI — episodes', () => {
  function writerSink(): { write: (s: string) => boolean; output: () => string } {
    let buf = '';
    return {
      write(s: string) {
        buf += s;
        return true;
      },
      output: () => buf,
    };
  }

  it('rejects passing both --source and --episodes-dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-episodes-'));
    const listFile = join(dir, 'skills.txt');
    writeFileSync(listFile, 'acme/skills\n');
    const source = mockEpisodeSource([episode()]);
    const sink = writerSink();

    const code = await runJinnLayerCli(
      ['seed', 'plan', '--source', listFile, '--episodes-dir', dir],
      { writer: sink, episodeSource: source },
    );

    expect(code).toBe(2);
    expect(sink.output()).toMatch(/exactly one of --source or --episodes-dir/i);
    expect(source.listCalls).toBe(0);
  });

  it('seed plan --episodes-dir renders the report and writes the report file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-episodes-'));
    const out = join(dir, 'report.json');
    const source = mockEpisodeSource([episode({ id: 'a' }), episode({ id: 'b' })]);
    const sink = writerSink();
    const code = await runJinnLayerCli(['seed', 'plan', '--out', out], {
      writer: sink,
      episodeSource: source,
    });
    expect(code).toBe(0);
    expect(sink.output()).toContain('a');
    expect(sink.output()).toContain('IMPORT');
    const report: EpisodeImportReport = parseEpisodeImportReport(
      JSON.parse(readFileSync(out, 'utf-8')),
    );
    expect(report).toHaveLength(2);
  });

  it('seed execute <report-file> --episodes-dir publishes the approved rows, idempotent across CLI invocations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-episodes-'));
    const reportFile = join(dir, 'report.json');
    const source = mockEpisodeSource([episode()]);
    const report = await planEpisodes(source);
    writeFileSync(reportFile, JSON.stringify(report));
    const { deps, published } = mockPublishDeps();
    const state = createMemorySeedImportState();
    const sink = writerSink();

    const code1 = await runJinnLayerCli(['seed', 'execute', reportFile, '--episodes-dir', dir], {
      writer: sink,
      episodeSource: source,
      publishDeps: deps,
      seedImportState: state,
    });
    expect(code1).toBe(0);
    expect(sink.output()).toContain('1 imported');
    expect(published).toHaveLength(1);

    const sink2 = writerSink();
    const code2 = await runJinnLayerCli(['seed', 'execute', reportFile, '--episodes-dir', dir], {
      writer: sink2,
      episodeSource: source,
      publishDeps: deps,
      seedImportState: state,
    });
    expect(code2).toBe(0);
    expect(sink2.output()).toContain('0 imported, 1 skipped');
    expect(published).toHaveLength(1); // still just the first run's publish
  });

  it('returns the published episode ref with a recovery warning and nonzero exit when state persistence fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-episodes-'));
    const reportFile = join(dir, 'report.json');
    const source = mockEpisodeSource([episode()]);
    writeFileSync(reportFile, JSON.stringify(await planEpisodes(source)));
    const { deps, published } = mockPublishDeps();
    const sink = writerSink();

    const code = await runJinnLayerCli(
      ['seed', 'execute', reportFile, '--episodes-dir', dir, '--json'],
      {
        writer: sink,
        episodeSource: source,
        publishDeps: deps,
        seedImportState: {
          get: () => undefined,
          set: () => {
            throw new Error('synthetic disk full');
          },
        },
      },
    );

    expect(code).toBe(1);
    expect(published).toHaveLength(1);
    const payload = JSON.parse(sink.output()) as {
      imported: Array<{ envelopeRef: string; stateWarning?: string }>;
      errors: unknown[];
    };
    expect(payload.errors).toEqual([]);
    expect(payload.imported).toEqual([
      expect.objectContaining({
        envelopeRef: expect.stringContaining('bafy-envelope'),
        stateWarning: expect.stringMatching(/published.*state.*recovery/i),
      }),
    ]);
  });
});
