import { describe, expect, it } from 'vitest';
import { createJinnPlugin, type KnowledgeHit } from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import { unavailable, type PortResult } from '../../src/outcome.js';
import type { CorpusPort } from '../../src/ports/corpus-port.js';

function buildPlugin(corpus: CorpusPort) {
  return createJinnPlugin({
    corpus,
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

const META = {
  sessionId: 's1',
  taskSummary: 'tdd refactor',
  harness: { name: 'hermes', version: '0.1.0' },
  model: 'm',
  tools: ['bash'],
};

describe('firstTurnPickup over ports (AC1)', () => {
  it('suggests a verified candidate by default (no auto-adopt)', async () => {
    const hit: KnowledgeHit = {
      ref: 'ipfs://tdd',
      kind: 'skill',
      title: 'tdd',
      snippet: 'tdd-style refactoring skill',
      tier: 'evaluator-verified',
      payloadKind: 'skill',
    };
    const plugin = buildPlugin(new InMemoryCorpusPort([hit]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('tdd-style refactoring please');
    expect(result.suggestions).toHaveLength(1);
    expect(result.contextBlock).toContain('install: /jinn skills install');
    expect(result.contextBlock).not.toContain('Adopted automatically');
    expect(result.markers).toContain('corpus');
  });

  it('auto-adopts when config opts in and installs the skill', async () => {
    const hit: KnowledgeHit = {
      ref: 'ipfs://tdd',
      kind: 'skill',
      title: 'tdd',
      snippet: 'tdd-style refactoring skill',
      tier: 'evaluator-verified',
      payloadKind: 'skill',
    };
    const skills = new InMemorySkillsPort();
    const plugin = createJinnPlugin({
      corpus: new InMemoryCorpusPort([hit]),
      evidence: new InMemoryEvidencePort(),
      contribution: new InMemoryContributionPort(),
      localLearning: new InMemoryLocalLearningPort(),
      skills,
    });
    const session = plugin.session({ ...META, pickup: { enabled: true, autoAdopt: true, autoAdoptTier: 'evaluator-verified', maxCandidates: 3 } });
    const result = await session.firstTurnPickup('tdd-style refactoring please');
    expect(result.contextBlock).toContain('Adopted automatically (verified)');
    const installed = await skills.list();
    expect(installed.status).toBe('ok');
    expect(installed.status === 'ok' && installed.value.map((r) => r.ref)).toContain('ipfs://tdd');
  });

  it('fails open on empty terms (all stopwords / blank)', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([{ ref: 'x', kind: 'seed', title: 'y' }]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('how do you help');
    expect(result.suggestions).toEqual([]);
    expect(result.contextBlock).toBeUndefined();
    expect(result.markers).toEqual([]);
  });

  it('fails open when the corpus search is unavailable', async () => {
    const brokenCorpus: CorpusPort = {
      async search(): Promise<PortResult<KnowledgeHit[]>> {
        return unavailable('corpus down');
      },
      async get(): Promise<PortResult<KnowledgeHit | null>> {
        return unavailable('corpus down');
      },
    };
    const plugin = buildPlugin(brokenCorpus);
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('tdd-style refactoring');
    expect(result.suggestions).toEqual([]);
    expect(result.contextBlock).toBeUndefined();
  });

  it('is a no-op when config disables pickup', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([{ ref: 'ipfs://tdd', kind: 'skill', title: 'tdd', tier: 'user-accepted', payloadKind: 'skill' }]));
    const session = plugin.session({ ...META, pickup: { enabled: false, autoAdopt: false, autoAdoptTier: 'evaluator-verified', maxCandidates: 3 } });
    const result = await session.firstTurnPickup('tdd-style refactoring');
    expect(result.suggestions).toEqual([]);
    expect(result.contextBlock).toBeUndefined();
  });
});
