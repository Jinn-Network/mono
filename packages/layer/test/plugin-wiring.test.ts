import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '@jinn-network/plugin/testing';
import type { EpisodeV1, JinnPluginDeps } from '@jinn-network/plugin';
import {
  buildPluginDepsFromEnv,
  composeDefaultCorpus,
} from '../src/plugin-wiring.js';
import { runJinnLayerCli } from '../src/cli.js';
import { localEpisodeRef } from '../src/adapters/local-episode-corpus-adapter.js';

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
    episodeId: 'local-bridge-episode',
    retrievalVisible: false,
    session: {
      sessionId: 'local-bridge-session',
      capturedAt: '2026-07-23T12:00:00.000Z',
      kind: 'user',
    },
    origin: { writer: 'vitest', build: '0.1.0' },
    task: { summary: 'Fix the session bridge', distributionTags: ['bridge'] },
    trajectory: [{
      spanId: 'turn-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1000000000',
      attributes: {},
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'vitest', version: '0.1.0' },
      model: 'test',
      tools: [],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'tests-passed' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'imported',
  };
}

function completeOverrides(overrides: Partial<JinnPluginDeps> = {}): JinnPluginDeps {
  return {
    corpus: new InMemoryCorpusPort([]),
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
    ...overrides,
  };
}

describe('default plugin corpus wiring', () => {
  it('composes the supplied evidence and public corpus into one default corpus', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(episode());
    const publicCorpus = new InMemoryCorpusPort([{
      ref: 'public-bridge-record',
      kind: 'trace',
      task: { summary: 'Public session bridge guide' },
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
      steps: [],
      tags: ['bridge'],
      provenance: 'imported',
      origin: 'seed:public-bridge',
      capturedAt: '2026-07-23T12:00:00.000Z',
      tier: 'tests-passed',
    }]);

    const result = await composeDefaultCorpus(evidence, publicCorpus).search('bridge');

    expect(result).toMatchObject({
      status: 'ok',
      value: [
        { ref: 'local-episode:local-bridge-episode' },
        { ref: 'public-bridge-record' },
      ],
    });
  });

  it('uses an explicit corpus override unchanged', () => {
    const corpus = new InMemoryCorpusPort([]);

    const deps = buildPluginDepsFromEnv(completeOverrides({ corpus }));

    expect(deps.corpus).toBe(corpus);
  });

  it('backs the default local corpus with the explicit evidence instance', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'jinn-default-corpus-'));
    const evidence = new InMemoryEvidencePort();
    const { corpus: _corpus, ...overrides } = completeOverrides({ evidence });

    try {
      vi.resetModules();
      vi.doMock('node:os', async (importOriginal) => ({
        ...await importOriginal<typeof import('node:os')>(),
        homedir: () => root,
      }));
      const { buildPluginDepsFromEnv: buildDefaultDeps } = await import('../src/plugin-wiring.js');
      const deps = buildDefaultDeps(overrides);
      await deps.evidence.put(episode());

      await expect(deps.corpus.get(localEpisodeRef('local-bridge-episode'))).resolves.toMatchObject({
        status: 'ok',
        value: {
          canonicalEpisodeId: 'local-bridge-episode',
          origin: 'local:local-bridge-episode',
        },
      });
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit evidence override for plugin persistence', async () => {
    const evidence = new InMemoryEvidencePort();
    const out = capture();

    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        episode: episode(),
        activity: {
          retrievalFired: false,
          eligibleRefs: [],
          deliveredRefs: [],
          deliveryMode: 'withheld',
          surfacedRefs: [],
          fetchedRefs: [],
          installedSkillRefs: [],
          searchedTerms: [],
          providedRefs: [],
        },
        eligibilityInputs: { acceptedDiff: false },
      }),
      pluginOverrides: completeOverrides({ evidence }),
    })).toBe(0);

    expect(JSON.parse(out.output())).toMatchObject({
      status: 'ok',
      value: { persistence: { status: 'ok' } },
    });
    await expect(evidence.get('local-bridge-episode')).resolves.toMatchObject({
      status: 'ok',
      value: { episodeId: 'local-bridge-episode' },
    });
  });
});
