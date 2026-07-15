import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '@jinn-network/plugin/testing';
import { unavailable, type EpisodeV1, type JinnPluginDeps } from '@jinn-network/plugin';
import { runJinnLayerCli } from '../src/cli.js';
import {
  MineableTraceStore,
  resolveMineableStateDir,
} from '../../../src/solver-types/_swe-rebench-v2-mineable-store.js';

function capture() {
  let output = '';
  return {
    writer: { write(value: string) { output += value; return true; } },
    output: () => output,
  };
}

function episode(): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: 'episode-host-1',
    session: { sessionId: 'session-host-1', capturedAt: '2026-07-15T12:00:00.000Z' },
    task: { summary: 'Fix the session bridge', distributionTags: ['oss'] },
    trajectory: [{
      spanId: 'turn-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn:user',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1000000000',
      attributes: { role: 'user', content: 'fix it' },
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'hermes', version: '0.18.0' },
      model: 'test-model',
      tools: ['terminal'],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 50 },
    retention: { policy: 'contribution-eligible' },
    provenance: 'contributed',
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    episode: episode(),
    activity: {
      surfacedRefs: ['knowledge/ref-1'],
      fetchedRefs: ['knowledge/ref-1'],
      installedSkillRefs: [],
    },
    eligibilityInputs: { acceptedDiff: true },
    contributionCandidate: {
      schemaVersion: 'jinn.contribution-candidate.v1',
      sourceId: 'episode-host-1',
      repositorySlug: 'Jinn-Network/mono',
      baseCommit: '0123456789abcdef',
      acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
      testRuns: [{ command: 'yarn test', exitCode: 0, at: '2026-07-15T12:01:00.000Z' }],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: false,
      createdAt: '2026-07-15T12:02:00.000Z',
    },
    contributionVetoed: false,
    ...overrides,
  };
}

function memoryDeps(overrides: Partial<JinnPluginDeps> = {}): JinnPluginDeps {
  return {
    corpus: new InMemoryCorpusPort([]),
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
    ...overrides,
  };
}

describe('jinn-layer process contract v1', () => {
  it('publishes the exact contract version without initializing product ports', async () => {
    const out = capture();
    expect(await runJinnLayerCli(['contract', '--json'], { writer: out.writer })).toBe(0);
    expect(JSON.parse(out.output())).toEqual({ contractVersion: 1 });
  });

  it.each([
    ['contract', ['contract', 'unexpected']],
    ['session pickup', ['session', 'pickup', '--unexpected']],
    ['session end', ['session', 'end', '--unexpected']],
  ])('rejects extra arguments on the %s interface', async (_label, argv) => {
    const out = capture();
    expect(await runJinnLayerCli(argv, {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps(),
    })).toBe(2);
    expect(out.output()).toMatch(/usage|invalid/i);
  });

  it('accepts a complete host episode without changing identity or timestamps', async () => {
    const evidence = new InMemoryEvidencePort();
    const contribution = new InMemoryContributionPort();
    const out = capture();
    const input = request();
    const code = await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(input),
      pluginOverrides: memoryDeps({ evidence, contribution }),
    });

    expect(code).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.contractVersion).toBe(1);
    expect(envelope.status).toBe('ok');
    expect(envelope.value.episodeRef).toBe('episode-host-1');
    expect(envelope.value.persistence).toEqual({ status: 'ok', value: { episodeId: 'episode-host-1' } });
    const stored = await evidence.get('episode-host-1');
    expect(stored.status).toBe('ok');
    if (stored.status === 'ok') {
      expect(stored.value?.session).toEqual(episode().session);
      expect(stored.value?.trajectory).toEqual(episode().trajectory);
      expect(stored.value?.provenance).toBe(episode().provenance);
    }
    expect((await contribution.ledger()).status).toBe('ok');
  });

  it('returns the explicit veto receipt produced by the shared session completion path', async () => {
    const out = capture();

    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request({ contributionVetoed: true })),
      pluginOverrides: memoryDeps(),
    })).toBe(0);

    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: {
        contribution: {
          status: 'ok',
          value: {
            recordId: expect.any(String),
            publicationState: 'vetoed',
            status: 'vetoed',
          },
        },
      },
    });
  });

  it('keeps the future-host session pickup verb versioned and structured', async () => {
    const out = capture();
    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-1',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
        },
        firstMessage: 'fix the retry tests',
      }),
      pluginOverrides: memoryDeps(),
    })).toBe(0);
    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: { suggestions: [], markers: [] },
    });
  });

  it('acknowledges the first sanitized contribution preview through a production command', async () => {
    const contribution = new InMemoryContributionPort();
    await contribution.recordMineable({
      ...(request().contributionCandidate as never),
      publishMinedTasksConsent: true,
    });
    const out = capture();

    expect(await runJinnLayerCli(['contribution', 'preview', '--ack', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ contribution }),
    })).toBe(0);

    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: {
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        publicationState: 'queued',
        acknowledged: true,
      },
    });
    expect(out.output()).not.toMatch(/diff --git|acceptedDiff|trajectory/);
  });

  it('disables every unpublished authorization when the sharing preference is revoked', async () => {
    const contribution = new InMemoryContributionPort();
    const recorded = await contribution.recordMineable({
      ...(request().contributionCandidate as never),
      publishMinedTasksConsent: true,
    });
    if (recorded.status !== 'ok') throw new Error('record failed');
    await contribution.authorize(recorded.value.recordId);
    const out = capture();

    expect(await runJinnLayerCli(['contribution', 'disable', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ contribution }),
    })).toBe(0);

    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: { recordIds: [recorded.value.recordId] },
    });
    expect(await contribution.mintStatus(recorded.value.recordId)).toMatchObject({
      status: 'ok',
      value: { publicationState: 'disabled' },
    });
  });

  it('reports pickup corpus unavailability without making the command fail', async () => {
    const corpus = {
      async search() { return unavailable('corpus offline'); },
      async get() { return unavailable('corpus offline'); },
    };
    const out = capture();
    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-2',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
        },
        firstMessage: 'fix the retry tests',
      }),
      pluginOverrides: memoryDeps({ corpus }),
    })).toBe(0);
    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'unavailable',
      value: { suggestions: [] },
      reason: 'corpus offline',
    });
  });

  it('reports unavailable skills and never claims a failed auto-adoption was installed', async () => {
    const hit = {
      ref: 'ipfs://retry-skill',
      kind: 'skill' as const,
      title: 'retry-skill',
      snippet: 'verified retry workflow',
      tier: 'evaluator-verified',
      payloadKind: 'skill' as const,
    };
    const skills = {
      async list() { return unavailable('skills directory unavailable'); },
      async install() { return unavailable('skills directory unavailable'); },
      async uninstall() { return unavailable('skills directory unavailable'); },
    };
    const out = capture();

    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-skills-unavailable',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
          pickup: {
            enabled: true,
            autoAdopt: true,
            autoAdoptTier: 'evaluator-verified',
            maxCandidates: 3,
          },
        },
        firstMessage: 'fix the retry tests',
      }),
      pluginOverrides: memoryDeps({ corpus: new InMemoryCorpusPort([hit]), skills }),
    })).toBe(0);

    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({
      contractVersion: 1,
      status: 'unavailable',
      reason: 'skills directory unavailable',
      value: { suggestions: [expect.objectContaining({ ref: 'ipfs://retry-skill' })] },
    });
    expect(reply.value.contextBlock).toContain('install: /jinn skills install ipfs://retry-skill');
    expect(reply.value.contextBlock).not.toMatch(/installed skill|Adopted automatically/);
  });

  it('returns degraded when contribution is unavailable but evidence persisted', async () => {
    const base = new InMemoryContributionPort();
    const contribution = {
      ...base,
      async recordMineable() { return unavailable('sidecar absent'); },
    } as JinnPluginDeps['contribution'];
    const out = capture();
    const code = await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps({ contribution }),
    });
    expect(code).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.status).toBe('degraded');
    expect(envelope.value.persistence.status).toBe('ok');
    expect(envelope.value.contribution.status).toBe('unavailable');
  });

  it('writes one canonical episode and a candidate the daemon reads from the same store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-process-contract-'));
    const episodes = join(root, 'episodes');
    const mineable = join(root, 'mineable');
    const previousEpisodes = process.env['JINN_LAYER_EPISODES_DIR'];
    const previousMineable = process.env['JINN_MINEABLE_STATE_DIR'];
    process.env['JINN_LAYER_EPISODES_DIR'] = episodes;
    process.env['JINN_MINEABLE_STATE_DIR'] = mineable;
    try {
      const out = capture();
      expect(await runJinnLayerCli(['session', 'end'], {
        writer: out.writer,
        reader: async () => JSON.stringify(request()),
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          localLearning: new InMemoryLocalLearningPort(),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);

      const persisted = JSON.parse(readFileSync(join(episodes, 'episode-host-1.episode.json'), 'utf8'));
      expect(persisted.episodeId).toBe('episode-host-1');
      expect(persisted.session).toEqual(episode().session);
      expect(persisted.trajectory).toEqual(episode().trajectory);

      expect(resolveMineableStateDir()).toBe(mineable);
      const daemonStore = new MineableTraceStore({ stateDir: resolveMineableStateDir() });
      const records = await daemonStore.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        recordId: 'episode-host-1',
        localState: 'recorded',
        publicationState: 'disabled',
        candidate: { sourceId: 'episode-host-1' },
      });
    } finally {
      if (previousEpisodes === undefined) delete process.env['JINN_LAYER_EPISODES_DIR'];
      else process.env['JINN_LAYER_EPISODES_DIR'] = previousEpisodes;
      if (previousMineable === undefined) delete process.env['JINN_MINEABLE_STATE_DIR'];
      else process.env['JINN_MINEABLE_STATE_DIR'] = previousMineable;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns unavailable with the typed persistence result when evidence did not persist', async () => {
    const evidence = {
      async put() { return unavailable('disk offline'); },
      async get() { return { status: 'ok' as const, value: null }; },
      async list() { return { status: 'ok' as const, value: [] }; },
      async retention() {
        return { status: 'ok' as const, value: { policy: 'local-private' as const, maxEpisodes: 200 } };
      },
    };
    const out = capture();
    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps({ evidence }),
    })).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.status).toBe('unavailable');
    expect(envelope.value.persistence).toEqual({ status: 'unavailable', reason: 'disk offline' });
  });

  it.each([
    ['not-json', 'not JSON'],
    ['wrong version', JSON.stringify(request({ contractVersion: 2 }))],
    ['unknown field', JSON.stringify(request({ unexpected: true }))],
  ])('treats %s as a command interface error', async (_label, input) => {
    const out = capture();
    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => input,
      pluginOverrides: memoryDeps(),
    })).toBe(2);
    expect(out.output()).toMatch(/error/i);
  });
});
