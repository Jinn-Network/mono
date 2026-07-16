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
    expect(source.listCalls).toBe(1);
  });

  it('performs zero writes — takes only a source, no publish deps', async () => {
    const source = mockEpisodeSource([episode()]);
    const report = await planEpisodes(source);
    expect(parseEpisodeImportReport(report)).toEqual(report);
  });

  it('flags a duplicate id as skip, first occurrence wins', async () => {
    const source = mockEpisodeSource([episode({ id: 'dup' }), episode({ id: 'dup' })]);
    const report = await planEpisodes(source);
    expect(report[0]).toMatchObject({ id: 'dup', verdict: 'import' });
    expect(report[1]).toMatchObject({ id: 'dup', verdict: 'skip' });
    expect(report[1]!.reason).toContain('duplicate id');
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

  it('a skipped plan row (duplicate id) is carried through as skipped, not published', async () => {
    const source = mockEpisodeSource([episode({ id: 'dup' }), episode({ id: 'dup' })]);
    const report = await planEpisodes(source);
    const { deps, published } = mockPublishDeps();
    const result = await executeEpisodes(report, source, deps);
    expect(published).toHaveLength(1); // only the first "dup" publishes
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('duplicate id');
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
});
